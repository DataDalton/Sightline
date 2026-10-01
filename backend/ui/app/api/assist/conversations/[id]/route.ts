import { NextRequest, NextResponse } from "next/server";
import {
	maxMessageIdLength,
	maxMessageLength,
	saveBatchLength,
} from "@/lib/assistant/conversationSave";
import {
	deleteConversation,
	getConversation,
	renameConversation,
	saveConversation,
	type StoredMessage,
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

// The largest request body a save is read from. The browser splits a save
// across requests well under this, and one message alone may be as large as a
// message is allowed to be.
const maxSaveBody = maxMessageLength + saveBatchLength;

function isMessageId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxMessageIdLength
	);
}

// Saves the messages that are new or changed since the browser last saved, and
// drops the ones it lists as removed. The title is used when the save creates
// the conversation.
export async function PUT(request: NextRequest, { params }: Context) {
	const caller = await assistantCaller(request);
	if (caller instanceof NextResponse) return caller;
	const { id } = await params;

	const malformed = () =>
		NextResponse.json({ error: "Malformed request" }, { status: 400 });
	const tooLarge = () =>
		NextResponse.json(
			{ error: "A message in this conversation is too large to keep" },
			{ status: 413 },
		);

	const text = await request.text();
	if (text.length > maxSaveBody) return tooLarge();

	let body: { title?: unknown; messages?: unknown; removed?: unknown };
	try {
		body = JSON.parse(text);
	} catch {
		return malformed();
	}
	if (!body || typeof body !== "object") return malformed();

	const messages: StoredMessage[] = [];
	for (const m of Array.isArray(body.messages) ? body.messages : []) {
		if (!m || typeof m !== "object" || Array.isArray(m)) return malformed();
		const { id: messageId, role } = m as { id?: unknown; role?: unknown };
		if (!isMessageId(messageId) || typeof role !== "string") {
			return malformed();
		}
		const json = JSON.stringify(m);
		if (json.length > maxMessageLength) return tooLarge();
		messages.push({ id: messageId, role, json });
	}

	const removed = Array.isArray(body.removed) ? body.removed : [];
	if (!removed.every(isMessageId)) return malformed();

	const saved = await saveConversation(caller.email, id, {
		title: typeof body.title === "string" ? body.title : undefined,
		messages,
		removed,
	});
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
