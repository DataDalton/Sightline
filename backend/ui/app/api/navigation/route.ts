import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { navigationPayload } from "@/lib/platform/pageData";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

// Categories the caller can actually open. A category they hold no grant for
// never reaches the client, so navigation cannot advertise a report that would
// then refuse to load.
//
// The shell is also rendered with this already in it, so on a first load this
// route is a revalidation rather than the thing being waited on. It still has
// to exist: the sidebar refetches when a grant changes, and a client-side
// navigation into a route that does not supply it falls back here.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	try {
		const policy = await resolvePolicyClass(identity);
		const response = NextResponse.json(
			await navigationPayload(identity, policy),
		);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Navigation load failed:", error);
		// An empty navigation is a safe answer: it shows nothing rather than
		// showing something the caller may not be entitled to.
		return NextResponse.json({
			categories: [],
			favourites: [],
			degraded: true,
		});
	}
}
