import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import { parseMetricViewFields } from "./metricViewDefinition";
import { readColumns, runCatalogQuery } from "./ucMetadata";

// Discovers fields a source publishes and registers the ones the app does not
// know about yet.
//
// The metadata sync in ucMetadata refreshes fields that already exist. It
// cannot see a column added after the seed ran, so a measure published to a
// metric view stays invisible to every report until it is registered here.
//
// The kind split matters and cannot be guessed. information_schema lists a
// metric view's dimensions and measures side by side with no marker saying
// which is which, and calling a measure a dimension would put it in a GROUP BY
// and change what the query means. The view's own YAML definition carries the
// split, and SHOW CREATE TABLE returns that definition, so it is read from
// there.
//
// Nothing is deleted. A field the source no longer publishes is reported so an
// admin can decide, because a report may still reference it and removing the
// registration silently would change what that report shows.

export interface FieldSyncResult {
	sourceKey: string;
	kind: string;
	// Fields the source publishes right now.
	discovered: number;
	added: string[];
	// Registered as one kind, published as the other. Corrected, because the
	// query it produces would otherwise be wrong rather than merely stale.
	reclassified: string[];
	// Registered here but no longer published. Left in place, reported.
	missing: string[];
	error?: string;
}

interface DiscoveredField {
	name: string;
	kind: "dimension" | "measure";
	dataType: string | null;
	description: string | null;
	sortOrder: number;
}

// A display hint so a measure renders as currency rather than a bare number.
// Inferred from the name, which is all a newly discovered field offers.
function formatHintFor(name: string, kind: "dimension" | "measure"): string {
	const n = name.toLowerCase();
	if (n.endsWith(" pct") || n.includes("percent") || n.includes(" rate"))
		return "percent";
	if (
		n.includes("sales") ||
		n.includes("amount") ||
		n.includes("revenue") ||
		n.includes("due") ||
		n.includes("paid") ||
		n.includes("price") ||
		n.includes("cost") ||
		n.includes("margin") ||
		n.includes("freight") ||
		n.includes("exposure")
	)
		return "currency";
	if (n.includes("count") || n.includes("units")) return "integer";
	if (kind === "dimension" && (n.includes("date") || n.endsWith(" start")))
		return "date";
	return kind === "measure" ? "decimal" : "text";
}

// A plain table has no semantic layer, so the kind is inferred. Only an
// additive numeric column becomes a measure: an identifier is numeric too and
// summing one means nothing.
function isIdentifierLike(name: string): boolean {
	return /(_id|id|key|number|num|code|year|month|quarter|day)$/i.test(
		name.replace(/\s+/g, ""),
	);
}

function isNumericType(dataType: string | null): boolean {
	return /^(int|bigint|smallint|tinyint|double|float|decimal|numeric|long)/i.test(
		dataType ?? "",
	);
}

// A readable label from a raw column name, for tables whose columns are not
// already written for a reader.
function toLabel(column: string): string {
	return column
		.replace(/[_-]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.split(" ")
		.filter(Boolean)
		.map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
		.join(" ");
}

async function discoverFields(
	identity: Identity | null,
	catalog: string,
	schema: string,
	object: string,
	kind: string,
): Promise<DiscoveredField[]> {
	const columns = await readColumns(identity, catalog, schema, object);
	const byName = new Map(columns.map((c) => [c.columnName, c]));

	if (kind !== "metric_view") {
		return columns.map((column, index) => {
			const measure =
				isNumericType(column.dataType) && !isIdentifierLike(column.columnName);
			return {
				name: column.columnName,
				kind: measure ? ("measure" as const) : ("dimension" as const),
				dataType: column.dataType,
				description: column.comment,
				sortOrder: index,
			};
		});
	}

	const rows = await runCatalogQuery(
		identity,
		`SHOW CREATE TABLE ${catalog}.${schema}.${object}`,
	);
	const statement = String(Object.values(rows[0] ?? {})[0] ?? "");
	const { dimensions, measures } = parseMetricViewFields(statement);

	if (dimensions.length === 0 && measures.length === 0) {
		throw new Error("The view definition listed no dimensions or measures");
	}

	// The definition decides the order as well as the kind: it is the order an
	// author of the view chose, which groups related fields together in a way
	// alphabetical order does not.
	const fields: DiscoveredField[] = [];
	let sortOrder = 0;
	for (const [names, fieldKind] of [
		[dimensions, "dimension" as const],
		[measures, "measure" as const],
	] as const) {
		for (const name of names) {
			const column = byName.get(name);
			fields.push({
				name,
				kind: fieldKind,
				dataType: column?.dataType ?? null,
				description: column?.comment ?? null,
				sortOrder: sortOrder++,
			});
		}
	}
	return fields;
}

export async function syncSourceFields(
	identity: Identity | null,
	sourceKey: string,
): Promise<FieldSyncResult> {
	const sources = await sql<{
		catalog_name: string;
		schema_name: string;
		object_name: string;
		kind: string;
	}>(
		`SELECT catalog_name, schema_name, object_name, kind
		 FROM data_sources WHERE source_key = $1`,
		[sourceKey],
	);
	const source = sources[0];
	if (!source) {
		return {
			sourceKey,
			kind: "unknown",
			discovered: 0,
			added: [],
			reclassified: [],
			missing: [],
			error: "Source is not registered",
		};
	}

	let fields: DiscoveredField[];
	try {
		fields = await discoverFields(
			identity,
			source.catalog_name,
			source.schema_name,
			source.object_name,
			source.kind,
		);
	} catch (error) {
		return {
			sourceKey,
			kind: source.kind,
			discovered: 0,
			added: [],
			reclassified: [],
			missing: [],
			error: error instanceof Error ? error.message : "Field discovery failed",
		};
	}

	const existing = await sql<{ field_name: string; field_kind: string }>(
		`SELECT field_name, field_kind FROM source_fields WHERE source_key = $1`,
		[sourceKey],
	);
	const existingByName = new Map(existing.map((f) => [f.field_name, f.field_kind]));

	const added: string[] = [];
	const reclassified: string[] = [];

	for (const field of fields) {
		const known = existingByName.get(field.name);
		if (known === undefined) {
			await sql(
				`INSERT INTO source_fields
				   (source_key, field_name, display_name, field_kind, sql_expr,
				    data_type, description, format_hint, sort_order)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
				 ON CONFLICT (source_key, field_name) DO NOTHING`,
				[
					sourceKey,
					field.name,
					// A metric view publishes names already written for a
					// reader, so a label would only repeat the key.
					source.kind === "metric_view" ? null : toLabel(field.name),
					field.kind,
					// A metric view resolves its own expression. Restating one
					// here is how the app drifts from the view.
					source.kind === "metric_view"
						? null
						: field.kind === "measure"
							? `SUM(\`${field.name}\`)`
							: `\`${field.name}\``,
					field.dataType,
					field.description,
					formatHintFor(field.name, field.kind),
					field.sortOrder,
				],
			);
			added.push(field.name);
			continue;
		}

		if (known !== field.kind) {
			await sql(
				`UPDATE source_fields SET field_kind = $3, modified_on = now()
				 WHERE source_key = $1 AND field_name = $2`,
				[sourceKey, field.name, field.kind],
			);
			reclassified.push(field.name);
		}
	}

	const published = new Set(fields.map((f) => f.name));
	const missing = existing
		.map((f) => f.field_name)
		.filter((name) => !published.has(name));

	// A source with fields is queryable. One that had none was inactive, and
	// discovering its fields is what makes it usable.
	if (fields.length > 0) {
		await sql(
			`UPDATE data_sources SET is_active = TRUE, modified_on = now()
			 WHERE source_key = $1 AND is_active = FALSE`,
			[sourceKey],
		);
	}

	return {
		sourceKey,
		kind: source.kind,
		discovered: fields.length,
		added,
		reclassified,
		missing,
	};
}

export async function syncAllSourceFields(
	identity: Identity | null,
): Promise<FieldSyncResult[]> {
	const sources = await sql<{ source_key: string }>(
		`SELECT source_key FROM data_sources ORDER BY source_key`,
	);

	const results: FieldSyncResult[] = [];
	// Sequential, matching the metadata sync: this is a rare admin action and
	// a burst of catalogue reads would compete with reader traffic for
	// warehouse slots.
	for (const source of sources) {
		results.push(await syncSourceFields(identity, source.source_key));
	}
	return results;
}
