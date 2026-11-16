import { NextRequest, NextResponse } from "next/server";
import type { Identity } from "@/lib/auth/identity";
import { resolvePolicyClass, type PolicyClass } from "@/lib/auth/policy";
import { actorOf, WorkError, type WorkActor } from "@/lib/work/access";
import { caller, privateJson } from "../notifications/guard";

// What every work queue route needs: who is asking, as the queue sees them, and
// one way of answering a failure. People and Databricks service principals sign
// in the same way, so automation uses the same routes.

export interface WorkCaller {
	identity: Identity;
	policy: PolicyClass;
	actor: WorkActor;
}

export async function workCaller(
	request: NextRequest,
): Promise<WorkCaller | NextResponse> {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const policy = await resolvePolicyClass(identity);
	return { identity, policy, actor: await actorOf(policy, identity) };
}

export function failed(error: unknown): NextResponse {
	if (error instanceof WorkError) {
		return privateJson({ error: error.message }, error.status);
	}
	console.error("A work queue request failed:", error);
	return privateJson({ error: "Could not do that." }, 500);
}
