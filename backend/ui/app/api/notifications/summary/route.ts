import { NextRequest, NextResponse } from "next/server";
import { runAlertsForOwner } from "@/lib/alerts/runner";
import { runDeliveriesForOwner } from "@/lib/deliveries/runner";
import { pushPublicKey } from "@/lib/notify/push";
import { inboxSummary } from "@/lib/notify/store";
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
		const [summary, publicKey] = await Promise.all([
			inboxSummary(identity.email),
			pushPublicKey().catch(() => null),
		]);
		return privateJson({
			unread: summary.unread,
			latest: summary.latest,
			pushKey: publicKey,
			alerts: settings().alertsEnabled,
		});
	} catch (error) {
		console.error("Inbox summary failed:", error);
		return privateJson({ error: "Could not load your inbox" }, 500);
	}
}
