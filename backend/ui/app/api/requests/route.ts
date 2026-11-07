import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	decidePublish,
	decideSuggestion,
	RequestError,
	waitingFor,
	type Decision,
} from "@/lib/platform/requests";
import { caller, privateJson, readJson } from "../notifications/guard";

// Suggested changes and publish requests waiting on the caller, and the decision
// on one of them. See lib/platform/requests.

const decisions: Decision[] = ["approve", "decline", "withdraw"];

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	try {
		const policy = await resolvePolicyClass(identity);
		return privateJson(await waitingFor(policy, identity));
	} catch (error) {
		console.error("Could not read what is waiting:", error);
		return privateJson({ error: "Could not load your requests" }, 500);
	}
}

// { kind: "suggestion" | "publish", id, decision, note?, categoryId? }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;

	const id = String(body.id ?? "");
	const decision = body.decision as Decision;
	if (!id || !decisions.includes(decision)) {
		return privateJson(
			{ error: "A request and a decision are needed." },
			400,
		);
	}

	try {
		const policy = await resolvePolicyClass(identity);
		if (body.kind === "suggestion") {
			await decideSuggestion(policy, identity, id, decision, body.note);
		} else if (body.kind === "publish") {
			await decidePublish(policy, identity, id, decision, {
				categoryId: body.categoryId,
				note: body.note,
			});
		} else {
			return privateJson({ error: "Unknown kind of request." }, 400);
		}
		return privateJson({ ok: true });
	} catch (error) {
		if (error instanceof RequestError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Could not record a decision:", error);
		return privateJson({ error: "Could not record that decision" }, 500);
	}
}
