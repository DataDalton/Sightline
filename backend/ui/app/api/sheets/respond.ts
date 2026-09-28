import { NextRequest, NextResponse } from "next/server";
import type { Identity } from "@/lib/auth/identity";
import { QueryAccessError } from "@/lib/query/execute";
import { QuerySpecError } from "@/lib/query/spec";
import { getSheet, SheetError, type Sheet } from "@/lib/sheets/store";
import { caller, privateJson } from "../notifications/guard";

// What every sheet route starts with: somebody signed in, and a sheet they may
// open. A sheet they may not open reads as not found.
export async function sheetFor(
	request: NextRequest,
	id: string,
): Promise<{ identity: Identity; sheet: Sheet } | NextResponse> {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const sheet = await getSheet(identity, id);
	if (!sheet) return privateJson({ error: "Sheet not found" }, 404);
	return { identity, sheet };
}

// Turns what a sheet operation throws into the answer the page can show.
export function failure(error: unknown, action: string): NextResponse {
	if (error instanceof SheetError) {
		return privateJson({ error: error.message }, error.status);
	}
	if (error instanceof QueryAccessError) {
		return privateJson({ error: error.message }, 403);
	}
	if (error instanceof QuerySpecError) {
		return privateJson({ error: error.message }, 400);
	}
	console.error(`Sheet ${action} failed:`, error);
	return privateJson({ error: `Could not ${action}` }, 500);
}

export type IdContext = { params: Promise<{ id: string }> };
