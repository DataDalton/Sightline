import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { getReport } from "@/lib/platform/reports";
import { categoryContacts } from "@/lib/platform/roles";
import { getConversation } from "@/lib/assistant/store";
import { cleanText, limits, pickRecipients } from "@/lib/messages/rules";
import { MessageError, startThread } from "@/lib/messages/store";
import { openWithChecks } from "@/lib/feedback/threadAssistant";
import { caller, privateJson, readJson } from "../../notifications/guard";

// Starting a conversation with a report's maintainers from the assistant, once
// the person has accepted the offer. With their consent, the assistant
// conversation goes with it, without the rows its queries returned. The
// assistant takes part, and opens with what it already checked.
//
// { reportSlug, visualId?, subject, message, checked, shareConversationId? }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const input = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const message = cleanText(input.message, limits.body);
	if (!message) return privateJson({ error: "Write a message first." }, 400);

	try {
		const policy = await resolvePolicyClass(identity);
		const report =
			typeof input.reportSlug === "string"
				? await getReport(policy, identity, input.reportSlug)
				: null;
		if (!report?.categoryId) {
			return privateJson({ error: "Report not found" }, 404);
		}
		// Only a conversation of their own can be shared, and only one that
		// exists.
		let shared: string | null = null;
		if (typeof input.shareConversationId === "string") {
			const conversation = await getConversation(
				identity.email,
				input.shareConversationId,
			);
			shared = conversation ? input.shareConversationId : null;
		}
		const visualId =
			typeof input.visualId === "string" &&
			report.pages.some((page) =>
				page.visuals.some((v) => v.visualId === input.visualId),
			)
				? input.visualId
				: null;

		const threadId = await startThread({
			author: identity.email,
			categoryId: report.categoryId,
			reportSlug: report.slug,
			subject:
				cleanText(input.subject, limits.subject) ??
				`About ${report.title}`,
			body: message,
			recipients: pickRecipients(
				await categoryContacts(report.categoryId),
				undefined,
			),
			withAssistant: true,
			sharedConversationId: shared,
			visualId,
		});
		await openWithChecks(
			threadId,
			typeof input.checked === "string"
				? input.checked.slice(0, 2000)
				: "",
		).catch((error) => {
			console.warn(
				"The assistant could not open the conversation:",
				error,
			);
		});
		return privateJson({ threadId }, 201);
	} catch (error) {
		if (error instanceof MessageError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error(
			"The conversation with the maintainers was not started:",
			error,
		);
		return privateJson({ error: "Internal error" }, 500);
	}
}
