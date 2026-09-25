import { NextRequest, NextResponse } from "next/server";
import {
	deleteConversation,
	getConversation,
	maxTranscriptBytes,
	renameConversation,
	saveConversation,
} from "@/lib/assistant/store";
import { assistantCaller } from "../../guard";

// One conversation, read, saved, renamed or deleted by the person who had it.
// A conversation belonging to somebody else answers exactly as one that does
// not exist.

type Context = { params: Promise<{ id: string }> };

const notFound = () =>
	NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(request: NextRequest, { params }: Context) {
	const caller = await assistantCaller(request);
	if (caller instanceof NextResponse) return caller;
	const { id } = await params;
	const conversation = await getConversation(caller.email, id);
	if (!conversation) return notFound();
	const response = NextResponse.json(conversation);
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export async function PUT(request: NextRequest, { params }: Context) {
	const caller = await assistantCaller(request);
	if (caller instanceof NextResponse) return caller;
	const { id } = await params;

	const text = await request.text();
	if (text.length > maxTranscriptBytes) {
		return NextResponse.json(
			{
				error: "This conversation is too long to keep. Start a new one.",
			},
			{ status: 413 },
		);
	}

	let title = "";
	let messages: unknown[] = [];
	try {
		const body = JSON.parse(text);
		title = String(body?.title ?? "").trim() || "Untitled";
		messages = Array.isArray(body?.messages) ? body.messages : [];
	} catch {
		return NextResponse.json(
			{ error: "Malformed request" },
			{ status: 400 },
		);
	}

	const saved = await saveConversation(caller.email, id, title, messages);
	return saved ? NextResponse.json({ saved: true }) : notFound();
}

export async function PATCH(request: NextRequest, { params }: Context) {
	const caller = await assistantCaller(request);
	if (caller instanceof NextResponse) return caller;
	const { id } = await params;
	let title = "";
	try {
		title = String((await request.json())?.title ?? "");
	} catch {
		return NextResponse.json(
			{ error: "Malformed request" },
			{ status: 400 },
		);
	}
	const renamed = await renameConversation(caller.email, id, title);
	return renamed ? NextResponse.json({ renamed: true }) : notFound();
}

export async function DELETE(request: NextRequest, { params }: Context) {
	const caller = await assistantCaller(request);
	if (caller instanceof NextResponse) return caller;
	const { id } = await params;
	const deleted = await deleteConversation(caller.email, id);
	return deleted ? NextResponse.json({ deleted: true }) : notFound();
}
