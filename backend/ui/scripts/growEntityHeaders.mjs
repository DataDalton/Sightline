// Gives entity headers the room they need.
//
// They were seeded two rows tall, which was the right size for the table they
// were being rendered as and the wrong size for the header they are meant to
// be: the attributes wrap onto a second line as soon as there are more than a
// few, and the panel scrolled inside itself.
//
// Anything below on the same page moves down by the difference, so growing the
// header does not park it on top of the next visual.

import { connect } from "./connect.mjs";
const target = 3;
const dryRun = process.argv.includes("--dry-run");
const client = await connect();

try {
	const headers = await client.query(
		`SELECT visual_id, page_id, layout_y, layout_h
		 FROM report_visuals
		 WHERE visual_type = 'entityHeader' AND is_active = TRUE AND layout_h < $1`,
		[target],
	);

	for (const header of headers.rows) {
		const grew = target - header.layout_h;
		const bottom = header.layout_y + header.layout_h;
		console.log(
			`  header on page ${header.page_id}: ${header.layout_h} -> ${target} rows, pushing rows below down by ${grew}`,
		);
		if (dryRun) continue;

		await client.query(
			`UPDATE report_visuals SET layout_h = $2 WHERE visual_id = $1`,
			[header.visual_id, target],
		);
		await client.query(
			`UPDATE report_visuals SET layout_y = layout_y + $3
			 WHERE page_id = $1 AND visual_id <> $2 AND layout_y >= $4`,
			[header.page_id, header.visual_id, grew, bottom],
		);
	}

	console.log(`\n${headers.rows.length} headers ${dryRun ? "would be" : ""} grown`);
	if (dryRun) console.log("dry run, nothing written");
} finally {
	await client.end();
}

