// Repairs visuals whose stored type the app never implemented.
//
// The seed imported slot names straight from the planning documents. Four of
// them named a control that did not exist: the renderer skipped them and the
// editor had no entry to show options for, so an author saw an empty frame and
// a reader saw nothing at all.
//
// Three are now real controls and need no change. The other two are corrected
// here:
//
//   heatmap        renamed to heatmapChart, the type the catalogue publishes.
//                  The renderer already accepted both, but the editor offered
//                  no options for a type it did not know.
//
//   fieldExplorer  became a table. The plan meant "the reader picks the
//                  fields", which is what the field picker on a table already
//                  does, so the explorer was a second name for it.
//
// A period switcher only does something if a visual reads it, so the trend
// visual on those pages is pointed at the grain placeholder. Only where its
// current dimension is one of the options the switch offers, so a chart that
// deliberately sits at a fixed grain is left alone.

import { connect } from "./connect.mjs";
const dryRun = process.argv.includes("--dry-run");

const client = await connect();

try {
	const renamed = await run(
		`UPDATE report_visuals SET visual_type = 'heatmapChart'
		 WHERE visual_type = 'heatmap' RETURNING visual_id`,
	);
	console.log(`heatmap -> heatmapChart: ${renamed.length}`);

	const explorers = await client.query(
		`SELECT visual_id, source_key, config FROM report_visuals
		 WHERE visual_type = 'fieldExplorer'`,
	);
	for (const row of explorers.rows) {
		// A starting set of columns, so the page opens on something rather
		// than on an empty grid the reader has to build from nothing.
		const fields = await client.query(
			`SELECT field_name, field_kind FROM source_fields
			 WHERE source_key = $1 AND is_active = TRUE
			 ORDER BY sort_order`,
			[row.source_key],
		);
		const dimensions = fields.rows
			.filter((f) => f.field_kind === "dimension")
			.slice(0, 4)
			.map((f) => f.field_name);
		const measures = fields.rows
			.filter((f) => f.field_kind === "measure")
			.slice(0, 4)
			.map((f) => f.field_name);

		const config = {
			...row.config,
			dimensions,
			measures,
			options: {
				...(row.config?.options ?? {}),
				note: "Add or remove columns with the field picker above",
			},
		};

		console.log(
			`  fieldExplorer -> table on ${row.source_key}: ${dimensions.length} dimensions, ${measures.length} measures`,
		);
		if (dryRun) continue;
		await client.query(
			`UPDATE report_visuals
			 SET visual_type = 'table', config = $2::jsonb,
			     layout_w = 12, layout_h = 8
			 WHERE visual_id = $1`,
			[row.visual_id, JSON.stringify(config)],
		);
	}

	// Point trend visuals at the grain their page's switcher controls.
	const switches = await client.query(
		`SELECT page_id, config FROM report_visuals
		 WHERE visual_type = 'periodSwitch' AND is_active = TRUE`,
	);
	for (const row of switches.rows) {
		const options = row.config?.dimensions ?? [];
		if (options.length === 0) continue;

		const siblings = await client.query(
			`SELECT visual_id, visual_type, config FROM report_visuals
			 WHERE page_id = $1 AND visual_type <> 'periodSwitch' AND is_active = TRUE`,
			[row.page_id],
		);
		for (const sibling of siblings.rows) {
			const dimensions = sibling.config?.dimensions ?? [];
			if (!dimensions.some((d) => options.includes(d))) continue;

			const next = dimensions.map((d) => (options.includes(d) ? "<grain>" : d));
			console.log(
				`  ${sibling.visual_type}: ${dimensions.join(", ")} -> ${next.join(", ")}`,
			);
			if (dryRun) continue;
			await client.query(
				`UPDATE report_visuals SET config = jsonb_set(config, '{dimensions}', $2::jsonb)
				 WHERE visual_id = $1`,
				[sibling.visual_id, JSON.stringify(next)],
			);
		}
	}

	if (dryRun) console.log("\ndry run, nothing written");
} finally {
	await client.end();
}

async function run(statement) {
	if (dryRun) return [];
	const result = await client.query(statement);
	return result.rows;
}

