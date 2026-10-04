import { NextRequest, NextResponse } from "next/server";
import { visibleKeys } from "@/lib/sheets/data";
import type { Identity } from "@/lib/auth/identity";
import {
	beatSheet,
	getSheet,
	leaveSheet,
	type Present,
} from "@/lib/sheets/store";
import { caller, privateJson, readJson } from "../../../notifications/guard";
import { failure, sheetFor, type IdContext } from "../../respond";

// Polled every few seconds by an open sheet. Renews the caller's place in the
// list of people who have it open, says who else does and which cell each has
// selected, and gives the version, so a copy that is behind knows to reload.

// { sessionId, cell }
export async function POST(request: NextRequest, { params }: IdContext) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const id = (await params).id;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	if (!sessionId) return privateJson({ error: "No session" }, 400);
	try {
		const beat = await beatSheet(identity, id, sessionId, body.cell);
		if (!beat) return privateJson({ error: "Sheet not found" }, 404);
		return privateJson({
			version: beat.version,
			modifiedBy: beat.modifiedBy,
			present: await withinReach(identity, id, beat.present),
		});
	} catch (error) {
		return failure(error, "update who is here");
	}
}

// A row key is the row's dimension values, so another viewer's selection is
// passed on only when the caller's own rows include it. Somebody whose row
// filter hides a row does not learn its values from a colleague selecting it.
// Only the selected rows are checked, under the caller's own access, and the
// sheet is read for that only when somebody else has a row selected.
async function withinReach(
	identity: Identity,
	id: string,
	present: Present[],
): Promise<Present[]> {
	const selected = present.filter((p) => !p.self && p.cell?.row);
	if (selected.length === 0) return present;
	let visible: Set<string>;
	try {
		const sheet = await getSheet(identity, id);
		visible = sheet
			? await visibleKeys(
					identity,
					sheet,
					selected.map((p) => p.cell!.row),
				)
			: new Set();
	} catch {
		visible = new Set();
	}
	return present.map((p) =>
		p.self || !p.cell?.row || visible.has(p.cell.row)
			? p
			: { ...p, cell: null },
	);
}

// { sessionId }: the sheet was closed.
export async function DELETE(request: NextRequest, { params }: IdContext) {
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	if (typeof body.sessionId === "string") {
		await leaveSheet(found.identity, found.sheet.id, body.sessionId).catch(
			() => {},
		);
	}
	return privateJson({ left: true });
}
