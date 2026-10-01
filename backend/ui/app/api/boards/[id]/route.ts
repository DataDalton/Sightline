import { NextRequest, NextResponse } from "next/server";
import { deleteBoard, updateBoard } from "@/lib/boards/store";
import { privateJson, readJson } from "../../notifications/guard";
import { boardFor, failure, type IdContext } from "../respond";

export async function GET(request: NextRequest, { params }: IdContext) {
	const found = await boardFor(request, (await params).id);
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
			board: await updateBoard(found.identity, found.board.id, body),
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
