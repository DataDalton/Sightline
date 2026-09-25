import { NextRequest, NextResponse } from "next/server";
import {
	deleteAllConversations,
	listConversations,
} from "@/lib/assistant/store";
import { assistantCaller } from "../guard";

// The caller's own past conversations, newest first.
export async function GET(request: NextRequest) {
	const caller = await assistantCaller(request);
	if (caller instanceof NextResponse) return caller;
	try {
		const response = NextResponse.json({
			conversations: await listConversations(caller.email),
		});
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Could not list conversations:", error);
		return NextResponse.json(
			{ error: "Could not load your conversations" },
			{ status: 500 },
		);
	}
}

// Every conversation the caller has, gone at once.
export async function DELETE(request: NextRequest) {
	const caller = await assistantCaller(request);
	if (caller instanceof NextResponse) return caller;
	try {
		return NextResponse.json({
			deleted: await deleteAllConversations(caller.email),
		});
	} catch (error) {
		console.error("Could not delete conversations:", error);
		return NextResponse.json(
			{ error: "Could not delete your conversations" },
			{ status: 500 },
		);
	}
}
