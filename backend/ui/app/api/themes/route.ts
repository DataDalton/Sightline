import { NextRequest, NextResponse } from "next/server";
import { insertLog } from "@/lib/activityLog";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { canDo } from "@/lib/platform/access";
import { saveSettings, settings } from "@/lib/settings";
import { caller, privateJson, readJson } from "../notifications/guard";

// The themes Editors can apply, kept by whoever holds the right to make them. Anyone can
// read the list through /api/info, since every report may be drawn in one.

async function allowed(identity: Parameters<typeof canDo>[1]) {
	const policy = await resolvePolicyClass(identity);
	return canDo(policy, identity, "theme.manage");
}

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	if (!(await allowed(identity))) {
		return privateJson({ error: "Not found" }, 404);
	}
	return privateJson({ customThemes: settings().customThemes ?? "" });
}

// { customThemes }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	if (!(await allowed(identity))) {
		return privateJson({ error: "Not found" }, 404);
	}
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const customThemes = String(body.customThemes ?? "");
	try {
		await saveSettings({ customThemes }, identity.email);
		await insertLog({
			recordType: "platform_settings",
			recordId: "customThemes",
			action: "update_setting",
			changedBy: identity.email,
			fieldName: "customThemes",
			newValue: customThemes,
		});
		return privateJson({ customThemes });
	} catch (error) {
		console.error("Could not save themes:", error);
		return privateJson({ error: "Could not save" }, 500);
	}
}
