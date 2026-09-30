import { NextRequest, NextResponse } from "next/server";
import { tableData } from "@/lib/sheets/data";
import { heartbeat, leaveSheet } from "@/lib/sheets/store";
import { privateJson, readJson } from "../../../notifications/guard";
import { failure, sheetFor, type IdContext } from "../../respond";

// Polled every few seconds by an open sheet. Renews the caller's place in the
// list of people who have it open, says who else does and which cell each has
// selected, and gives the version, so a copy that is behind knows to reload.

// { sessionId, cell }
export async function POST(request: NextRequest, { params }: IdContext) {
	const found = await sheetFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	if (!sessionId) return privateJson({ error: "No session" }, 400);
	try {
		const present = await heartbeat(
			found.identity,
			found.sheet.id,
			sessionId,
			body.cell,
		);
		return privateJson({
			version: found.sheet.version,
			modifiedBy: found.sheet.modifiedBy,
			present: await withinReach(found, present),
		});
	} catch (error) {
		return failure(error, "update who is here");
	}
}

// A row key is the row's dimension values, so another viewer's selection is
// passed on only when the caller's own rows include it. Somebody whose row
// filter hides a row does not learn its values from a colleague selecting it.
// The keys come from the same query the sheet itself shows, which is normally
// answered from the cache.
async function withinReach(
	found: Exclude<Awaited<ReturnType<typeof sheetFor>>, NextResponse>,
	present: Awaited<ReturnType<typeof heartbeat>>,
) {
	const selected = present.filter((p) => !p.self && p.cell?.row);
	if (selected.length === 0) return present;
	let visible: Set<string>;
	try {
		visible =
			found.sheet.definition.mode === "table"
				? new Set((await tableData(found.identity, found.sheet)).keys)
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
