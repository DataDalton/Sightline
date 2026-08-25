import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { getDistinctValues } from "@/lib/query/values";
import { QuerySpecError } from "@/lib/query/spec";
import { QueryAccessError } from "@/lib/query/execute";

// Distinct values for one column, feeding the filter dropdown. POST rather
// than GET because the current grid filters travel with the request so the
// list cascades, and those do not fit a query string.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	try {
		const body = await request.json();
		const result = await getDistinctValues(identity, {
			sourceKey: String(body?.sourceKey ?? ""),
			field: String(body?.field ?? ""),
			search: typeof body?.search === "string" ? body.search : undefined,
			filters: Array.isArray(body?.filters) ? body.filters : [],
			limit: Number(body?.limit) || undefined,
		});

		const response = NextResponse.json(result);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		if (error instanceof QueryAccessError) {
			return NextResponse.json({ error: error.message }, { status: 403 });
		}
		if (error instanceof QuerySpecError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Column values failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
