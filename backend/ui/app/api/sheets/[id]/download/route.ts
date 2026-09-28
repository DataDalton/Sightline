import { NextRequest, NextResponse } from "next/server";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { downloadSheet } from "@/lib/sheets/data";
import { failure, sheetFor, type IdContext } from "../../respond";

// The sheet as a CSV file, recorded in the export audit. Rate limited like a
// write, since it is the one thing here that takes data off the platform.
export async function GET(request: NextRequest, { params }: IdContext) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	try {
		const file = await downloadSheet(found.identity, found.sheet);
		return new NextResponse(file.body, {
			headers: {
				"Content-Type": "text/csv; charset=utf-8",
				"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
				"Cache-Control": "private, no-store",
			},
		});
	} catch (error) {
		return failure(error, "download the sheet");
	}
}
