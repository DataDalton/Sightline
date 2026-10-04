import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { requestCheck } from "@/lib/freshness/checker";
import { standingOf } from "@/lib/freshness/lateness";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { reachableSet } from "@/lib/platform/sources";

// Whether the data behind a page has arrived when it usually does.
//
// Asked by a page for the sources it reads. Only sources the reader can read
// are answered for. A source past the time its data was expected, but not
// looked at since, has a look requested, so somebody reading the page is what
// settles whether it is late rather than a warehouse being kept awake to find
// out.

const maxSources = 20;

// Answers with each source's load pattern as stored, which the page says in
// the reader's own time zone, so the question carries nothing about the
// reader and the page that renders it can answer it too.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const params = request.nextUrl.searchParams;
	const asked = (params.get("sources") ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, maxSources);
	if (asked.length === 0) return NextResponse.json({ sources: [] });

	const reachable = await reachableSet(identity);
	const readable = asked.filter((key) => !reachable || reachable.has(key));

	const sources = await standingOf(readable);
	for (const source of sources) {
		if (source.state === "overdue") requestCheck(source.sourceKey);
	}

	const response = NextResponse.json({ sources });
	response.headers.set("Cache-Control", "private, max-age=60");
	return response;
}
