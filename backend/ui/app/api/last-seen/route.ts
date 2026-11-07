import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/data/lakebase";
import { caller, privateJson, readJson } from "../notifications/guard";

// What a person's headline figures on a page read when they last looked. One small read per
// page, one small write as they leave it, and no warehouse queries, since the page has
// already read the figures it is comparing. Headline figures only, never a table's cells.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const pageId = request.nextUrl.searchParams.get("pageId") ?? "";
	try {
		const rows = await sql<{
			figures: Record<string, number>;
			seen_on: string;
		}>(
			`SELECT figures, seen_on FROM last_seen_figures
			 WHERE user_email = lower($1) AND page_id = $2`,
			[identity.email, pageId],
		);
		return privateJson({
			figures: rows[0]?.figures ?? {},
			seenOn: rows[0]?.seen_on ?? null,
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
	const pageId = String(body.pageId ?? "");
	if (!pageId || !body.figures || typeof body.figures !== "object") {
		return privateJson({ error: "Which page?" }, 400);
	}
	try {
		await sql(
			`INSERT INTO last_seen_figures (user_email, page_id, figures, seen_on)
			 VALUES (lower($1), $2, $3::jsonb, now())
			 ON CONFLICT (user_email, page_id)
			 DO UPDATE SET figures = EXCLUDED.figures, seen_on = now()`,
			[identity.email, pageId, JSON.stringify(body.figures)],
		);
		return privateJson({ ok: true });
	} catch (error) {
		console.error("Could not save figures last seen:", error);
		return privateJson({ error: "Could not save this" }, 500);
	}
}
