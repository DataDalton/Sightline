import { randomUUID } from "node:crypto";
import { sql } from "../data/lakebase";
import { notify, safeLink } from "../notify/store";
import { applyAssistantEdits } from "../platform/editing";
import { createAssistantSuggestion } from "../platform/requests";
import { categoryContacts } from "../platform/roles";
import { pickRecipients } from "../messages/rules";
import { postAssistantMessage, startThread } from "../messages/store";
import { getSource } from "../semantic/registry";
import { assistantActor } from "../upkeep/actor";
import { askAsApplication, ModelUnavailable } from "../upkeep/model";
import { checkVisual, parseJson } from "../upkeep/decide";
import { describeFields, sourceShape } from "../upkeep/look";
import { tellAboutChanges } from "../upkeep/tell";
import {
	openFeedbackByVisual,
	peopleBehind,
	recordTheme,
	type OpenFeedback,
} from "./store";
import { decideTheme, type ThemeProposal } from "./themes";

// Once a day the assistant reads what readers said about each visual, groups it
// into themes, and acts on each theme by what it would change.
//
//   A presentation fix, such as a clearer chart type, that it is sure of and
//   that enough people asked for with nobody saying otherwise, it takes to
//   the report's maintainers in a conversation, with its reasoning and the
//   change to approve. A report set to change automatically gets the change
//   made instead, as a version labelled "Because of reader feedback".
//   Anything less certain, and anything that changes what the visual means,
//   goes to the maintainers as a suggestion with its recommendation.
//   Figures that look wrong and that it could not explain start a conversation
//   with the maintainers, which it joins.
//
// The people who gave the feedback are told what came of it. A theme that is
// not ready to act on stays open and is read again the next day with whatever
// has arrived since.

interface VisualFacts {
	reportId: string;
	reportSlug: string;
	reportTitle: string;
	categoryId: string | null;
	title: string | null;
	visualType: string;
	sourceKey: string | null;
	config: Record<string, unknown>;
	protectedPage: boolean;
	// The report's own choice for a fix it is sure of. See the reports table.
	feedbackChanges: "automatic" | "suggest";
}

async function visualFacts(visualId: string): Promise<VisualFacts | null> {
	const rows = await sql<{
		report_id: string;
		slug: string;
		report_title: string;
		category_id: string | null;
		title: string | null;
		visual_type: string;
		source_key: string | null;
		config: Record<string, unknown>;
		protected: boolean;
		feedback_changes: string;
	}>(
		`SELECT r.report_id::text, r.slug, r.title AS report_title, r.category_id,
		        v.title, v.visual_type,
		        coalesce(v.source_key, p.source_key, r.source_key) AS source_key,
		        v.config, (r.protect_edit OR p.protect_edit) AS protected,
		        r.feedback_changes
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE v.visual_id::text = $1 AND v.is_active AND r.is_active`,
		[visualId],
	);
	const row = rows[0];
	return row
		? {
				reportId: row.report_id,
				reportSlug: row.slug,
				reportTitle: row.report_title,
				categoryId: row.category_id,
				title: row.title,
				visualType: row.visual_type,
				sourceKey: row.source_key,
				config: row.config ?? {},
				protectedPage: row.protected,
				feedbackChanges:
					row.feedback_changes === "automatic"
						? "automatic"
						: "suggest",
			}
		: null;
}

async function tellGivers(
	feedbackIds: string[],
	title: string,
	body: string,
	link: string,
): Promise<void> {
	for (const person of await peopleBehind(feedbackIds)) {
		await notify(person, {
			kind: "system",
			title,
			body,
			link: safeLink(link),
		}).catch(() => {});
	}
}

async function reviewVisual(
	visualId: string,
	items: OpenFeedback[],
): Promise<void> {
	const visual = await visualFacts(visualId);
	if (!visual) return;
	const source = visual.sourceKey ? getSource(visual.sourceKey) : null;
	const shape = source ? sourceShape(source) : null;

	let reply: unknown;
	try {
		reply = parseJson(
			await askAsApplication(
				[
					"Readers left feedback on one visual of a report. Group it into themes, each a single thing they want or find wrong.",
					"For each theme say what kind of change would answer it: presentation changes how the same figures are shown, such as the chart type or title, and never what is measured; meaning changes what is measured, split or filtered; data means the figures themselves look wrong; none means no change, such as a question that was answered.",
					"Say whether you are confident the change is right for most readers, and whether any feedback in the group asks for the opposite.",
					"Propose the visual after the change when there is one. Keep the same dimensions and measures for a presentation change.",
					'Answer with only JSON: {"themes": [{"feedbackIds": [...], "summary": "one sentence with no figures", "changeKind": "presentation" | "meaning" | "data" | "none", "confident": true | false, "contradicted": true | false, "proposal": null or {"visualType": "...", "title": "...", "dimensions": [...], "measures": [...]}}]}.',
					"Field names must be copied exactly from the lists given.",
				].join(" "),
				{
					report: visual.reportTitle,
					visual: {
						title: visual.title,
						type: visual.visualType,
						dimensions: visual.config.dimensions,
						measures: visual.config.measures,
						filters: visual.config.filters,
					},
					fields: source ? describeFields(source) : null,
					feedback: items.map((item) => ({
						id: item.feedbackId,
						kind: item.kind,
						said: item.body,
						understood: item.interpretation,
						answeredAtTheTime: item.answered,
					})),
				},
				3000,
			),
		);
	} catch (error) {
		if (error instanceof ModelUnavailable) return;
		throw error;
	}

	const known = new Map(items.map((item) => [item.feedbackId, item]));
	const themes = Array.isArray((reply as { themes?: unknown })?.themes)
		? (reply as { themes: Record<string, unknown>[] }).themes
		: [];

	for (const raw of themes.slice(0, 6)) {
		const feedbackIds = (
			Array.isArray(raw.feedbackIds) ? raw.feedbackIds : []
		)
			.map(String)
			.filter((id) => known.has(id));
		if (feedbackIds.length === 0) continue;
		const people = new Set(
			feedbackIds.map((id) => known.get(id)!.authorEmail.toLowerCase()),
		).size;
		const summary =
			String(raw.summary ?? "").slice(0, 300) ||
			"Feedback on this visual";
		const checked =
			raw.proposal && shape ? checkVisual(raw.proposal, shape) : null;
		const proposal: ThemeProposal | null = checked?.value ?? null;
		const unanswered = feedbackIds.some((id) => !known.get(id)!.answered);

		const decision = decideTheme({
			changeKind: String(raw.changeKind ?? "none"),
			confident: raw.confident === true,
			contradicted: raw.contradicted === true,
			people,
			unanswered,
			protectedPage: visual.protectedPage,
			before: {
				dimensions: (visual.config.dimensions as string[]) ?? [],
				measures: (visual.config.measures as string[]) ?? [],
			},
			proposal,
		});
		if (decision.act === "wait") continue;

		const operations = proposal
			? [
					{
						type: "updateVisual" as const,
						visualId,
						visualType: proposal.visualType,
						title: proposal.title,
						config: {
							...visual.config,
							dimensions: proposal.dimensions,
							measures: proposal.measures,
						},
					},
				]
			: [];

		if (decision.act === "apply" && visual.feedbackChanges === "suggest") {
			// Sure enough to make the change, on a report whose maintainers
			// asked to decide it themselves: a conversation with them, with
			// the reasoning and the change to approve in one click.
			const asked = await askMaintainers(visual, visualId, {
				summary,
				people,
				feedbackIds,
				items: feedbackIds.map((id) => known.get(id)!),
				proposal,
				operations,
			});
			if (!asked) continue;
			await recordTheme({
				reportId: visual.reportId,
				visualId,
				summary,
				people,
				changeKind: "presentation",
				recommendation: proposal,
				state: "suggested",
				feedbackIds,
				threadId: asked,
			});
			await tellGivers(
				feedbackIds,
				`Your feedback on ${visual.title ?? "a visual"} went to its maintainers`,
				`${summary} The assistant proposed a change for them to approve.`,
				`/r/${visual.reportSlug}`,
			);
		} else if (decision.act === "apply") {
			const current = await sql<{ version: string }>(
				`SELECT version FROM reports WHERE report_id = $1`,
				[visual.reportId],
			);
			const result = await applyAssistantEdits(
				assistantActor,
				{
					reportId: visual.reportId,
					baseVersion: Number(current[0]?.version ?? 0),
					operations,
				},
				`Because of reader feedback: ${summary}`,
			).catch((error) => {
				console.warn("A feedback change was refused:", error);
				return null;
			});
			if (!result) continue;
			await recordTheme({
				reportId: visual.reportId,
				visualId,
				summary,
				people,
				changeKind: "presentation",
				recommendation: proposal,
				state: "applied",
				feedbackIds,
				version: result.version,
			});
			await tellGivers(
				feedbackIds,
				`${visual.title ?? "A visual"} was changed because of your feedback`,
				`${summary} It is now ${proposal?.title ?? "updated"} on ${visual.reportTitle}.`,
				`/r/${visual.reportSlug}`,
			);
			await tellAboutChanges({
				updateId: null,
				sourceKey: visual.sourceKey,
				what: `${visual.title ?? "A visual"} was changed because of reader feedback: ${summary}`,
				reportIds: [visual.reportId],
			});
		} else if (decision.act === "suggest") {
			const suggestionId = await createAssistantSuggestion(
				assistantActor,
				visual.reportId,
				{
					operations,
					note: `Because of reader feedback from ${people} ${people === 1 ? "person" : "people"}: ${summary}`,
				},
			).catch((error) => {
				console.warn("A feedback suggestion was refused:", error);
				return null;
			});
			if (!suggestionId) continue;
			await recordTheme({
				reportId: visual.reportId,
				visualId,
				summary,
				people,
				changeKind: decision.changeKind,
				recommendation: proposal,
				state: "suggested",
				feedbackIds,
				suggestionId,
			});
			await tellGivers(
				feedbackIds,
				`Your feedback on ${visual.title ?? "a visual"} went to its maintainers`,
				`${summary} The assistant suggested a change for them to decide.`,
				`/r/${visual.reportSlug}`,
			);
		} else if (decision.act === "escalate" && visual.categoryId) {
			const recipients = pickRecipients(
				await categoryContacts(visual.categoryId),
				undefined,
			);
			const threadId = await startThread({
				author: assistantActor,
				categoryId: visual.categoryId,
				reportSlug: visual.reportSlug,
				subject: `Figures on ${visual.title ?? "a visual"} look wrong to readers`,
				body: `${people} ${people === 1 ? "person has" : "people have"} said the figures on ${visual.title ?? "this visual"} look wrong, and I could not explain it from the definitions. ${summary}`,
				recipients,
				withAssistant: true,
				visualId,
			}).catch((error) => {
				console.warn("The maintainers could not be asked:", error);
				return null;
			});
			if (!threadId) continue;
			await recordTheme({
				reportId: visual.reportId,
				visualId,
				summary,
				people,
				changeKind: "data",
				recommendation: null,
				state: "escalated",
				feedbackIds,
				threadId,
			});
			await tellGivers(
				feedbackIds,
				`The maintainers of ${visual.reportTitle} are looking into it`,
				summary,
				`/r/${visual.reportSlug}`,
			);
		}
	}
}

// A conversation with a report's maintainers about a fix readers agree on: why
// the assistant thinks it is right, what readers said, and the change itself as
// a card a maintainer applies in one click. Answers with the conversation's id.
async function askMaintainers(
	visual: VisualFacts,
	visualId: string,
	theme: {
		summary: string;
		people: number;
		feedbackIds: string[];
		items: OpenFeedback[];
		proposal: ThemeProposal | null;
		operations: unknown[];
	},
): Promise<string | null> {
	if (!visual.categoryId || !theme.proposal) return null;
	const recipients = pickRecipients(
		await categoryContacts(visual.categoryId),
		undefined,
	);
	const said = theme.items
		.map((item) => (item.body || item.interpretation || "").trim())
		.filter(Boolean)
		.slice(0, 5)
		.map((line) => `"${line.slice(0, 200)}"`)
		.join(" ");
	const reasoning = [
		`${theme.people} people asked for the same change to ${visual.title ?? "this visual"}: ${theme.summary}`,
		"Nobody asked for the opposite, and the change only alters how the same figures are shown, not what is measured.",
		said ? `What they said: ${said}` : "",
		"This report asks for such changes to be approved rather than made automatically, so here it is to approve.",
	]
		.filter(Boolean)
		.join(" ");
	const threadId = await startThread({
		author: assistantActor,
		categoryId: visual.categoryId,
		reportSlug: visual.reportSlug,
		subject: `Readers suggest a change to ${visual.title ?? "a visual"}`,
		body: reasoning,
		recipients,
		withAssistant: true,
		visualId,
	}).catch((error) => {
		console.warn("The maintainers could not be asked:", error);
		return null;
	});
	if (!threadId) return null;
	await postAssistantMessage(
		threadId,
		`Proposed: show it as ${theme.proposal.title}.`,
		"proposal",
		{
			proposalId: randomUUID(),
			reportId: visual.reportId,
			reportSlug: visual.reportSlug,
			visualId,
			visualTitle: visual.title,
			before: {
				visualType: visual.visualType,
				title: visual.title,
				dimensions: visual.config.dimensions ?? [],
				measures: visual.config.measures ?? [],
			},
			after: theme.proposal,
			operations: theme.operations,
			state: "open",
		},
	);
	return threadId;
}

// One pass a day, by whichever replica claims the day first.
export async function runFeedbackReview(): Promise<void> {
	const claimed = await sql<{ ran_on: string }>(
		`INSERT INTO feedback_review_runs (ran_on) VALUES (current_date)
		 ON CONFLICT DO NOTHING RETURNING ran_on::text`,
	);
	if (claimed.length === 0) return;
	const byVisual = await openFeedbackByVisual();
	for (const [visualId, items] of byVisual) {
		await reviewVisual(visualId, items).catch((error) => {
			console.warn(
				`Feedback on visual ${visualId} was not reviewed:`,
				error,
			);
		});
	}
}
