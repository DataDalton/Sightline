import { NextRequest, NextResponse } from "next/server";
import { addItems } from "@/lib/boards/store";
import { privateJson, readJson } from "../../../notifications/guard";
import { boardFor, failure, type IdContext } from "../../respond";

// { items }, added below what the board already holds. Used from a report,
// the briefing, the assistant and Explore, none of which has the board open.
export async function POST(request: NextRequest, { params }: IdContext) {
	const found = await boardFor(request, (await params).id);
	if (found instanceof NextResponse) return found;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		const { board, added } = await addItems(
			found.identity,
			found.board.id,
			body.items,
			found.board,
		);
		return privateJson({
			board: { id: board.id, title: board.title },
			added,
		});
	} catch (error) {
		return failure(error, "add to the board");
	}
}
