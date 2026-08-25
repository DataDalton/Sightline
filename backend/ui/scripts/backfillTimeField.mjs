// Sets each source's default time field.
//
// The data-through stamp reads this when a page has not nominated a column of
// its own, so with it unset the stamp never appears and every page would have
// to be configured by hand. Nothing else in the seed filled it in.
//
// A pipeline timestamp wins where one exists, because it answers the question
// exactly: it is when the row was written. Otherwise the first date-typed
// dimension is taken, since a metric view lists dimensions in the order its
// author wrote them and the grain date is conventionally first.
//
// A validity window is never chosen. A contract start or end date says when an
// agreement runs, not when the data was last true, and a stamp reading "data
// through 2029" from a contract expiry would be worse than no stamp. A source
// whose only dates are windows is left unset, and a page owner who knows
// better sets one in the page settings.

import { connect } from "./connect.mjs";
const dryRun = process.argv.includes("--dry-run");
const client = await connect();

try {
	const sources = await client.query(
		`SELECT source_key FROM data_sources
		 WHERE default_time_field IS NULL AND is_active = TRUE
		 ORDER BY source_key`,
	);

	for (const source of sources.rows) {
		const candidates = await client.query(
			`SELECT field_name, data_type FROM source_fields
			 WHERE source_key = $1 AND field_kind = 'dimension' AND is_active = TRUE
			   AND (data_type LIKE 'date%' OR data_type LIKE 'timestamp%')
			 ORDER BY sort_order`,
			[source.source_key],
		);

		// Ordered by preference rather than by position alone.
		const isPipelineStamp = (name) =>
			/timestamp$|_ts$|load|ingest|refresh|updated|update_date/i.test(name);
		const isValidityWindow = (name) =>
			/start date|end date|expiration|expiry|due date|effective/i.test(name);

		const chosen =
			candidates.rows.find((r) => isPipelineStamp(r.field_name)) ??
			candidates.rows.find((r) => !isValidityWindow(r.field_name));
		if (!chosen) {
			console.log(
				`  ${source.source_key.padEnd(42)} no column means "when this was true", skipped`,
			);
			continue;
		}

		console.log(
			`  ${source.source_key.padEnd(42)} ${chosen.field_name} (${chosen.data_type})`,
		);
		if (dryRun) continue;
		await client.query(
			`UPDATE data_sources SET default_time_field = $2, modified_on = now()
			 WHERE source_key = $1`,
			[source.source_key, chosen.field_name],
		);
	}

	if (dryRun) console.log("\ndry run, nothing written");
} finally {
	await client.end();
}

