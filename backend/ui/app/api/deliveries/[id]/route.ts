import { NextRequest, NextResponse } from "next/server";
import { sendNow } from "@/lib/deliveries/runner";
import { unsubscribe } from "@/lib/deliveries/store";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { caller, privateJson } from "../../notifications/guard";

// Stops sending a page.
export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
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
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { id } = await params;
	try {
		await sendNow(identity, id);
		return privateJson({ ok: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed";
		return privateJson(
			{ error: message },
			message === "Not found"
				? 404
				: message === "That dataset is not one you can read."
					? 403
					: 500,
		);
	}
}
