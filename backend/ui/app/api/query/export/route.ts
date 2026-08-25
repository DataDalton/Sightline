import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { parseQuerySpec, QuerySpecError } from "@/lib/query/spec";
import { QueryAccessError } from "@/lib/query/execute";
import { runExport } from "@/lib/query/export";
import { checkWriteRateLimit } from "@/lib/rateLimit";

// Export is rate limited like a write, not a read. It is the most expensive
// thing a user can ask for and the only one that takes data off the platform.
export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	try {
		const body = await request.json();
		const spec = parseQuerySpec(body?.spec ?? body);

		const result = await runExport(identity, {
			spec,
			format: "csv",
			reportId: body?.reportId ? String(body.reportId) : null,
			pageId: body?.pageId ? String(body.pageId) : null,
			visualId: body?.visualId ? String(body.visualId) : null,
		});

		return new NextResponse(result.content, {
			status: 200,
			headers: {
				"Content-Type": "text/csv; charset=utf-8",
				"Content-Disposition": `attachment; filename="${result.filename}"`,
				// The id ties the downloaded file to its audit row.
				"X-Export-Id": result.exportId,
				"X-Export-Rows": String(result.rowCount),
				"Cache-Control": "private, no-store",
			},
		});
	} catch (error) {
		if (error instanceof QueryAccessError) {
			return NextResponse.json({ error: error.message }, { status: 403 });
		}
		if (error instanceof QuerySpecError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Export failed:", error);
		return NextResponse.json({ error: "Export failed" }, { status: 500 });
	}
}
