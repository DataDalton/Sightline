import { NextRequest, NextResponse } from "next/server";
import { createBoard, listBoards } from "@/lib/boards/store";
import { caller, privateJson, readJson } from "../notifications/guard";
import { failure } from "./respond";

// The caller's boards, their own and those shared with them, and new ones.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	try {
		return privateJson({ boards: await listBoards(identity) });
	} catch (error) {
		return failure(error, "list boards");
	}
}

// { title, items? }, where items are placed on the new board in order.
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		return privateJson({
			board: await createBoard(identity, body.title, body.items),
		});
	} catch (error) {
		return failure(error, "create the board");
	}
}
