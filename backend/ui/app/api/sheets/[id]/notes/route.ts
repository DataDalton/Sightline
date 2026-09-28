import { NextRequest, NextResponse } from "next/server";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { canSeeRow } from "@/lib/sheets/data";
import { maxNoteLength, SheetError, writeNote } from "@/lib/sheets/store";
import { privateJson, readJson } from "../../../notifications/guard";
import { failure, sheetFor, type IdContext } from "../../respond";

// { rowKey, noteId, value }: writes one note, or clears it with an empty
// value. Only on a row the writer can see now, so a note cannot be left on a
// row somebody else's filter shows them and this person's hides.
export async function PUT(request: NextRequest, { params }: IdContext) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const rowKey = typeof body.rowKey === "string" ? body.rowKey : "";
	const noteId = typeof body.noteId === "string" ? body.noteId : "";
	const value = typeof body.value === "string" ? body.value : "";
	try {
		if (!rowKey || !noteId || rowKey.length > 4000) {
			throw new SheetError("Say which row and which note column.");
		}
		if (value.length > maxNoteLength) {
			throw new SheetError(
				`A note can be at most ${maxNoteLength} characters.`,
			);
		}
		if (!(await canSeeRow(found.identity, found.sheet, rowKey))) {
			throw new SheetError("That row is not in the sheet any more.", 409);
		}
		const version = await writeNote(
			found.identity,
			found.sheet,
			rowKey,
			noteId,
			value,
		);
		return privateJson({ version });
	} catch (error) {
		return failure(error, "save the note");
	}
}
