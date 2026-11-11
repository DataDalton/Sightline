import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/data/lakebase";
import { readerReport, updateReaderReport } from "@/lib/platform/readerReport";
import { withLastSeen, type LastSeenRow } from "@/lib/platform/readerRows";
import { reportOfPage } from "@/lib/platform/reports";
import { caller, privateJson, readJson } from "../notifications/guard";

// What a person's headline figures on a page read when they last looked. Read with the rest
// of what they have on the page's report as it opens, and written as they leave, which
// updates what is held so the next visit reads nothing. No warehouse queries, since the page
// has already read the figures it is comparing. Headline figures only, never a table's
// cells. See lib/platform/readerReport.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const pageId = (
		request.nextUrl.searchParams.get("pageId") ?? ""
	).toLowerCase();
	try {
		const reportId = await reportOfPage(pageId);
		const seen = reportId
			? (await readerReport(identity.email, reportId)).lastSeen.find(
					(row) => row.page_id === pageId,
				)
			: undefined;
		return privateJson({
			figures: seen?.figures ?? {},
			seenOn: seen?.seen_on ?? null,
		});
	} catch (error) {
		console.error("Could not read figures last seen:", error);
		return privateJson({ figures: {}, seenOn: null });
	}
}

// { pageId, figures }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as {
		pageId?: unknown;
		figures?: unknown;
	};
	const pageId = String(body.pageId ?? "").toLowerCase();
	if (!pageId || !body.figures || typeof body.figures !== "object") {
		return privateJson({ error: "Which page?" }, 400);
	}
	try {
		// Only a page that exists is written, so the table holds no rows a report cannot
		// read back.
		const reportId = await reportOfPage(pageId);
		if (!reportId) return privateJson({ error: "Not found" }, 404);
		const [written] = await sql<{
			figures: Record<string, number>;
			seen_on: Date;
		}>(
			`INSERT INTO last_seen_figures (user_email, page_id, figures, seen_on)
			 VALUES (lower($1), $2, $3::jsonb, now())
			 ON CONFLICT (user_email, page_id)
			 DO UPDATE SET figures = EXCLUDED.figures, seen_on = now()
			 RETURNING figures, seen_on`,
			[identity.email, pageId, JSON.stringify(body.figures)],
		);
		const seen: LastSeenRow = {
			page_id: pageId,
			figures: written.figures,
			seen_on: new Date(written.seen_on).toISOString(),
		};
		await updateReaderReport(identity.email, reportId, (held) =>
			withLastSeen(held, seen),
		);
		return privateJson({ ok: true });
	} catch (error) {
		console.error("Could not save figures last seen:", error);
		return privateJson({ error: "Could not save this" }, 500);
	}
}
