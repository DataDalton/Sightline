import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { invalidateAccessCache, isAdmin } from "@/lib/platform/access";
import { invalidateSourceAccess } from "@/lib/auth/sourceAccess";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { insertLog } from "@/lib/activityLog";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { sanitizeSvg } from "@/lib/visuals/svgSanitize";
import {
	maxLogoBytes,
	saveSettings,
	settings,
	writableSettings,
	type WritableSetting,
} from "@/lib/settings";

// Configuration an admin can change without a redeploy.
//
// The point of holding these in a table rather than in the environment is that
// changing one is an operational act, not a deployment: an admin edits it here
// and every replica has it within a refresh interval.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const policy = await resolvePolicyClass(identity);
	if (!isAdmin(policy)) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	const current = settings();
	const values: Record<string, unknown> = {};
	for (const key of writableSettings) values[key] = current[key];

	return NextResponse.json({ settings: values, maxLogoBytes });
}

export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const policy = await resolvePolicyClass(identity);
	if (!isAdmin(policy)) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	try {
		const body = await request.json();
		const changes: Partial<Record<WritableSetting, unknown>> = {};

		for (const key of writableSettings) {
			if (!(key in body)) continue;
			changes[key] = body[key];
		}

		if (Object.keys(changes).length === 0) {
			return NextResponse.json(
				{ error: "Nothing to change" },
				{ status: 400 },
			);
		}

		const logo = changes.appLogo;
		if (typeof logo === "string" && logo !== "") {
			// SVG only, and rebuilt from an allow-list before it is stored.
			//
			// The mark goes into the document of every page so it can take its
			// colour from the theme, which also means an uploaded file is
			// markup this application will execute. A raster image would be
			// safer and could not follow the theme; sanitising is what buys
			// both.
			if (Buffer.byteLength(logo, "utf-8") > maxLogoBytes) {
				return NextResponse.json(
					{
						error: `That file is too large. The limit is ${Math.round(
							maxLogoBytes / 1024,
						)}KB, and an SVG mark is normally a few.`,
					},
					{ status: 400 },
				);
			}

			const adaptive =
				"appLogoAdaptive" in changes
					? changes.appLogoAdaptive !== false
					: settings().appLogoAdaptive;

			const cleaned = sanitizeSvg(logo, { adaptive });
			if (!cleaned) {
				return NextResponse.json(
					{
						error: "That file is not an SVG. Marks are SVG so they stay sharp at any size and can follow the light and dark themes.",
					},
					{ status: 400 },
				);
			}

			changes.appLogo = cleaned.markup;
		}

		const next = await saveSettings(changes, identity.email);

		// Reachability is memoised per reader, so a change to where it comes
		// from would otherwise take a cache lifetime to appear and read as the
		// setting not working.
		if ("accessModel" in changes) {
			invalidateAccessCache();
			invalidateSourceAccess();
		}

		// Recorded field by field, because "who changed the admin groups and
		// when" is exactly the question an access review asks.
		for (const key of Object.keys(changes) as WritableSetting[]) {
			void insertLog({
				recordType: "platform_settings",
				recordId: key,
				action: "update_setting",
				changedBy: identity.email,
				fieldName: key,
				// A logo is thousands of characters of base64 and says nothing
				// useful in an audit trail.
				newValue:
					key === "appLogo"
						? `${String(changes[key] ?? "").length} bytes`
						: String(changes[key] ?? ""),
			});
		}

		const values: Record<string, unknown> = {};
		for (const key of writableSettings) values[key] = next[key];
		return NextResponse.json({ settings: values });
	} catch (error) {
		console.error("Settings update failed:", error);
		return NextResponse.json({ error: "Could not save" }, { status: 500 });
	}
}
