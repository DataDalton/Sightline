import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass, type PolicyClass } from "@/lib/auth/policy";
import type { Identity } from "@/lib/auth/identity";
import { PageAlertError } from "@/lib/alerts/pageStore";
import { AlertDefinitionError } from "@/lib/alerts/rule";
import { settings } from "@/lib/settings";
import { caller, privateJson } from "../notifications/guard";

// What every page alert route starts and ends with.

// A page alert definition is a few hundred bytes. Anything far past that is
// not one.
const maxBodyBytes = 64 * 1024;

// The caller and their policy class, or the response that refuses them.
export async function pageAlertCaller(
	request: NextRequest,
): Promise<{ identity: Identity; policy: PolicyClass } | NextResponse> {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	if (!settings().alertsEnabled) {
		return privateJson({ error: "Alerts are turned off." }, 409);
	}
	return { identity, policy: await resolvePolicyClass(identity) };
}

// The body as JSON, or null when it is missing, malformed or too large.
export async function readBody(
	request: NextRequest,
): Promise<Record<string, unknown> | null> {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > maxBodyBytes) return null;
	try {
		const text = await request.text();
		if (text.length > maxBodyBytes) return null;
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export const badBody = () =>
	privateJson({ error: "The request could not be read." }, 400);

// Known refusals carry their own message and status. Anything else is logged
// and answered generally.
export function failed(error: unknown, what: string): NextResponse {
	if (error instanceof PageAlertError) {
		return privateJson({ error: error.message }, error.status);
	}
	if (error instanceof AlertDefinitionError) {
		return privateJson({ error: error.message }, 400);
	}
	console.error(`Page alert ${what} failed:`, error);
	return privateJson({ error: `Could not ${what}.` }, 500);
}
