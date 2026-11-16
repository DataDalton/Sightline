import { randomUUID } from "node:crypto";
import { sql } from "../data/lakebase";
import { getConversation } from "../assistant/store";
import { getSource } from "../semantic/registry";
import { assistantAuthor, postAssistantMessage } from "../messages/store";
import { askAsApplication, ModelUnavailable } from "../upkeep/model";
import { checkVisual, parseJson } from "../upkeep/decide";
import { describeFields, sourceShape } from "../upkeep/look";
import { shareableTranscript, transcriptText } from "./sharedLog";

// The assistant taking part in a conversation with a report's maintainers.
//
// It reads the conversation as it goes, the assistant conversation the person
// chose to share, and the definition of the visual it is about. When it can
// answer something factual, such as what a measure includes, it says so. When
// the people talking settle on a change to the visual, it posts the change as a
// card that a maintainer applies or suggests in one click. It never changes
// anything itself from here.
//
// It reads no data. Everything it knows comes from the definitions and from
// what the people in the conversation wrote.

interface ThreadFacts {
	subject: string;
	reportSlug: string | null;
	visualId: string | null;
	sharedConversationId: string | null;
	createdBy: string;
}

async function factsOf(threadId: string): Promise<ThreadFacts | null> {
	const rows = await sql<{
		subject: string;
		report_slug: string | null;
		visual_id: string | null;
		shared_conversation_id: string | null;
		created_by: string;
	}>(
		`SELECT subject, report_slug, visual_id::text,
		        shared_conversation_id::text, created_by
		 FROM threads WHERE thread_id::text = $1 AND with_assistant`,
		[threadId],
	);
	const row = rows[0];
	return row
		? {
				subject: row.subject,
				reportSlug: row.report_slug,
				visualId: row.visual_id,
				sharedConversationId: row.shared_conversation_id,
				createdBy: row.created_by,
			}
		: null;
}

interface VisualFacts {
	reportId: string;
	reportTitle: string;
	visualId: string;
	title: string | null;
	visualType: string;
	sourceKey: string | null;
	config: Record<string, unknown>;
}

async function visualOf(
	reportSlug: string | null,
	visualId: string | null,
): Promise<VisualFacts | null> {
	if (!reportSlug || !visualId) return null;
	const rows = await sql<{
		report_id: string;
		report_title: string;
		visual_id: string;
		title: string | null;
		visual_type: string;
		source_key: string | null;
		config: Record<string, unknown>;
	}>(
		`SELECT r.report_id::text, r.title AS report_title, v.visual_id::text,
		        v.title, v.visual_type,
		        coalesce(v.source_key, p.source_key, r.source_key) AS source_key,
		        v.config
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE r.slug = $1 AND v.visual_id::text = $2`,
		[reportSlug, visualId],
	);
	const row = rows[0];
	return row
		? {
				reportId: row.report_id,
				reportTitle: row.report_title,
				visualId: row.visual_id,
				title: row.title,
				visualType: row.visual_type,
				sourceKey: row.source_key,
				config: row.config ?? {},
			}
		: null;
}

async function sharedLog(facts: ThreadFacts): Promise<string | null> {
	if (!facts.sharedConversationId) return null;
	const conversation = await getConversation(
		facts.createdBy,
		facts.sharedConversationId,
	).catch(() => null);
	return conversation
		? transcriptText(shareableTranscript(conversation.messages))
		: null;
}

// What the assistant posts first: what it already checked, so the maintainers
// do not start from nothing.
export async function openWithChecks(
	threadId: string,
	checked: string,
): Promise<void> {
	const note = checked.trim();
	if (!note) return;
	await postAssistantMessage(
		threadId,
		`What I checked before suggesting this conversation: ${note}`,
	);
}

// One reading of the conversation after somebody wrote in it.
export async function respondInThread(threadId: string): Promise<void> {
	const facts = await factsOf(threadId);
	if (!facts) return;
	const messages = await sql<{
		author_email: string;
		body: string;
		kind: string;
	}>(
		`SELECT author_email, body, kind FROM thread_messages
		 WHERE thread_id::text = $1 ORDER BY created_on DESC LIMIT 40`,
		[threadId],
	);
	// Its own message last means nothing new has been said to it.
	if (
		messages.length === 0 ||
		messages[0].author_email.toLowerCase() === assistantAuthor.toLowerCase()
	) {
		return;
	}
	const visual = await visualOf(facts.reportSlug, facts.visualId);
	const source = visual?.sourceKey ? getSource(visual.sourceKey) : null;
	const log = await sharedLog(facts);

	let reply: unknown;
	try {
		reply = parseJson(
			await askAsApplication(
				[
					"You are the data assistant taking part in a conversation between a person and the maintainers of a report, about one visual.",
					"Read the conversation. Answer only what you can answer from the visual's definition and the dataset's field definitions, such as what a measure includes. You have no data, so never state a figure.",
					"When the people talking agree on a change to the visual, or a maintainer asks you for one, propose it. Otherwise propose nothing.",
					"Say nothing when nothing you could add would help; it is fine to stay quiet.",
					'Answer with only JSON: {"reply": "a short message, or null", "proposal": null or {"visualType": "...", "title": "...", "dimensions": [...], "measures": [...], "why": "one sentence"}}.',
					"Field names in a proposal must be copied exactly from the lists given.",
				].join(" "),
				{
					subject: facts.subject,
					report: visual?.reportTitle ?? facts.reportSlug,
					visual: visual
						? {
								title: visual.title,
								type: visual.visualType,
								dimensions: visual.config.dimensions,
								measures: visual.config.measures,
								filters: visual.config.filters,
							}
						: null,
					fields: source ? describeFields(source) : null,
					sharedConversation: log,
					conversation: [...messages]
						.reverse()
						.map(
							(m) =>
								`${m.author_email.toLowerCase() === assistantAuthor.toLowerCase() ? "Assistant" : m.author_email}: ${m.body}`,
						),
				},
				2000,
			),
		);
	} catch (error) {
		if (error instanceof ModelUnavailable) return;
		throw error;
	}
	const answer = (reply ?? {}) as { reply?: unknown; proposal?: unknown };
	const text = typeof answer.reply === "string" ? answer.reply.trim() : "";
	if (text) await postAssistantMessage(threadId, text.slice(0, 2000));

	if (answer.proposal && visual && source) {
		const checked = checkVisual(answer.proposal, sourceShape(source));
		if (!checked.value) return;
		const proposal = checked.value;
		const why =
			typeof (answer.proposal as { why?: unknown }).why === "string"
				? String((answer.proposal as { why: string }).why).slice(0, 300)
				: "";
		await postAssistantMessage(
			threadId,
			why || `A change to ${visual.title ?? "the visual"}.`,
			"proposal",
			{
				proposalId: randomUUID(),
				reportId: visual.reportId,
				reportSlug: facts.reportSlug,
				visualId: visual.visualId,
				visualTitle: visual.title,
				before: {
					visualType: visual.visualType,
					title: visual.title,
					dimensions: visual.config.dimensions ?? [],
					measures: visual.config.measures ?? [],
				},
				after: proposal,
				operations: [
					{
						type: "updateVisual",
						visualId: visual.visualId,
						visualType: proposal.visualType,
						title: proposal.title,
						config: {
							...visual.config,
							dimensions: proposal.dimensions,
							measures: proposal.measures,
						},
					},
				],
				state: "open",
			},
		);
	}
}
