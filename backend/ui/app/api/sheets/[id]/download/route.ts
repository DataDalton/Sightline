import { NextRequest, NextResponse } from "next/server";
import { downloadSheet } from "@/lib/sheets/data";
import { failure, sheetFor, type IdContext } from "../../respond";

// The sheet as a CSV file, recorded in the export audit and written to the
// response as it is read.
export async function GET(request: NextRequest, { params }: IdContext) {
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	try {
		const file = await downloadSheet(found.identity, found.sheet);
		// Nothing in between holds the file back to send it whole.
		return new NextResponse(file.body, {
			headers: {
				"Content-Type": "text/csv; charset=utf-8",
				"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
				"Cache-Control": "private, no-store",
				"X-Accel-Buffering": "no",
			},
		});
	} catch (error) {
		return failure(error, "download the sheet");
	}
}
