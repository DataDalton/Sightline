import { NextRequest, NextResponse } from "next/server";
import { sendNow } from "@/lib/deliveries/runner";
import { unsubscribe } from "@/lib/deliveries/store";
import { caller, privateJson } from "../../notifications/guard";

// Refusals the runner words for the reader, with the status each one means.
const readableFailures = new Map<string, number>([
	["Not found", 404],
	["That dataset is not one you can read.", 403],
	["A user token is required to send this now.", 403],
	["The dataset is no longer available.", 409],
	["The page is no longer there.", 409],
	["The page has no dataset.", 409],
]);

// Stops sending a page.
export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	const removed = await unsubscribe(identity.email, id);
	return removed
		? privateJson({ ok: true })
		: privateJson({ error: "Not found" }, 404);
}

// Sends it now, under the owner's own token, without moving the schedule.
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	try {
		await sendNow(identity, id);
		return privateJson({ ok: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const status = readableFailures.get(message);
		if (status) return privateJson({ error: message }, status);
		// Anything else can be a warehouse or database error carrying schema
		// details, so it is logged rather than returned.
		console.error("Sending a scheduled page failed:", error);
		return privateJson({ error: "Could not send the page" }, 500);
	}
}
