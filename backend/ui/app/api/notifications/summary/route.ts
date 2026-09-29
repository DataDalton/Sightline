import { NextRequest, NextResponse } from "next/server";
import { runAlertsForOwner } from "@/lib/alerts/runner";
import { runDeliveriesForOwner } from "@/lib/deliveries/runner";
import { pushPublicKey } from "@/lib/notify/push";
import { listInbox, unreadCount } from "@/lib/notify/store";
import { settings } from "@/lib/settings";
import { caller, privateJson } from "../guard";

// What the shell polls while the app is open: how many unread, the newest
// entry so a new one can be announced, and whether pushes are on offer.
//
// Also the moment the caller is known to be here with a token, which is when
// their alerts and scheduled pages on datasets that need their own token are
// worked out. See lib/alerts/runner and lib/deliveries/runner.
export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	runAlertsForOwner(identity);
	runDeliveriesForOwner(identity);

	try {
		const [unread, latest, publicKey] = await Promise.all([
			unreadCount(identity.email),
			listInbox(identity.email, { limit: 1 }),
			pushPublicKey().catch(() => null),
		]);
		return privateJson({
			unread,
			latest: latest[0] ?? null,
			pushKey: publicKey,
			alerts: settings().alertsEnabled,
		});
	} catch (error) {
		console.error("Inbox summary failed:", error);
		return privateJson({ error: "Could not load your inbox" }, 500);
	}
}
