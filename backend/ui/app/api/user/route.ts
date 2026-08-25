import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { isAdmin, isEditor } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

// Returns the caller identity and resolved policy class for the app shell.
// Never returns the forwarded token itself: the client has no use for it and
// echoing it back would widen its exposure.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);

	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const policy = await resolvePolicyClass(identity);

	const response = NextResponse.json({
		email: identity.email,
		name: identity.name,
		initials: identity.initials,
		authenticated: identity.authenticated,
		// Tells the client whether on-behalf-of queries are possible at all.
		canQueryAsUser: identity.userToken !== null,
		policy: {
			id: policy.id,
			grants: policy.grants,
			degraded: policy.degraded,
			stale: policy.stale,
		},
		// Capabilities rather than group names, so the client renders the right
		// affordances without having to know how membership is decided.
		canEdit: isEditor(policy),
		canAdminister: isAdmin(policy),
	});
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}
