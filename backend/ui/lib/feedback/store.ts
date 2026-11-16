import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { listReports } from "../platform/reports";

// What readers say about a visual.
//
// It arrives from the feedback button on a visual, or from somebody pointing at
// one in the assistant. Everything is kept, including what the assistant
// answered there and then, because a visual many people are confused by needs
// a change even when each of them got an answer. Once a day the assistant reads
// what is open, groups it per visual and acts on it. See lib/feedback/review.

export const feedbackKinds = [
	"hardToRead",
	"wrongChart",
	"missing",
	"numbersOff",
	"notNeeded",
	"wantInstead",
	"question",
	"other",
] as const;

export type FeedbackKind = (typeof feedbackKinds)[number];

export function isFeedbackKind(value: unknown): value is FeedbackKind {
	return (
		typeof value === "string" &&
		(feedbackKinds as readonly string[]).includes(value)
	);
}

export class FeedbackError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export interface FeedbackInput {
	reportId: string;
	visualId: string;
	kind: FeedbackKind;
	body: string;
	// Set when the assistant took it in, with what it understood and whether it
	// answered it.
	interpretation?: string | null;
	answered?: boolean;
	conversationId?: string | null;
}

// The visual's page and title, when it is an active visual of that report.
async function visualOn(
	reportId: string,
	visualId: string,
): Promise<{ pageId: string; title: string | null } | null> {
	const rows = await sql<{ page_id: string; title: string | null }>(
		`SELECT v.page_id::text, v.title FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 WHERE v.visual_id::text = $2 AND p.report_id::text = $1 AND v.is_active`,
		[reportId, visualId],
	);
	return rows[0] ? { pageId: rows[0].page_id, title: rows[0].title } : null;
}

export async function recordFeedback(
	policy: PolicyClass,
	identity: Identity,
	input: FeedbackInput,
): Promise<string> {
	const readable = await listReports(policy, identity);
	if (!readable.some((report) => report.reportId === input.reportId)) {
		throw new FeedbackError("Not found", 404);
	}
	const visual = await visualOn(input.reportId, input.visualId);
	if (!visual)
		throw new FeedbackError("That visual is not on this report.", 404);
	const rows = await sql<{ feedback_id: string }>(
		`INSERT INTO visual_feedback
		   (report_id, page_id, visual_id, author_email, kind, body,
		    interpretation, state, conversation_id)
		 VALUES ($1, $2, $3, lower($4), $5, $6, $7, $8, $9)
		 RETURNING feedback_id::text`,
		[
			input.reportId,
			visual.pageId,
			input.visualId,
			identity.email,
			input.kind,
			input.body.trim().slice(0, 2000),
			input.interpretation?.slice(0, 1000) ?? null,
			input.answered ? "answered" : "open",
			input.conversationId ?? null,
		],
	);
	return rows[0].feedback_id;
}

export interface OpenFeedback {
	feedbackId: string;
	reportId: string;
	visualId: string;
	authorEmail: string;
	kind: FeedbackKind;
	body: string;
	interpretation: string | null;
	answered: boolean;
	createdOn: string;
}

// Everything not yet grouped, per visual, oldest first. Answered items are read
// too, since repeated confusion is a signal even when each was answered.
export async function openFeedbackByVisual(): Promise<
	Map<string, OpenFeedback[]>
> {
	const rows = await sql<{
		feedback_id: string;
		report_id: string;
		visual_id: string;
		author_email: string;
		kind: FeedbackKind;
		body: string;
		interpretation: string | null;
		state: string;
		created_on: string;
	}>(
		`SELECT feedback_id::text, report_id::text, visual_id::text, author_email,
		        kind, body, interpretation, state, created_on::text
		 FROM visual_feedback
		 WHERE state IN ('open', 'answered') AND theme_id IS NULL
		 ORDER BY created_on`,
	);
	const byVisual = new Map<string, OpenFeedback[]>();
	for (const row of rows) {
		const held = byVisual.get(row.visual_id) ?? [];
		held.push({
			feedbackId: row.feedback_id,
			reportId: row.report_id,
			visualId: row.visual_id,
			authorEmail: row.author_email,
			kind: row.kind,
			body: row.body,
			interpretation: row.interpretation,
			answered: row.state === "answered",
			createdOn: row.created_on,
		});
		byVisual.set(row.visual_id, held);
	}
	return byVisual;
}

// Records a theme and ties its feedback to it.
export async function recordTheme(input: {
	reportId: string;
	visualId: string;
	summary: string;
	people: number;
	changeKind: "presentation" | "meaning" | "data" | "none";
	recommendation: unknown;
	state: "applied" | "suggested" | "escalated" | "declined" | "open";
	feedbackIds: string[];
	suggestionId?: string | null;
	version?: number | null;
	threadId?: string | null;
}): Promise<string> {
	const rows = await sql<{ theme_id: string }>(
		`INSERT INTO feedback_themes
		   (report_id, visual_id, summary, people, change_kind, recommendation,
		    state, suggestion_id, version, thread_id, decided_on)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
		         CASE WHEN $7 IN ('applied', 'declined') THEN now() END)
		 RETURNING theme_id::text`,
		[
			input.reportId,
			input.visualId,
			input.summary.slice(0, 500),
			input.people,
			input.changeKind,
			JSON.stringify(input.recommendation ?? null),
			input.state,
			input.suggestionId ?? null,
			input.version ?? null,
			input.threadId ?? null,
		],
	);
	const themeId = rows[0].theme_id;
	await sql(
		`UPDATE visual_feedback
		 SET theme_id = $2,
		     state = CASE WHEN $3 = 'applied' THEN 'acted' ELSE 'grouped' END,
		     resolved_on = CASE WHEN $3 = 'applied' THEN now() ELSE resolved_on END
		 WHERE feedback_id = ANY($1::uuid[])`,
		[input.feedbackIds, themeId, input.state],
	);
	return themeId;
}

// The people who gave the feedback in a theme, to tell them what came of it.
export async function peopleBehind(feedbackIds: string[]): Promise<string[]> {
	const rows = await sql<{ author_email: string }>(
		`SELECT DISTINCT author_email FROM visual_feedback
		 WHERE feedback_id = ANY($1::uuid[])`,
		[feedbackIds],
	);
	return rows.map((row) => row.author_email);
}

// The people whose feedback led to a conversation with a report's maintainers,
// for a request made from that conversation.
export async function giversForThread(threadId: string): Promise<string[]> {
	const rows = await sql<{ email: string }>(
		`SELECT DISTINCT lower(f.author_email) AS email
		 FROM visual_feedback f
		 JOIN feedback_themes t ON t.theme_id = f.theme_id
		 WHERE t.thread_id = $1`,
		[threadId],
	);
	return rows.map((row) => row.email);
}
