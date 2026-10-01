import { NextRequest, NextResponse } from "next/server";
import { canSeeRow, notesOnRows } from "@/lib/sheets/data";
import {
	limits,
	maxNoteLength,
	SheetError,
	writeNote,
} from "@/lib/sheets/store";
import { privateJson, readJson } from "../../../notifications/guard";
import { failure, sheetFor, type IdContext } from "../../respond";

// { rowKey, noteId, value }: writes one note, or clears it with an empty
// value. Only on a row the writer can see now, so a note cannot be left on a
// row somebody else's filter shows them and this person's hides.
export async function PUT(request: NextRequest, { params }: IdContext) {
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

// { keys }: the notes on rows the page already holds, read again after the
// notes changed, without reading the rows again. Answered only for rows the
// caller can see now.
export async function POST(request: NextRequest, { params }: IdContext) {
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	// No more keys than a table holds rows, each no longer than the row key
	// a note may be written on.
	const keys = (Array.isArray(body.keys) ? body.keys : [])
		.filter((k): k is string => typeof k === "string" && k.length <= 4000)
		.slice(0, limits.tableRows);
	try {
		const notes = await notesOnRows(found.identity, found.sheet, keys);
		return privateJson({ notesVersion: found.sheet.notesVersion, notes });
	} catch (error) {
		return failure(error, "load the notes");
	}
}
