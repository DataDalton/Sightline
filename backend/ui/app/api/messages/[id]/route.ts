import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { isUuid } from "@/lib/alerts/store";
import { cleanText, limits } from "@/lib/messages/rules";
import {
	MessageError,
	openThread,
	proposalOf,
	reply,
	updateProposal,
} from "@/lib/messages/store";
import { sql } from "@/lib/data/lakebase";
import {
	applyEdits,
	EditConflictError,
	EditForbiddenError,
	type EditOperation,
} from "@/lib/platform/editing";
import { createSuggestion, RequestError } from "@/lib/platform/requests";
import { listReports } from "@/lib/platform/reports";
import { getConversation } from "@/lib/assistant/store";
import { shareableTranscript } from "@/lib/feedback/sharedLog";
import { caller, privateJson, readJson } from "../../notifications/guard";

// One conversation. A conversation the caller is not in reads as not found,
// so an id is no way of learning that one exists.

type Context = { params: Promise<{ id: string }> };

const notFound = () => privateJson({ error: "Conversation not found" }, 404);

export async function GET(request: NextRequest, { params }: Context) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	if (!isUuid(id)) return notFound();
	try {
		const policy = await resolvePolicyClass(identity);
		const opened = await openThread(id, identity.email, policy.grants);
		if (!opened) return notFound();
		// ?log=1: the assistant conversation the person who asked chose to
		// share, without the rows its queries returned.
		if (request.nextUrl.searchParams.get("log") !== null) {
			const shared = opened.thread.sharedConversationId;
			const conversation = shared
				? await getConversation(opened.thread.createdBy, shared)
				: null;
			return privateJson({
				turns: conversation
					? shareableTranscript(conversation.messages)
					: [],
			});
		}
		return privateJson(opened);
	} catch (error) {
		console.error("Conversation could not be opened:", error);
		return privateJson({ error: "Internal error" }, 500);
	}
}

// { body }: a reply.
// { action: "apply" | "suggest", messageId }: a change the assistant proposed,
// applied by somebody who can edit the report or suggested by somebody who can
// suggest, each under their own permissions.
export async function POST(request: NextRequest, { params }: Context) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	if (!isUuid(id)) return notFound();

	const input = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	if (input.action === "apply" || input.action === "suggest") {
		return decideProposal(
			identity,
			id,
			String(input.messageId ?? ""),
			input.action,
		);
	}
	const body = cleanText(input.body, limits.body);
	if (!body) return privateJson({ error: "Write a reply first." }, 400);

	try {
		const policy = await resolvePolicyClass(identity);
		await reply(id, identity.email, policy.grants, body);
		return privateJson({ sent: true }, 201);
	} catch (error) {
		if (error instanceof MessageError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Reply could not be sent:", error);
		return privateJson({ error: "Internal error" }, 500);
	}
}

async function decideProposal(
	identity: Exclude<Awaited<ReturnType<typeof caller>>, NextResponse>,
	threadId: string,
	messageId: string,
	action: "apply" | "suggest",
) {
	try {
		const policy = await resolvePolicyClass(identity);
		// Only somebody in the conversation acts on what was proposed in it.
		const opened = await openThread(
			threadId,
			identity.email,
			policy.grants,
		);
		if (!opened) return notFound();
		const proposal = await proposalOf(threadId, messageId);
		if (!proposal) return privateJson({ error: "Proposal not found" }, 404);
		if (proposal.state !== "open") {
			return privateJson(
				{ error: "This change was already decided." },
				409,
			);
		}
		const reportId = String(proposal.reportId ?? "");
		const report = (await listReports(policy, identity)).find(
			(r) => r.reportId === reportId,
		);
		if (!report) return notFound();
		const operations = (proposal.operations ?? []) as EditOperation[];
		const current = await sql<{ version: string }>(
			`SELECT version FROM reports WHERE report_id = $1`,
			[reportId],
		);
		const baseVersion = Number(current[0]?.version ?? 0);
		if (action === "apply") {
			const result = await applyEdits(policy, identity.email, {
				reportId,
				baseVersion,
				operations,
			});
			await updateProposal(threadId, messageId, {
				state: "applied",
				by: identity.email,
				version: result.version,
			});
			return privateJson({ applied: true, version: result.version });
		}
		const suggestionId = await createSuggestion(
			policy,
			identity,
			reportId,
			{
				baseVersion,
				operations,
				note: `From a conversation: ${opened.thread.subject}`,
			},
		);
		await updateProposal(threadId, messageId, {
			state: "suggested",
			by: identity.email,
			suggestionId,
		});
		return privateJson({ suggested: true, suggestionId });
	} catch (error) {
		if (error instanceof RequestError) {
			return privateJson({ error: error.message }, error.status);
		}
		if (error instanceof EditForbiddenError) {
			return privateJson({ error: error.message }, 403);
		}
		if (error instanceof EditConflictError) {
			return privateJson({ error: error.message }, 409);
		}
		console.error("A proposed change could not be decided:", error);
		return privateJson({ error: "The change could not be made." }, 500);
	}
}
