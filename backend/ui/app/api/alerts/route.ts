import { NextRequest, NextResponse } from "next/server";
import { AlertDefinitionError } from "@/lib/alerts/rule";
import { createAlert, listAlerts } from "@/lib/alerts/store";
import { settings } from "@/lib/settings";
import { caller, privateJson, readJson } from "../notifications/guard";

// The caller's alerts: listed, or one more added.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	if (!settings().alertsEnabled) {
		return privateJson({ alerts: [], enabled: false });
	}
	try {
		return privateJson({
			alerts: await listAlerts(identity.email),
			enabled: true,
		});
	} catch (error) {
		console.error("Alert list failed:", error);
		return privateJson({ error: "Could not load your alerts" }, 500);
	}
}

export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	if (!settings().alertsEnabled) {
		return privateJson({ error: "Alerts are turned off." }, 409);
	}
	try {
		const alert = await createAlert(identity, await readJson(request));
		return privateJson({ alert });
	} catch (error) {
		if (error instanceof AlertDefinitionError) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("Alert create failed:", error);
		return privateJson({ error: "Could not save the alert" }, 500);
	}
}
