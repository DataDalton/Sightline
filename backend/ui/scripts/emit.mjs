// Copies the compiled pure modules into scripts/ so the maintenance scripts
// can import them.
//
// The scripts are plain JavaScript and the platform is TypeScript, and the
// alternative to this is a second copy of the visual catalogue and the SVG
// sanitiser that drifts from the real one. The importer validates against the
// same catalogue the editor reads, which is the point.

import { readFileSync, writeFileSync } from "node:fs";

const header = (name) =>
	`// Generated from lib/visuals/${name}.ts by "npm run build:scripts". Do not edit.\n`;

for (const name of ["svgSanitize", "catalog"]) {
	writeFileSync(
		`scripts/${name}.mjs`,
		header(name) + readFileSync(`.script-build/${name}.js`, "utf-8"),
	);
	console.log(`scripts/${name}.mjs`);
}
