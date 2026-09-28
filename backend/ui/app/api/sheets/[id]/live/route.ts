import { NextRequest, NextResponse } from "next/server";
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
			present,
		});
	} catch (error) {
		return failure(error, "update who is here");
	}
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
