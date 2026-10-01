import { NextRequest, NextResponse } from "next/server";
import type { Identity } from "@/lib/auth/identity";
import { BoardError, getBoard, type Board } from "@/lib/boards/store";
import { caller, privateJson } from "../notifications/guard";

// What every board route starts and ends with.

export type IdContext = { params: Promise<{ id: string }> };

// The caller and the board, or the response that refuses them. A board the
// caller cannot open answers as missing, so its existence is not confirmed.
export async function boardFor(
	request: NextRequest,
	id: string,
): Promise<{ identity: Identity; board: Board } | NextResponse> {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const board = await getBoard(identity, id);
	if (!board) return privateJson({ error: "Board not found" }, 404);
	return { identity, board };
}

export function failure(error: unknown, action: string): NextResponse {
	if (error instanceof BoardError) {
		return privateJson({ error: error.message }, error.status);
	}
	console.error(`Board ${action} failed:`, error);
	return privateJson({ error: `Could not ${action}` }, 500);
}
