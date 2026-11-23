import { sql } from "../data/lakebase";
import { converse } from "../assistant/endpoint";
import { applyAssistantEdits } from "../platform/editing";
import { reportForScheduledRun } from "../platform/reports";
import { isPageControl } from "../visuals/catalog";
import { getSource } from "../semantic/registry";
import { assistantActor } from "../upkeep/actor";
import { askAsApplication, ModelUnavailable } from "../upkeep/model";
import { dropUnfinished, maxGuideLength } from "./markdown";
import { renameField } from "./mentions";
import { distinctReasons, markGuidePending, type GuideReason } from "./pending";
import { definitionsFor, type GuideReport } from "./store";

// The assistant's part in a report's guide: writing a first one from what the
// report holds, and keeping the text right as the report and its data change.
//
// It is told the report's pages, charts, notes and field definitions, never any
// data, so a guide explains what the report is for and how to read it rather
// than what today's numbers say. What it writes goes straight onto the report
// as a version of its own, with a label saying what it did and why, like any
// other edit the assistant makes.
//
// Most of the work follows events, gathered per report in lib/guide/pending: a
// report being shared or built, a chart added or removed, a field placed on it
// or redefined, an update about its data. A renamed field is the exception,
// changed in the text straight away since it needs no model. Once an hour the
// shared reports still without a guide are drafted as well, for any an event
// never reached.

export interface DraftableReport extends GuideReport {
	title: string;
	description: string | null;
}

// Room for a full first guide, and for a rewrite, which returns the whole guide
// rather than only the passages it changed.
const draftTokens = 8000;
const reviseTokens = 12000;

const writingRules = [
	"Write plain English for business readers who do not know the data model.",
	"American spelling. No em dashes or en dashes, no semicolons, and never join two clauses with a colon.",
	"Never state a figure, a total, a trend or a date, since you are given no data.",
	"Never invent a business rule, a threshold or a cause. Say only what the definitions, titles, notes and updates support.",
	"Name fields exactly as they are given so readers can match them to the report.",
].join(" ");

const draftSystem = `You write the guide for a report in a business intelligence app. The guide is what a new reader opens to understand the report. ${writingRules} Answer with only Markdown, no preamble. Use these sections, as level two headings, leaving out any you have nothing true to say for: "What this report is for", "Which figure to quote", "How to read it", "Terms", "Things to know". Under "How to read it" walk through the charts in the order a reader meets them, a short paragraph or bullet each. Under "Terms" give a bullet for only the ten to fifteen measures and dimensions a reader most needs, each with its meaning in a sentence. The report lists every field elsewhere, so do not try to cover them all. Under "Things to know" gather caveats from the chart notes and field definitions, such as partial periods, things left out, or figures that do not add up across rows. Keep it under 900 words.`;

const followSystem = `You keep a report's guide accurate as the report and its data change. ${writingRules} You are given the guide in Markdown, a list of what changed, and the report as it is now. Change only what the changes make wrong or incomplete. Where a change adds a chart or a field a reader needs, add a short line for it in the matching section. Where a chart or field was removed, take out what describes it. Where an update changes what a figure covers, say so where the guide explains that figure. Keep every other line exactly as it is, including headings, links and formatting. Answer with only the full guide in Markdown, no preamble. If nothing needs to change, answer with the guide unchanged.`;

// What a model is told about a report: its pages, charts, notes and the
// meaning of each field it uses, with nothing from the data itself.
function outline(report: DraftableReport) {
	const pages = report.pages.map((page) => ({
		page: page.title,
		charts: page.visuals
			.filter((visual) => !isPageControl(visual.visualType))
			.map((visual) => ({
				title: visual.title,
				type: visual.visualType,
				measures: visual.config.measures,
				dimensions: visual.config.dimensions,
				note:
					typeof visual.config.options?.note === "string"
						? visual.config.options.note
						: undefined,
			})),
	}));
	const sourceKeys = new Set<string>();
	if (report.sourceKey) sourceKeys.add(report.sourceKey);
	for (const page of report.pages) {
		if (page.sourceKey) sourceKeys.add(page.sourceKey);
		for (const visual of page.visuals)
			if (visual.sourceKey) sourceKeys.add(visual.sourceKey);
	}
	return {
		report: report.title,
		description: report.description,
		datasets: [...sourceKeys].flatMap((key) => {
			const source = getSource(key);
			return source
				? [{ title: source.title, description: source.description }]
				: [];
		}),
		pages,
		fields: definitionsFor(report).map((field) => ({
			name: field.label,
			kind: field.kind,
			meaning: field.description,
		})),
	};
}

// Charts a reader would be walked through, leaving out filters and headers.
function chartCount(report: GuideReport): number {
	return report.pages
		.flatMap((page) => page.visuals)
		.filter((visual) => !isPageControl(visual.visualType)).length;
}

// The model's Markdown, without a fence it may have wrapped it in.
function cleanMarkdown(text: string): string {
	const trimmed = text.trim();
	const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
	return (fenced ? fenced[1] : trimmed).slice(0, maxGuideLength).trim();
}

// A first guide, asked as the person who pressed for it.
export async function draftGuide(
	userToken: string | null,
	report: DraftableReport,
): Promise<string> {
	const turn = await converse(
		userToken,
		[
			{ role: "system", content: draftSystem },
			{ role: "user", content: JSON.stringify(outline(report)) },
		],
		[],
		{},
		draftTokens,
	);
	// A reply that ran out of room ends partway through a line, which is left off.
	const text = dropUnfinished(cleanMarkdown(turn.content ?? "")).text;
	if (!text) throw new Error("The assistant did not write a guide.");
	return text;
}

// A first guide, asked as the application for upkeep. Null when the model
// wrote nothing usable.
async function draftAsApplication(
	report: DraftableReport,
): Promise<string | null> {
	const text = dropUnfinished(
		cleanMarkdown(
			await askAsApplication(draftSystem, outline(report), draftTokens),
		),
	).text;
	return text || null;
}

type SaveOutcome = "saved" | "changedMeanwhile" | "failed";

// Writes a guide onto a report as the assistant, as a version of its own.
//
// Only over the text it started from, null for a report that had none. A model
// call takes seconds, and somebody may save their own edit in that time. Their
// edit is kept and the assistant's is dropped, rather than writing the older
// text back over theirs. The version is read with the text, so a save landing
// after this check fails the edit's own version check instead.
async function saveAsAssistant(
	reportId: string,
	startedFrom: string | null,
	guide: string,
	label: string,
	updateId: string | null,
): Promise<SaveOutcome> {
	const current = await sql<{ version: string; guide: string | null }>(
		`SELECT version, guide FROM reports WHERE report_id = $1`,
		[reportId],
	);
	if (!current[0]) return "failed";
	if ((current[0].guide ?? null) !== startedFrom) return "changedMeanwhile";
	try {
		await applyAssistantEdits(
			assistantActor,
			{
				reportId,
				baseVersion: Number(current[0].version),
				operations: [{ type: "updateReport", guide }],
			},
			label.slice(0, 300),
			updateId,
		);
		return "saved";
	} catch (error) {
		console.warn(
			`The assistant could not save the guide of ${reportId}:`,
			error,
		);
		return "failed";
	}
}

// Guides on shared reports built on a source that mention a field by name.
async function guidesMentioning(
	sourceKey: string,
	field: string,
): Promise<{ report_id: string; title: string; guide: string }[]> {
	return await sql<{ report_id: string; title: string; guide: string }>(
		`SELECT DISTINCT r.report_id::text, r.title, r.guide
		 FROM reports r
		 LEFT JOIN report_pages p ON p.report_id = r.report_id AND p.is_active
		 LEFT JOIN report_visuals v ON v.page_id = p.page_id AND v.is_active
		 WHERE r.is_active AND NOT r.is_personal AND r.guide IS NOT NULL
		   AND NOT r.protect_edit
		   AND $1 IN (r.source_key, p.source_key, v.source_key)
		   AND strpos(lower(r.guide), lower($2)) > 0`,
		[sourceKey, field],
	);
}

// After a rename, every mention in a guide points at the new name. Done by
// text straight away, so it needs no model and changes nothing else.
export async function renameInGuides(input: {
	sourceKey: string;
	from: string;
	to: string;
	updateId: string | null;
}): Promise<string[]> {
	const source = getSource(input.sourceKey);
	const names = source
		? [...source.measures, ...source.dimensions].map((f) => f.name)
		: [];
	const changed: string[] = [];
	for (const row of await guidesMentioning(input.sourceKey, input.from)) {
		const next = renameField(row.guide, input.from, input.to, names);
		if (next === row.guide) continue;
		const outcome = await saveAsAssistant(
			row.report_id,
			row.guide,
			next,
			`Renamed ${input.from} to ${input.to} in the guide`,
			input.updateId,
		);
		if (outcome === "saved") changed.push(row.title);
	}
	return changed;
}

// A field removed or redefined is noted on each report whose guide names it,
// and the passages about it are rewritten with whatever else happened to the
// report in the same while. Returns the titles of the reports noted.
export async function queueGuideRevisions(input: {
	sourceKey: string;
	field: string;
	change: "removed" | "redefined";
	updateId: string | null;
}): Promise<string[]> {
	const source = getSource(input.sourceKey);
	const field = source
		? [...source.measures, ...source.dimensions].find(
				(f) => f.name === input.field,
			)
		: undefined;
	const rows = await guidesMentioning(input.sourceKey, input.field);
	await markGuidePending(
		rows.map((row) => row.report_id),
		[
			{
				kind: input.change,
				text:
					input.change === "removed"
						? `The field "${input.field}" was removed from the data and is no longer on the report`
						: `The field "${input.field}" was redefined. Its definition is now: ${field?.description ?? "not given"}`,
				updateId: input.updateId ?? undefined,
			},
		],
	);
	return rows.map((row) => row.title);
}

// How long a report has to go without a new reason before its guide is
// brought up to date, so a page being built is not chased edit by edit.
const quietFor = "10 minutes";
// Reports worked in one pass.
const pendingPerPass = 5;
// Reasons that could not be worked by then are dropped, so a report whose
// guide cannot be saved is not retried forever.
const giveUpAfter = "2 days";

// Reasons for a guide written as one line for a version's label.
function labelFor(prefix: string, reasons: GuideReason[]): string {
	// An update is named by its title, without the text quoted for the model.
	const first = (reasons[0]?.text ?? "").split(", which says:")[0];
	const more = reasons.length > 1 ? `, and ${reasons.length - 1} more` : "";
	return `${prefix} after ${first.charAt(0).toLowerCase()}${first.slice(1)}${more}`;
}

// Brings guides up to date with what happened to their reports, once each has
// been quiet for a while. A report with no guide is drafted when it is shared
// and has charts to walk through. Each edit is a version of its own.
export async function workPendingGuides(): Promise<number> {
	const due = await sql<{
		report_id: string;
		slug: string;
		description: string | null;
		guide: string | null;
		guide_pending: GuideReason[];
		pending_text: string;
		shared: boolean;
		protect_edit: boolean;
		stale: boolean;
	}>(
		`SELECT report_id::text, slug, description, guide, guide_pending,
		        guide_pending::text AS pending_text,
		        visibility IN ('shared', 'published') AS shared, protect_edit,
		        guide_pending_since < now() - $2::interval AS stale
		 FROM reports
		 WHERE is_active AND NOT is_personal AND guide_pending IS NOT NULL
		   AND guide_pending_last < now() - $1::interval
		 ORDER BY guide_pending_since
		 LIMIT $3`,
		[quietFor, giveUpAfter, pendingPerPass],
	);
	let worked = 0;
	for (const row of due) {
		// Cleared only if no new reason arrived while this one was worked.
		const clear = () =>
			sql(
				`UPDATE reports
				 SET guide_pending = NULL, guide_pending_since = NULL, guide_pending_last = NULL
				 WHERE report_id = $1 AND guide_pending::text = $2`,
				[row.report_id, row.pending_text],
			);
		// Tried again after another quiet spell.
		const later = () =>
			sql(
				`UPDATE reports SET guide_pending_last = now() WHERE report_id = $1`,
				[row.report_id],
			);
		const reasons = distinctReasons(row.guide_pending ?? []);
		const updateId =
			reasons.find((reason) => reason.updateId)?.updateId ?? null;
		if (row.protect_edit || row.stale || reasons.length === 0) {
			await clear();
			continue;
		}
		const report = await reportForScheduledRun(row.slug);
		if (!report) {
			await clear();
			continue;
		}
		const draftable = { ...report, description: row.description };

		try {
			if (!row.guide) {
				// Nothing to keep up to date. A first guide is written once the
				// report is shared and has something to walk a reader through.
				if (!row.shared || chartCount(report) < 2) {
					await clear();
					continue;
				}
				const text = await draftAsApplication(draftable);
				if (!text) {
					await later();
					continue;
				}
				const outcome = await saveAsAssistant(
					row.report_id,
					null,
					text,
					labelFor("Wrote a first guide", reasons),
					updateId,
				);
				if (outcome === "saved") {
					await clear();
					worked++;
				} else if (outcome === "changedMeanwhile") await clear();
				else await later();
				continue;
			}

			const revised = cleanMarkdown(
				await askAsApplication(
					followSystem,
					{
						guide: row.guide,
						changes: reasons.map((reason) => reason.text),
						report: outline(draftable),
					},
					reviseTokens,
				),
			);
			if (!revised || revised === row.guide.trim()) {
				await clear();
				continue;
			}
			// A rewrite that ran out of room is missing the end of the guide,
			// and one far longer or shorter is not an edit, so neither is saved.
			const ratio = revised.length / Math.max(row.guide.length, 1);
			if (
				(dropUnfinished(revised).cut &&
					!dropUnfinished(row.guide).cut) ||
				ratio < 0.6 ||
				ratio > 1.6
			) {
				console.warn(
					`The assistant's update to the guide of ${row.slug} was not saved, since it was cut short or changed too much.`,
				);
				await clear();
				continue;
			}
			const outcome = await saveAsAssistant(
				row.report_id,
				row.guide,
				revised,
				labelFor("Updated the guide", reasons),
				updateId,
			);
			if (outcome === "saved") {
				await clear();
				worked++;
			} else {
				// Somebody changed the guide meanwhile, or the save failed. The
				// reasons still stand, so they are worked against the new text.
				await later();
			}
		} catch (error) {
			if (error instanceof ModelUnavailable) return worked;
			console.warn(
				`The guide of ${row.slug} was not brought up to date:`,
				error,
			);
			await later();
		}
	}
	return worked;
}

// Shared reports with no guide yet, drafted a few at a time, once an hour
// whichever replica gets there. Events draft most guides as they happen. This
// catches the reports none reached, such as those shared before guides
// existed. The hour is read from the last attempt on any report rather than
// from a timer each replica would keep for itself. A report is tried once a
// week at most, so one the model cannot write for is not asked about on every
// pass.
const draftsPerPass = 2;
const draftEvery = "1 hour";

export async function draftMissingGuides(): Promise<number> {
	const recent = await sql(
		`SELECT 1 FROM reports
		 WHERE guide_draft_tried_on > now() - $1::interval
		 LIMIT 1`,
		[draftEvery],
	);
	if (recent.length > 0) return 0;
	const due = await sql<{
		report_id: string;
		slug: string;
		description: string | null;
	}>(
		`SELECT report_id::text, slug, description FROM reports
		 WHERE is_active AND NOT is_personal AND NOT protect_edit
		   AND visibility IN ('shared', 'published')
		   AND guide IS NULL
		   AND (guide_draft_tried_on IS NULL OR guide_draft_tried_on < now() - interval '7 days')
		 ORDER BY modified_on DESC
		 LIMIT $1`,
		[draftsPerPass],
	);
	let drafted = 0;
	for (const row of due) {
		await sql(
			`UPDATE reports SET guide_draft_tried_on = now() WHERE report_id = $1`,
			[row.report_id],
		);
		const report = await reportForScheduledRun(row.slug);
		if (!report || chartCount(report) < 2) continue;
		let text: string | null;
		try {
			text = await draftAsApplication({
				...report,
				description: row.description,
			});
		} catch (error) {
			if (error instanceof ModelUnavailable) return drafted;
			console.warn(
				`The assistant could not draft a guide for ${row.slug}:`,
				error,
			);
			continue;
		}
		if (!text) continue;
		// Written only if nobody wrote one while the model was working.
		const outcome = await saveAsAssistant(
			row.report_id,
			null,
			text,
			"Wrote a first guide from the report's charts, notes and field definitions",
			null,
		);
		if (outcome === "saved") drafted++;
	}
	return drafted;
}
