// Assigns a canvas position to visuals that were seeded before the editor
// existed.
//
// Every seeded visual carries the column defaults, so they all sit at the
// origin and overlap. That is invisible in the reader view, which lays visuals
// out in flow, and immediately visible in the editor, which honours the stored
// position.
//
// Positions are derived from sort order, which is the order the planning
// documents listed them in, so a page opens looking like the page it describes.

import { connect } from "./connect.mjs";
const GRID = 12;

// Footprint per visual type, matching lib/visuals/catalog.ts. Duplicated here
// rather than imported because this is a plain script and the catalogue is
// TypeScript; the two are checked against each other by the count printed at
// the end.
const footprints = {
	kpiRow: { w: 12, h: 2 },
	gauge: { w: 3, h: 4 },
	barChart: { w: 6, h: 5 },
	horizontalBarChart: { w: 6, h: 5 },
	comboChart: { w: 6, h: 5 },
	lineChart: { w: 6, h: 5 },
	areaChart: { w: 6, h: 5 },
	waterfallChart: { w: 6, h: 5 },
	pieChart: { w: 4, h: 5 },
	donutChart: { w: 4, h: 5 },
	treemapChart: { w: 6, h: 5 },
	funnelChart: { w: 4, h: 5 },
	stackedBarChart: { w: 6, h: 5 },
	scatterChart: { w: 6, h: 5 },
	heatmapChart: { w: 6, h: 5 },
	heatmap: { w: 6, h: 5 },
	radarChart: { w: 4, h: 5 },
	table: { w: 12, h: 6 },
	matrixTable: { w: 12, h: 6 },
	definitionList: { w: 4, h: 4 },
	entityHeader: { w: 12, h: 2 },
	textPanel: { w: 4, h: 2 },
	blockedNotice: { w: 12, h: 2 },
	// Shell controls render nothing on the canvas, so they take the smallest
	// footprint rather than reserving space for an empty frame.
	filterBar: { w: 12, h: 1 },
	dimensionSwitch: { w: 3, h: 1 },
	periodSwitch: { w: 3, h: 1 },
	thresholdControl: { w: 3, h: 1 },
	fieldExplorer: { w: 4, h: 1 },
	dropdownFilter: { w: 3, h: 1 },
	searchFilter: { w: 4, h: 1 },
	bulkFilter: { w: 3, h: 2 },
	dateRangeFilter: { w: 4, h: 1 },
	numericRangeFilter: { w: 3, h: 1 },
};

const client = await connect();

try {
	const pages = await client.query(
		`SELECT DISTINCT page_id FROM report_visuals WHERE is_active = TRUE`,
	);

	let moved = 0;
	let unknownTypes = new Set();

	for (const { page_id } of pages.rows) {
		const visuals = await client.query(
			`SELECT visual_id, visual_type, layout_x, layout_y, layout_w, layout_h
			 FROM report_visuals
			 WHERE page_id = $1 AND is_active = TRUE
			 ORDER BY sort_order`,
			[page_id],
		);

		// Only visuals still sitting at the origin are placed. A page where
		// someone has already arranged something keeps that arrangement, and
		// the unplaced visuals flow in below it rather than the whole page
		// being reset.
		const placed = visuals.rows.filter(
			(v) => v.layout_x !== 0 || v.layout_y !== 0,
		);
		const unplaced = visuals.rows.filter(
			(v) => v.layout_x === 0 && v.layout_y === 0,
		);
		if (unplaced.length === 0) continue;

		let x = 0;
		let y = 0;
		let rowHeight = 0;

		const collides = (rx, ry, rw, rh) =>
			placed.some(
				(p) =>
					rx < p.layout_x + p.layout_w &&
					rx + rw > p.layout_x &&
					ry < p.layout_y + p.layout_h &&
					ry + rh > p.layout_y,
			);

		for (const visual of unplaced) {
			const footprint = footprints[visual.visual_type];
			if (!footprint) unknownTypes.add(visual.visual_type);
			const w = Math.min(footprint?.w ?? 6, GRID);
			const h = footprint?.h ?? 4;

			// Wrap to the next row when the visual will not fit beside what is
			// already there.
			if (x + w > GRID) {
				x = 0;
				y += rowHeight;
				rowHeight = 0;
			}

			// Step past anything already arranged rather than landing on top
			// of it.
			let guard = 0;
			while (collides(x, y, w, h) && guard++ < 200) {
				x += 1;
				if (x + w > GRID) {
					x = 0;
					y += 1;
				}
			}

			await client.query(
				`UPDATE report_visuals
				 SET layout_x = $2, layout_y = $3, layout_w = $4, layout_h = $5
				 WHERE visual_id = $1`,
				[visual.visual_id, x, y, w, h],
			);

			x += w;
			rowHeight = Math.max(rowHeight, h);
			moved++;
		}
	}

	console.log(`placed ${moved} visuals across ${pages.rows.length} pages`);
	if (unknownTypes.size > 0) {
		// A type here means the catalogue and this script have drifted, which
		// is worth seeing rather than silently defaulting.
		console.log(
			"types with no known footprint (defaulted to 6x4):",
			Array.from(unknownTypes).join(", "),
		);
	}
} finally {
	await client.end();
}

