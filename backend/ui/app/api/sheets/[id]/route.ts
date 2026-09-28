import { NextRequest, NextResponse } from "next/server";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { deleteSheet, updateSheet } from "@/lib/sheets/store";
import { privateJson, readJson } from "../../notifications/guard";
import { failure, sheetFor, type IdContext } from "../respond";

// One sheet: what it asks, read, changed or removed. The data it shows comes
// from /data, under the reader's own access.

export async function GET(request: NextRequest, { params }: IdContext) {
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	return privateJson({ sheet: found.sheet });
}

// { title?, definition?, baseVersion }
export async function PUT(request: NextRequest, { params }: IdContext) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		const sheet = await updateSheet(found.identity, found.sheet.id, body);
		return privateJson({ sheet });
	} catch (error) {
		return failure(error, "save the sheet");
	}
}

export async function DELETE(request: NextRequest, { params }: IdContext) {
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	try {
		await deleteSheet(found.identity, found.sheet.id);
		return privateJson({ deleted: true });
	} catch (error) {
		return failure(error, "delete the sheet");
	}
}
