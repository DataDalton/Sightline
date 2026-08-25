import { NextResponse } from "next/server";
import { appIdentity, isDatabricksApp } from "@/lib/runtime";
import { settings, settingsLoadedAt } from "@/lib/settings";
import { registryLoadedAt } from "@/lib/semantic/registry";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

export async function GET() {
	await ensureReadyOrDegrade();

	const current = settings();
	return NextResponse.json({
		name: current.appName,
		description: current.appDescription,
		// Sanitised SVG markup, or null when no mark has been set and the
		// header shows the one built into it. Rebuilt from an allow-list when
		// it was stored, which is what makes it safe to put in the document.
		logo: current.appLogo || null,
		instance: appIdentity.name,
		hosted: isDatabricksApp,
		settingsLoadedAt: settingsLoadedAt() || null,
		registryLoadedAt: registryLoadedAt() || null,
	});
}
