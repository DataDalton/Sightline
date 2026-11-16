import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	browse,
	decideReview,
	grantToSelf,
	openUnderGrant,
	overview,
	requestReview,
	ReviewError,
} from "@/lib/review/store";
import { caller, privateJson, readJson } from "../notifications/guard";

// Conversation review. See lib/review.
//
// GET: requests and, for an administrator, every request and reading.
// GET ?grant=<id>: the conversations an approved grant reaches.
// GET ?grant=<id>&open=<conversation>: one of them, recorded.
export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const params = request.nextUrl.searchParams;
	try {
		const grant = params.get("grant");
		if (grant) {
			const open = params.get("open");
			return privateJson(
				open
					? await openUnderGrant(identity, grant, open)
					: { conversations: await browse(identity, grant) },
			);
		}
		const policy = await resolvePolicyClass(identity);
		return privateJson(await overview(policy, identity));
	} catch (error) {
		return failed(error);
	}
}

// { action: "request" | "selfGrant", kind, scope, reasonCategory, reason, durationDays, security }
// { action: "approve" | "decline" | "revoke", requestId, note }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		const policy = await resolvePolicyClass(identity);
		switch (body.action) {
			case "request":
				return privateJson(
					{ requestId: await requestReview(policy, identity, body) },
					201,
				);
			case "selfGrant":
				return privateJson(
					{ requestId: await grantToSelf(policy, identity, body) },
					201,
				);
			case "approve":
			case "decline":
			case "revoke":
				await decideReview(
					policy,
					identity,
					String(body.requestId ?? ""),
					body.action,
					typeof body.note === "string" ? body.note : "",
				);
				return privateJson({ ok: true });
			default:
				return privateJson({ error: "Unknown action." }, 400);
		}
	} catch (error) {
		return failed(error);
	}
}

function failed(error: unknown) {
	if (error instanceof ReviewError) {
		return privateJson({ error: error.message }, error.status);
	}
	console.error("A conversation review request failed:", error);
	return privateJson({ error: "Could not do that." }, 500);
}
