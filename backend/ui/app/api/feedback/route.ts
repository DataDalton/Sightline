import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	FeedbackError,
	isFeedbackKind,
	recordFeedback,
} from "@/lib/feedback/store";
import { caller, privateJson, readJson } from "../notifications/guard";

// Feedback on a visual from its feedback button. See lib/feedback.
// { reportId, visualId, kind, body }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	if (!isFeedbackKind(body.kind)) {
		return privateJson({ error: "Choose what is wrong." }, 400);
	}
	try {
		const policy = await resolvePolicyClass(identity);
		const feedbackId = await recordFeedback(policy, identity, {
			reportId: String(body.reportId ?? ""),
			visualId: String(body.visualId ?? ""),
			kind: body.kind,
			body: typeof body.body === "string" ? body.body : "",
		});
		return privateJson({ feedbackId }, 201);
	} catch (error) {
		if (error instanceof FeedbackError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Feedback was not recorded:", error);
		return privateJson(
			{ error: "The feedback could not be recorded." },
			500,
		);
	}
}
