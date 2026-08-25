// Stores a logo in the settings table.
//
// The mark compiled into the header used to be one company's wordmark. It is
// a generic glyph now, because a trademark has no business in a repository
// other people read and because a deployment should be able to look like
// itself without editing source.
//
// So the mark is data. This puts a file into the settings row the header
// reads, which is the same thing the administration page does with an upload;
// this exists so an install can be scripted rather than clicked.
//
// Usage:  node scripts/setLogo.mjs path/to/logo.svg
//         node scripts/setLogo.mjs path/to/logo.svg --keep-colours
//         node scripts/setLogo.mjs --clear

import { readFile } from "node:fs/promises";
import { connect } from "./connect.mjs";
import { sanitizeSvg } from "./svgSanitize.mjs";

// The same ceiling the administration page enforces. Every replica reads this
// row on a timer, so weight here is paid for continuously rather than once.
const maxBytes = 64 * 1024;

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
// Colours give way to the surrounding text by default, so one file works in
// both themes. A mark with fixed brand colours keeps them with --keep-colours.
const adaptive = !args.includes("--keep-colours");

if (!input && !args.includes("--clear")) {
	console.error(
		"Usage: node scripts/setLogo.mjs <file.svg> [--keep-colours]\n" +
			"       node scripts/setLogo.mjs --clear",
	);
	process.exit(1);
}

let markup = "";

if (!args.includes("--clear")) {
	if (!input.toLowerCase().endsWith(".svg")) {
		console.error(
			"Marks are SVG. A raster image cannot stay sharp at every size or " +
				"follow the light and dark themes.",
		);
		process.exit(1);
	}

	const file = await readFile(input, "utf-8");
	if (Buffer.byteLength(file, "utf-8") > maxBytes) {
		console.error(
			`That file is ${Math.round(Buffer.byteLength(file, "utf-8") / 1024)}KB, ` +
				`over the ${Math.round(maxBytes / 1024)}KB limit.`,
		);
		process.exit(1);
	}

	// Rebuilt from an allow-list, because this markup ends up in the document
	// of every page. Writing straight to the table would otherwise be a way
	// around the checks the upload form makes.
	const cleaned = sanitizeSvg(file, { adaptive });
	if (!cleaned) {
		console.error("That file is not an SVG this can read.");
		process.exit(1);
	}

	markup = cleaned.markup;
	if (cleaned.removedElements.length > 0) {
		console.log(`  dropped elements: ${cleaned.removedElements.join(", ")}`);
	}
	if (cleaned.removedAttributes.length > 0) {
		console.log(`  dropped attributes: ${cleaned.removedAttributes.join(", ")}`);
	}
}

const client = await connect();

try {
	await client.query(
		`INSERT INTO platform_settings (setting_key, setting_value, modified_by, modified_on)
		 VALUES ('appLogo', $1, $2, now())
		 ON CONFLICT (setting_key) DO UPDATE SET
		   setting_value = EXCLUDED.setting_value,
		   modified_by = EXCLUDED.modified_by,
		   modified_on = now()`,
		[markup, process.env.PGUSER ?? "setLogo.mjs"],
	);

	await client.query(
		`INSERT INTO platform_settings (setting_key, setting_value, modified_by, modified_on)
		 VALUES ('appLogoAdaptive', $1, $2, now())
		 ON CONFLICT (setting_key) DO UPDATE SET
		   setting_value = EXCLUDED.setting_value,
		   modified_on = now()`,
		[String(adaptive), process.env.PGUSER ?? "setLogo.mjs"],
	);

	console.log(
		markup
			? `Logo set, ${Math.round(Buffer.byteLength(markup, "utf-8") / 1024)}KB, ` +
					`${adaptive ? "following the theme" : "keeping its own colours"}. ` +
					"Replicas pick it up within a minute."
			: "Logo cleared. The built-in mark is shown instead.",
	);
} finally {
	await client.end();
}
