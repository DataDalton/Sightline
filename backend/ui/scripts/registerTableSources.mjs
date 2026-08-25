// Registers fields for the plain gold tables.
//
// Six sources in the plan are ordinary tables rather than metric views, so
// field_catalog.json has no entry for them and the seed left them with no
// fields at all. A source with no fields is inactive, which is why the reports
// built on them say the source is not registered.
//
// Columns come from information_schema, which is the only description of a
// plain table that exists. Type decides the kind:
//
//   Numeric columns become measures with an explicit aggregate, because a
//   table has no semantic layer to define one. SUM is the honest default for
//   an additive figure; a count or an average has to be chosen deliberately by
//   an admin afterwards.
//
//   Everything else becomes a dimension.
//
// This is a weaker semantic layer than a metric view provides, and it is
// labelled as such: an admin reviewing these sources should expect to correct
// aggregates rather than trust them.

import { connect, runSql } from "./connect.mjs";
const dryRun = process.argv.includes("--dry-run");

// A measure only makes sense on a numeric column, and only on one that is
// actually additive. Identifiers are numeric but summing them is meaningless,
// so they stay dimensions.
function isIdentifierLike(name) {
	return /(_id|id|key|number|num|code|year|month|quarter|day)$/i.test(
		name.replace(/\s+/g, ""),
	);
}

function isNumeric(dataType) {
	return /^(int|bigint|smallint|tinyint|double|float|decimal|numeric|long)/i.test(
		dataType ?? "",
	);
}

// A readable name from a column name, since these tables have no curated
// labels the way a metric view does.
function toLabel(column) {
	return column
		.replace(/[_-]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.split(" ")
		.filter(Boolean)
		.map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
		.join(" ");
}

const client = await connect();

try {
	const sources = await client.query(
		`SELECT source_key, catalog_name, schema_name, object_name
		 FROM data_sources
		 WHERE kind = 'table' AND is_active = FALSE
		 ORDER BY source_key`,
	);

	if (sources.rows.length === 0) {
		console.log("no unregistered table sources");
	}

	for (const source of sources.rows) {
		const qualified = `${source.catalog_name}.${source.schema_name}.${source.object_name}`;
		let columns;
		try {
			columns = await runSql(
				`SELECT column_name, full_data_type, comment
				 FROM ${source.catalog_name}.information_schema.columns
				 WHERE table_schema = '${source.schema_name}'
				   AND table_name = '${source.object_name}'
				 ORDER BY ordinal_position`,
			);
		} catch (error) {
			// A source the plan named but that does not exist, or that this
			// identity cannot read, is reported and skipped rather than
			// failing the whole run.
			console.log(`  SKIP ${source.source_key}: ${String(error.message).slice(0, 90)}`);
			continue;
		}

		const fields = columns.map((column, index) => {
			const name = String(column.column_name);
			const dataType = String(column.full_data_type ?? "");
			const measure = isNumeric(dataType) && !isIdentifierLike(name);
			return {
				source_key: source.source_key,
				// The raw column name is the key, because a report authored
				// against a plain table refers to its columns by that name.
				// The readable form is carried alongside for display.
				field_name: name,
				display_name: toLabel(name),
				field_kind: measure ? "measure" : "dimension",
				// A table has no semantic layer, so the expression is written
				// here. Quoted because a column name may need it.
				sql_expr: measure ? `SUM(\`${name}\`)` : `\`${name}\``,
				data_type: dataType,
				description: column.comment ? String(column.comment) : null,
				format_hint: measure ? "decimal" : "text",
				sort_order: index,
			};
		});

		const measures = fields.filter((f) => f.field_kind === "measure").length;
		console.log(
			`  ${source.source_key.padEnd(42)} ${fields.length} columns (${measures} measures) from ${qualified}`,
		);

		if (dryRun) continue;

		for (const field of fields) {
			await client.query(
				`INSERT INTO source_fields
				   (source_key, field_name, display_name, field_kind, sql_expr,
				    data_type, description, format_hint, sort_order)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
				 ON CONFLICT (source_key, field_name) DO UPDATE SET
				   display_name = EXCLUDED.display_name,
				   field_kind = EXCLUDED.field_kind,
				   sql_expr = EXCLUDED.sql_expr,
				   data_type = EXCLUDED.data_type,
				   modified_on = now()`,
				[
					field.source_key, field.field_name, field.display_name,
					field.field_kind, field.sql_expr, field.data_type,
					field.description, field.format_hint, field.sort_order,
				],
			);
		}

		// Only activated once it actually has fields, so a source that failed
		// to describe itself stays visibly unavailable rather than appearing
		// to work and then failing every query.
		if (fields.length > 0) {
			await client.query(
				`UPDATE data_sources SET is_active = TRUE, modified_on = now()
				 WHERE source_key = $1`,
				[source.source_key],
			);
		}
	}

	if (dryRun) console.log("\ndry run, nothing written");
} finally {
	await client.end();
}

