import { NextRequest, NextResponse } from "next/server";
import { createSheet, listSheets } from "@/lib/sheets/store";
import { caller, privateJson, readJson } from "../notifications/guard";
import { failure } from "./respond";

// The caller's sheets, their own and those shared with them, or a new one.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	try {
		return privateJson({ sheets: await listSheets(identity) });
	} catch (error) {
		return failure(error, "load your sheets");
	}
}

// { title, definition }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = (await readJson(request)) as {
		title?: unknown;
		definition?: unknown;
	} | null;
	try {
		const sheet = await createSheet(
			identity,
			typeof body?.title === "string" ? body.title : "",
			body?.definition,
		);
		return privateJson({ sheet });
	} catch (error) {
		return failure(error, "create the sheet");
	}
}
