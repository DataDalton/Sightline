import { NextRequest, NextResponse } from "next/server";
import {
	boardVersion,
	deleteBoard,
	getBoard,
	updateBoard,
} from "@/lib/boards/store";
import { caller, privateJson, readJson } from "../../notifications/guard";
import { boardFor, failure, type IdContext } from "../respond";

// With ?since=<version>, a board no newer than that version answers 204 with
// no body, so an open page checking for changes reads only the version.
export async function GET(request: NextRequest, { params }: IdContext) {
	const id = (await params).id;
	const since = Number(request.nextUrl.searchParams.get("since") ?? "");
	if (request.nextUrl.searchParams.has("since") && Number.isFinite(since)) {
		const identity = await caller(request);
		if (identity instanceof NextResponse) return identity;
		const version = await boardVersion(identity, id);
		if (version === null) {
			return privateJson({ error: "Board not found" }, 404);
		}
		if (version <= since) {
			return new NextResponse(null, {
				status: 204,
				headers: { "Cache-Control": "private, no-store" },
			});
		}
		const board = await getBoard(identity, id);
		if (!board) return privateJson({ error: "Board not found" }, 404);
		return privateJson({ board });
	}
	const found = await boardFor(request, id);
	if (found instanceof NextResponse) return found;
	return privateJson({ board: found.board });
}

// { title?, definition?, baseVersion }
export async function PUT(request: NextRequest, { params }: IdContext) {
	const found = await boardFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		return privateJson({
			board: await updateBoard(
				found.identity,
				found.board.id,
				body,
				found.board,
			),
		});
	} catch (error) {
		return failure(error, "save the board");
	}
}

export async function DELETE(request: NextRequest, { params }: IdContext) {
	const found = await boardFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	try {
		await deleteBoard(found.identity, found.board.id);
		return privateJson({ deleted: true });
	} catch (error) {
		return failure(error, "delete the board");
	}
}
