import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	listFavourites,
	recentReports,
	searchTargets,
	type SearchTarget,
} from "@/lib/platform/search";
import { contentTargets } from "@/lib/platform/searchContent";
import { guideTargets } from "@/lib/guide/search";
import { getAccessContext, isAdmin } from "@/lib/platform/access";
import { adminNav } from "@/app/admin/nav";

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
		const [reports, content, panes, recent, favourites] = await Promise.all(
			[
				searchTargets(identity, policy),
				contentTargets(identity, policy),
				adminTargets(identity, policy),
				recentReports(identity.email),
				listFavourites(identity.email),
			],
		);
		// A guide is offered only on a report the reader can open, so they
		// are read from the report results rather than beside them.
		const guides = await guideTargets(reports).catch((error) => {
			console.warn("Search could not list guides:", error);
			return [];
		});
		const targets = [...reports, ...guides, ...content, ...panes];

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

// Every pane of Administration, for somebody who can open it, under the group
// the rail files it in. The blurb is matched too, so a pane is found by what
// it is for as well as by its name.
async function adminTargets(
	identity: NonNullable<ReturnType<typeof getIdentity>>,
	policy: Awaited<ReturnType<typeof resolvePolicyClass>>,
): Promise<SearchTarget[]> {
	const context = await getAccessContext(policy, identity);
	if (!isAdmin(policy) && context.baseline !== "admin") return [];
	return adminNav.flatMap((group) =>
		group.panes.map((pane) => ({
			id: `admin:${pane.id}`,
			kind: "admin" as const,
			title: pane.label,
			context: `Administration, ${group.label}`,
			href: `/admin?pane=${pane.id}`,
			keywords: pane.blurb,
		})),
	);
}
