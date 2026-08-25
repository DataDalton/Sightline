// Closes empty rows left in a page's arrangement.
//
// Page controls used to be placed on the grid like any other visual. They are
// not any more: a reader sees them in a strip above the content, so the editor
// shows them the same way. What they left behind is a band of empty rows at the
// top of every page that had one, which is the gap between the control and the
// first visual that has no reason to be there.
//
// Only whole empty rows are closed. Nothing moves sideways, and two visuals
// that share a row keep sharing it, because that is an arrangement somebody
// made rather than a gap.

import { connect } from "./connect.mjs";
const dryRun = process.argv.includes("--dry-run");
const client = await connect();

// The control types, which is the list the app treats as page chrome.
const controlTypes = new Set([
	"dropdownFilter",
	"searchFilter",
	"bulkFilter",
	"dateRangeFilter",
	"numericRangeFilter",
	"filterBar",
	"thresholdControl",
	"dimensionSwitch",
	"periodSwitch",
]);

try {
	const pages = await client.query(
		`SELECT p.page_id, p.title, r.slug
		 FROM report_pages p JOIN reports r ON r.report_id = p.report_id
		 WHERE p.is_active = TRUE
		 ORDER BY r.slug, p.sort_order`,
	);

	let changed = 0;

	for (const page of pages.rows) {
		const visuals = await client.query(
			`SELECT visual_id, visual_type, layout_x, layout_y, layout_h
			 FROM report_visuals
			 WHERE page_id = $1 AND is_active = TRUE
			 ORDER BY layout_y, layout_x`,
			[page.page_id],
		);

		const placed = visuals.rows.filter((v) => !controlTypes.has(v.visual_type));
		if (placed.length === 0) continue;

		const occupied = new Set();
		for (const v of placed) {
			for (let y = v.layout_y; y < v.layout_y + v.layout_h; y++) occupied.add(y);
		}

		const maxRow = Math.max(...placed.map((v) => v.layout_y + v.layout_h));
		const shift = new Map();
		let removed = 0;
		for (let y = 0; y <= maxRow; y++) {
			if (!occupied.has(y)) {
				removed++;
				continue;
			}
			shift.set(y, removed);
		}

		const moves = placed
			.map((v) => ({ v, by: shift.get(v.layout_y) ?? 0 }))
			.filter((m) => m.by > 0);

		if (moves.length === 0) continue;
		changed++;
		console.log(
			`  ${page.slug}/${page.title}: ${moves.length} of ${placed.length} pulled up`,
		);

		if (dryRun) continue;
		for (const move of moves) {
			await client.query(
				`UPDATE report_visuals SET layout_y = $2 WHERE visual_id = $1`,
				[move.v.visual_id, move.v.layout_y - move.by],
			);
		}
	}

	console.log(`\n${changed} pages ${dryRun ? "would be" : ""} adjusted`);
	if (dryRun) console.log("dry run, nothing written");
} finally {
	await client.end();
}

