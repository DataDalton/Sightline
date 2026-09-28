import { NextRequest, NextResponse } from "next/server";
import { deliverPush } from "@/lib/notify/push";
import { caller, privateJson } from "../../guard";

// Sends a push to the caller's own devices and nothing to the inbox, so
// somebody can see that a phone is set up without leaving a test entry
// behind.
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	const outcome = await deliverPush(
		identity.email,
		{
			id: `test-${Date.now()}`,
			kind: "system",
			title: "Notifications are working",
			body: "This device will get your alerts and anything shared with you.",
			link: "/inbox/",
		},
		{ force: true },
	);
	return privateJson(outcome);
}
