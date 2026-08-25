import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { getFieldRange } from "@/lib/query/range";
import { QuerySpecError } from "@/lib/query/spec";
import { QueryAccessError } from "@/lib/query/execute";

// The bounds of a field, so a slider has real endpoints to span.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	try {
		const body = await request.json();
		const range = await getFieldRange(
			identity,
			String(body?.sourceKey ?? ""),
			String(body?.field ?? ""),
			Array.isArray(body?.filters) ? body.filters : [],
		);

		const response = NextResponse.json(range);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		if (error instanceof QueryAccessError) {
			return NextResponse.json({ error: error.message }, { status: 403 });
		}
		if (error instanceof QuerySpecError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Field range failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
