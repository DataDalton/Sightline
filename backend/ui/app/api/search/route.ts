import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	listFavourites,
	recentReports,
	searchTargets,
} from "@/lib/platform/search";

// Everything the caller can navigate to, plus what they opened last and what
// they marked.
//
// One request rather than three: the palette needs all of it before it can
// draw a useful first screen, and the recents and favourites are two small
// queries against tables the same connection is already holding open.
//
// Matching happens in the browser. The list is bounded by what one person can
// reach, so it is small enough to filter locally, and a round trip per
// keystroke is the thing that makes a palette feel slow.
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
		const [targets, recent, favourites] = await Promise.all([
			searchTargets(identity, policy),
			recentReports(identity.email),
			listFavourites(identity.email),
		]);

		const response = NextResponse.json({ targets, recent, favourites });
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Search targets failed:", error);
		// Empty rather than an error status: the palette is an accelerator, and
		// a reader who opens it during an outage should find nothing rather
		// than a failure they have to dismiss before using the navigation.
		return NextResponse.json({
			targets: [],
			recent: [],
			favourites: [],
			degraded: true,
		});
	}
}
