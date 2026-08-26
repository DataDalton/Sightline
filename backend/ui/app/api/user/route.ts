import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { warmSourceAccess } from "@/lib/auth/sourceAccess";
import { userPayload } from "@/lib/platform/pageData";
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

	// Started here and awaited by whatever query needs it. Not awaited: the
	// shell does not need the answer, and holding it up would move the cost
	// rather than hide it.
	warmSourceAccess(identity);

	const response = NextResponse.json(await userPayload(identity, policy));
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}
