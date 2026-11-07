import { NextRequest, NextResponse } from "next/server";
import { refusedUnless } from "@/lib/platform/capabilityGuard";
import { resolvePolicyClass } from "@/lib/auth/policy";
import {
	DeliveryError,
	listDeliveries,
	subscribe,
} from "@/lib/deliveries/store";
import { settings } from "@/lib/settings";
import { caller, privateJson, readJson } from "../notifications/guard";

// The pages somebody has asked to be sent on a schedule. See lib/deliveries.
// Turned off along with alerts, since they share the same runner and rules.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	if (!settings().alertsEnabled) {
		return privateJson({ deliveries: [], enabled: false });
	}
	try {
		return privateJson({
			deliveries: await listDeliveries(identity.email),
			enabled: true,
		});
	} catch (error) {
		console.error("Scheduled page list failed:", error);
		return privateJson(
			{ error: "Could not load your scheduled pages" },
			500,
		);
	}
}

// { reportSlug, pageId, schedule: { frequency, hour, weekday, timeZone } }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const refused = await refusedUnless(identity, "schedule.create");
	if (refused) return refused;
	if (!settings().alertsEnabled) {
		return privateJson({ error: "Scheduled pages are turned off." }, 409);
	}
	try {
		const body = (await readJson(request)) as Record<string, unknown>;
		const policy = await resolvePolicyClass(identity);
		const delivery = await subscribe(identity, policy, {
			reportSlug: String(body.reportSlug ?? ""),
			pageId: String(body.pageId ?? ""),
			schedule: body.schedule,
			attachPdf: body.attachPdf === true,
		});
		return privateJson({ delivery });
	} catch (error) {
		if (error instanceof DeliveryError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Scheduling a page failed:", error);
		return privateJson({ error: "Could not schedule the page" }, 500);
	}
}
