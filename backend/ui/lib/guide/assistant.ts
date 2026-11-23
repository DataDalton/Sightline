import { sql } from "../data/lakebase";
import { converse } from "../assistant/endpoint";
import { applyAssistantEdits } from "../platform/editing";
import { reportForScheduledRun } from "../platform/reports";
import { isPageControl } from "../visuals/catalog";
import { getSource } from "../semantic/registry";
import { assistantActor } from "../upkeep/actor";
import { askAsApplication, ModelUnavailable } from "../upkeep/model";
import { maxGuideLength } from "./markdown";
import { renameField } from "./mentions";
import { definitionsFor, type GuideReport } from "./store";

// The assistant's part in a report's guide: writing a first one from what the
// report holds, and keeping the text right when a field it talks about is
// renamed, removed or redefined.
//
// It is told the report's pages, charts, notes and field definitions, never any
// data, so a guide explains what the report is for and how to read it rather
// than what today's numbers say. What it writes goes straight onto the report
// as a version of its own, with a label saying what it did and why, like any
// other edit the assistant makes.

export interface DraftableReport extends GuideReport {
	title: string;
	description: string | null;
}

const writingRules = [
	"Write plain English for business readers who do not know the data model.",
	"American spelling. No em dashes or en dashes, no semicolons, and never join two clauses with a colon.",
	"Never state a figure, a total, a trend or a date, since you are given no data.",
	"Never invent a business rule, a threshold or a cause. Say only what the definitions, titles and notes support.",
	"Name fields exactly as they are given so readers can match them to the report.",
].join(" ");

const draftSystem = `You write the guide for a report in a business intelligence app. The guide is what a new reader opens to understand the report. ${writingRules} Answer with only Markdown, no preamble. Use these sections, as level two headings, leaving out any you have nothing true to say for: "What this report is for", "Which figure to quote", "How to read it", "Terms", "Things to know". Under "How to read it" walk through the charts in the order a reader meets them, a short paragraph or bullet each. Under "Terms" give a bullet per key measure or dimension with its meaning in a sentence. Under "Things to know" gather caveats from the chart notes and field definitions, such as partial periods, things left out, or figures that do not add up across rows. Keep it under 900 words.`;

const reviseSystem = `You keep a report's guide accurate after a field it talks about changed. ${writingRules} You are given the guide in Markdown and what changed. Change only the sentences that are now wrong or incomplete because of the change, and keep every other line exactly as it is, including headings, links and formatting. Answer with only the full revised guide in Markdown, no preamble. If nothing needs to change, answer with the guide unchanged.`;

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
		3000,
	);
	const text = cleanMarkdown(turn.content ?? "");
	if (!text) throw new Error("The assistant did not write a guide.");
	return text;
}

// Writes a guide onto a report as the assistant, as a version of its own.
async function saveAsAssistant(
	reportId: string,
	guide: string,
	label: string,
	updateId: string | null,
): Promise<boolean> {
	const current = await sql<{ version: string }>(
		`SELECT version FROM reports WHERE report_id = $1`,
		[reportId],
	);
	if (!current[0]) return false;
	try {
		await applyAssistantEdits(
			assistantActor,
			{
				reportId,
				baseVersion: Number(current[0].version),
				operations: [{ type: "updateReport", guide }],
			},
			label,
			updateId,
		);
		return true;
	} catch (error) {
		console.warn(
			`The assistant could not save the guide of ${reportId}:`,
			error,
		);
		return false;
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
// text, so it needs no model and changes nothing else.
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
		const saved = await saveAsAssistant(
			row.report_id,
			next,
			`Renamed ${input.from} to ${input.to} in the guide`,
			input.updateId,
		);
		if (saved) changed.push(row.title);
	}
	return changed;
}

// After a field is removed or redefined, the passages about it are rewritten
// and the rest of the guide is left as it was. A rewrite that drops or adds
// much more than a passage would is refused, since that is not an edit.
export async function reviseGuides(input: {
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
	const changed: string[] = [];
	for (const row of await guidesMentioning(input.sourceKey, input.field)) {
		let revised: string;
		try {
			revised = cleanMarkdown(
				await askAsApplication(
					reviseSystem,
					{
						guide: row.guide,
						change:
							input.change === "removed"
								? `The field "${input.field}" was removed from the dataset and is no longer on the report.`
								: `The field "${input.field}" was redefined. Its definition is now: ${field?.description ?? "not given"}`,
					},
					4000,
				),
			);
		} catch (error) {
			if (error instanceof ModelUnavailable) return changed;
			throw error;
		}
		if (!revised || revised === row.guide.trim()) continue;
		const ratio = revised.length / Math.max(row.guide.length, 1);
		if (ratio < 0.7 || ratio > 1.3) {
			console.warn(
				`The assistant's revision of the guide on ${row.title} changed too much and was not saved.`,
			);
			continue;
		}
		const saved = await saveAsAssistant(
			row.report_id,
			revised,
			input.change === "removed"
				? `Rewrote what the guide says about ${input.field}, which was removed`
				: `Updated what the guide says about ${input.field}, which was redefined`,
			input.updateId,
		);
		if (saved) changed.push(row.title);
	}
	return changed;
}

// Shared reports with no guide yet, drafted a few at a time. A report is tried
// once a week at most, so one the model cannot write for is not asked about on
// every pass.
const draftsPerPass = 2;

export async function draftMissingGuides(): Promise<number> {
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
		if (!report || report.pages.length === 0) continue;
		let text: string;
		try {
			text = cleanMarkdown(
				await askAsApplication(
					draftSystem,
					outline({ ...report, description: row.description }),
					3000,
				),
			);
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
		const still = await sql(
			`SELECT 1 FROM reports WHERE report_id = $1 AND guide IS NULL`,
			[row.report_id],
		);
		if (still.length === 0) continue;
		if (
			await saveAsAssistant(
				row.report_id,
				text,
				"Wrote a first guide from the report's charts, notes and field definitions",
				null,
			)
		)
			drafted++;
	}
	return drafted;
}
