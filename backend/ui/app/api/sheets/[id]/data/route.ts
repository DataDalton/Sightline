import { NextRequest, NextResponse } from "next/server";
import { pivotData, tableData } from "@/lib/sheets/data";
import { privateJson } from "../../../notifications/guard";
import { failure, sheetFor, type IdContext } from "../../respond";

// The rows a sheet shows, for the person asking, with the notes that sit on
// those rows and no others.
export async function GET(request: NextRequest, { params }: IdContext) {
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	try {
		const data =
			found.sheet.definition.mode === "pivot"
				? await pivotData(found.identity, found.sheet)
				: await tableData(found.identity, found.sheet);
		return privateJson({ version: found.sheet.version, data });
	} catch (error) {
		return failure(error, "load the sheet's data");
	}
}
