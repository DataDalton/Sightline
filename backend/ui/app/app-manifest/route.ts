import { settings } from "@/lib/settings";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";

// The web app manifest, which is what lets a phone or a desktop browser
// install the app as its own window with its own icon.
//
// Served from a route rather than a file, because the name is the one an
// administrator set under branding and can change without a release.
export async function GET() {
	await ensureReadyOrDegrade();
	const current = settings();
	const name = current.appName || "Sightline";

	// The launcher shows fifteen characters or so under the icon. A longer
	// name gives its longest word, which is the one most likely to be the
	// name rather than a qualifier in front of it.
	const shortName =
		name.length <= 15
			? name
			: name
					.split(/\s+/)
					.reduce((a, b) => (b.length > a.length ? b : a), "")
					.slice(0, 15);

	const shortcuts = [
		{ name: "Explore", url: "/explore/" },
		{ name: "Sheets", url: "/sheets/" },
		{ name: "Inbox", url: "/inbox/" },
		...(current.alertsEnabled ? [{ name: "Alerts", url: "/alerts/" }] : []),
		...(current.assistantEndpoint || current.assistantEndpointUrl
			? [{ name: "Assistant", url: "/assist/" }]
			: []),
	].map((s) => ({
		...s,
		icons: [{ src: "/app-icon/icon-192.png", sizes: "192x192" }],
	}));

	const manifest = {
		id: "/",
		name,
		short_name: shortName,
		description: current.appDescription || "Analytics and reporting",
		start_url: "/",
		scope: "/",
		display: "standalone",
		orientation: "any",
		// The chrome colour, so the title bar and the splash screen match the
		// header the app opens to.
		theme_color: "#16181d",
		background_color: "#16181d",
		categories: ["business", "productivity"],
		icons: [
			{
				src: "/app-icon/icon-192.png",
				sizes: "192x192",
				type: "image/png",
			},
			{
				src: "/app-icon/icon-512.png",
				sizes: "512x512",
				type: "image/png",
			},
			{
				src: "/app-icon/maskable-512.png",
				sizes: "512x512",
				type: "image/png",
				purpose: "maskable",
			},
		],
		shortcuts,
	};

	return new Response(JSON.stringify(manifest), {
		headers: {
			"Content-Type": "application/manifest+json",
			"Cache-Control": "private, max-age=300",
		},
	});
}
