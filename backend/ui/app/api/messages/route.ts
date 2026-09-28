import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { cleanText, limits, pickRecipients } from "@/lib/messages/rules";
import { listThreads, MessageError, startThread } from "@/lib/messages/store";
import { getCategory, getReport } from "@/lib/platform/reports";
import { categoryContacts } from "@/lib/platform/roles";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { caller, privateJson, readJson } from "../notifications/guard";

// The caller's conversations, and starting a new one.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	try {
		const policy = await resolvePolicyClass(identity);
		const threads = await listThreads(identity.email, policy.grants);
		return privateJson({
			threads,
			unread: threads.filter((t) => t.unread).length,
		});
	} catch (error) {
		console.error("Conversations could not be listed:", error);
		return privateJson({ error: "Internal error" }, 500);
	}
}

// { categoryId } or { reportSlug }, plus { subject, body, recipients? }.
//
// Sent to the people who maintain the category, and only to them. Asked from a
// report, the category is the report's own, so a reader cannot name a
// category they cannot open by way of a report they can.
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const input = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const body = cleanText(input.body, limits.body);
	if (!body) return privateJson({ error: "Write a message first." }, 400);

	try {
		const policy = await resolvePolicyClass(identity);

		let categoryId: string | null = null;
		let reportSlug: string | null = null;
		let about = "";
		if (typeof input.reportSlug === "string" && input.reportSlug) {
			const report = await getReport(policy, identity, input.reportSlug);
			if (!report?.categoryId) {
				return privateJson({ error: "Report not found" }, 404);
			}
			categoryId = report.categoryId;
			reportSlug = report.slug;
			about = report.title;
		} else if (typeof input.categoryId === "string" && input.categoryId) {
			const category = await getCategory(
				policy,
				identity,
				input.categoryId,
			);
			if (!category) {
				return privateJson({ error: "Category not found" }, 404);
			}
			categoryId = category.categoryId;
			about = category.name;
		}
		if (!categoryId) {
			return privateJson(
				{ error: "Say which category or report this is about." },
				400,
			);
		}

		const recipients = pickRecipients(
			await categoryContacts(categoryId),
			input.recipients,
		);
		const threadId = await startThread({
			author: identity.email,
			categoryId,
			reportSlug,
			subject:
				cleanText(input.subject, limits.subject) ?? `About ${about}`,
			body,
			recipients,
		});
		return privateJson({ threadId }, 201);
	} catch (error) {
		if (error instanceof MessageError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Conversation could not be started:", error);
		return privateJson({ error: "Internal error" }, 500);
	}
}
