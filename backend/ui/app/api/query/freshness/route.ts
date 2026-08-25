import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { getFieldRange } from "@/lib/query/range";
import { QuerySpecError } from "@/lib/query/spec";
import { QueryAccessError } from "@/lib/query/execute";

// How far the data on a page runs to.
//
// The maximum of a column an editor nominates, with no page filters applied. A
// reader who has filtered to last year should still see that the dataset runs
// to yesterday: "data through" is a fact about the source, not about the
// current selection, and narrowing it by the filters would make it read as
// though the data stopped where the reader stopped looking.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	try {
		const body = await request.json();
		const field = String(body?.field ?? "");
		const range = await getFieldRange(
			identity,
			String(body?.sourceKey ?? ""),
			field,
			[],
			"max",
		);

		const response = NextResponse.json({
			field,
			value: range.max,
			dataType: range.dataType,
		});
		// Held briefly by the browser as well as by the server cache: every
		// page load asks, and the answer moves once a day at most.
		response.headers.set("Cache-Control", "private, max-age=120");
		return response;
	} catch (error) {
		if (error instanceof QueryAccessError) {
			return NextResponse.json({ error: error.message }, { status: 403 });
		}
		if (error instanceof QuerySpecError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Freshness lookup failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
