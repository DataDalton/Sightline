import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import { parseMetricViewFields } from "./metricViewDefinition";
import { parseMetricViewCalculations } from "./metricViewCalculations";
import { readColumns, runCatalogQuery } from "./ucMetadata";
import { defaultTableExpr, quotedRef } from "./types";
import {
	detectRenames,
	type FieldPrint,
	type RenameCandidate,
} from "./renames";
import { refreshProtection, type ProtectionResult } from "./detectProtection";

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
// Nothing is deleted. A field the source no longer publishes is marked missing,
// which keeps its labels and takes it out of the pickers and the query builder,
// and is reported so an admin can decide what to do with the items naming it.
// If it comes back it is simply active again.
//
// What each field looked like is kept as a fingerprint, so when one field goes
// and another arrives in the same sync the pair can be offered as a rename.
// See renames.ts. Nothing is renamed without somebody confirming it.
//
// Every sync also asks the catalogue whether the source carries a row filter
// or a column mask. See detectProtection.ts.

export interface FieldSyncResult {
	sourceKey: string;
	kind: string;
	// Fields the source publishes right now.
	discovered: number;
	added: string[];
	// Registered as one kind, published as the other. Corrected, because the
	// query it produces would otherwise be wrong rather than merely stale.
	reclassified: string[];
	// Registered here but no longer published, whether this sync or an
	// earlier one found it gone. Kept, marked missing, reported.
	missing: string[];
	// Found missing by this sync.
	newlyMissing: string[];
	// Missing before and published again now.
	returned: string[];
	// Likely renames among what went missing and what arrived.
	renames: RenameCandidate[];
	protection: ProtectionResult | null;
	error?: string;
}

interface DiscoveredField {
	name: string;
	kind: "dimension" | "measure";
	dataType: string | null;
	description: string | null;
	sortOrder: number;
	// The metric view expression, where there is one.
	expression: string | null;
}

// What a sync keeps of a field to recognise it by after its name changes.
interface Fingerprint {
	kind: "dimension" | "measure";
	dataType: string | null;
	comment: string | null;
	ordinal: number;
	expression: string | null;
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
		.map((w) =>
			w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
		)
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
				isNumericType(column.dataType) &&
				!isIdentifierLike(column.columnName);
			return {
				name: column.columnName,
				kind: measure ? ("measure" as const) : ("dimension" as const),
				dataType: column.dataType,
				description: column.comment,
				sortOrder: index,
				expression: null,
			};
		});
	}

	const rows = await runCatalogQuery(
		identity,
		`SHOW CREATE TABLE ${quotedRef(catalog, schema, object)}`,
	);
	const statement = String(Object.values(rows[0] ?? {})[0] ?? "");
	const { dimensions, measures } = parseMetricViewFields(statement);

	if (dimensions.length === 0 && measures.length === 0) {
		throw new Error("The view definition listed no dimensions or measures");
	}

	// Expressions are evidence for recognising a rename and nothing else, so
	// a definition they cannot be read from still syncs its fields.
	let expressions = new Map<string, { expr: string }>();
	try {
		expressions = parseMetricViewCalculations(statement).fields;
	} catch {
		// Renames on this view are judged without the expression.
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
				expression: expressions.get(name)?.expr ?? null,
			});
		}
	}
	return fields;
}

function emptyResult(
	sourceKey: string,
	kind: string,
	error: string,
	protection: ProtectionResult | null = null,
): FieldSyncResult {
	return {
		sourceKey,
		kind,
		discovered: 0,
		added: [],
		reclassified: [],
		missing: [],
		newlyMissing: [],
		returned: [],
		renames: [],
		protection,
		error,
	};
}

interface ExistingRow {
	field_name: string;
	field_kind: string;
	sql_expr: string | null;
	status: string;
	data_type: string | null;
	description: string | null;
	sort_order: number;
	fingerprint: Partial<Fingerprint> | null;
	renamed_to: string | null;
}

// What a field looked like before it went missing. Rows registered before
// fingerprints were kept fall back to their own columns, which say less but
// are what there is.
function printOfExisting(row: ExistingRow): FieldPrint {
	const held = row.fingerprint ?? {};
	return {
		name: row.field_name,
		kind: row.field_kind === "measure" ? "measure" : "dimension",
		dataType: held.dataType ?? row.data_type,
		comment: held.comment ?? row.description,
		ordinal:
			typeof held.ordinal === "number" ? held.ordinal : row.sort_order,
		expression: held.expression ?? null,
	};
}

function printOfDiscovered(field: DiscoveredField): FieldPrint {
	return {
		name: field.name,
		kind: field.kind,
		dataType: field.dataType,
		comment: field.description,
		ordinal: field.sortOrder,
		expression: field.expression,
	};
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
		return emptyResult(sourceKey, "unknown", "Source is not registered");
	}

	// Asked whether or not the fields can be read, since a source whose
	// columns are hidden from this reader can still show a filter or mask.
	const protection = await refreshProtection(identity, sourceKey).catch(
		(error) => {
			console.warn(`Protection check failed for ${sourceKey}:`, error);
			return null;
		},
	);

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
		return emptyResult(
			sourceKey,
			source.kind,
			error instanceof Error ? error.message : "Field discovery failed",
			protection,
		);
	}

	// No columns at all is what a reader without access to the object sees,
	// not a description of the object. Taking it at its word would mark every
	// field missing.
	if (fields.length === 0) {
		return emptyResult(
			sourceKey,
			source.kind,
			"The source listed no fields. The reader may not have access to it.",
			protection,
		);
	}

	const existing = await sql<ExistingRow>(
		`SELECT field_name, field_kind, sql_expr, status, data_type,
		        description, sort_order, fingerprint, renamed_to
		 FROM source_fields WHERE source_key = $1`,
		[sourceKey],
	);
	const existingByName = new Map(existing.map((f) => [f.field_name, f]));

	const added: string[] = [];
	const reclassified: string[] = [];
	const returned: string[] = [];

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
						: defaultTableExpr(field.name, field.kind),
					field.dataType,
					field.description,
					formatHintFor(field.name, field.kind),
					field.sortOrder,
				],
			);
			added.push(field.name);
			continue;
		}

		if (known.field_kind !== field.kind) {
			// A table field still carrying the expression registration wrote
			// for its old kind takes the one for its new kind. A measure read
			// as a bare column sits in the SELECT of an aggregating query
			// without being grouped, which the warehouse refuses. An
			// expression somebody wrote by hand is left alone.
			const expr =
				source.kind !== "metric_view" &&
				known.sql_expr ===
					defaultTableExpr(field.name, known.field_kind)
					? defaultTableExpr(field.name, field.kind)
					: known.sql_expr;
			await sql(
				`UPDATE source_fields
				 SET field_kind = $3, sql_expr = $4, modified_on = now()
				 WHERE source_key = $1 AND field_name = $2`,
				[sourceKey, field.name, field.kind, expr],
			);
			reclassified.push(field.name);
		}

		if (known.status === "missing") returned.push(field.name);
	}

	// A field that came back is an ordinary field again. Whatever was said
	// about it while it was gone no longer applies.
	if (returned.length > 0) {
		await sql(
			`UPDATE source_fields
			 SET status = 'active', missing_since = NULL, renamed_to = NULL,
			     rename_candidate = NULL, rename_confidence = NULL,
			     announced_on = NULL, modified_on = now()
			 WHERE source_key = $1 AND field_name = ANY($2::text[])`,
			[sourceKey, returned],
		);
	}

	// What every published field looks like now, in one statement. Only
	// published fields are written, so a missing field keeps the fingerprint
	// it had when it was last seen, which is what a rename is judged by.
	await sql(
		`UPDATE source_fields AS f
		 SET fingerprint = x.fp
		 FROM jsonb_to_recordset($2::jsonb) AS x(name text, fp jsonb)
		 WHERE f.source_key = $1 AND f.field_name = x.name
		   AND f.fingerprint IS DISTINCT FROM x.fp`,
		[
			sourceKey,
			JSON.stringify(
				fields.map((field) => ({
					name: field.name,
					fp: {
						kind: field.kind,
						dataType: field.dataType,
						comment: field.description,
						ordinal: field.sortOrder,
						expression: field.expression,
					} satisfies Fingerprint,
				})),
			),
		],
	);

	const published = new Set(fields.map((f) => f.name));
	const gone = existing.filter((f) => !published.has(f.field_name));
	const newlyMissing = gone
		.filter((f) => f.status !== "missing")
		.map((f) => f.field_name);

	if (newlyMissing.length > 0) {
		await sql(
			`UPDATE source_fields
			 SET status = 'missing', missing_since = now(), modified_on = now()
			 WHERE source_key = $1 AND field_name = ANY($2::text[])`,
			[sourceKey, newlyMissing],
		);
	}

	// Offered, never applied. A field already remapped by an administrator
	// has its answer.
	const byName = new Map(fields.map((f) => [f.name, f]));
	const renames = detectRenames(
		gone.filter((f) => !f.renamed_to).map(printOfExisting),
		added
			.map((name) => byName.get(name))
			.filter((f): f is DiscoveredField => Boolean(f))
			.map(printOfDiscovered),
	);
	for (const rename of renames) {
		await sql(
			`UPDATE source_fields
			 SET rename_candidate = $3, rename_confidence = $4
			 WHERE source_key = $1 AND field_name = $2`,
			[sourceKey, rename.from, rename.to, rename.confidence],
		);
	}

	await sql(
		`UPDATE data_sources SET fields_synced_on = now() WHERE source_key = $1`,
		[sourceKey],
	);

	// A sync never changes whether a source is active. An inactive source is
	// one somebody unregistered, and registering it again is what restores it.

	return {
		sourceKey,
		kind: source.kind,
		discovered: fields.length,
		added,
		reclassified,
		missing: gone.map((f) => f.field_name),
		newlyMissing,
		returned,
		renames,
		protection,
	};
}

export async function syncAllSourceFields(
	identity: Identity | null,
): Promise<FieldSyncResult[]> {
	const sources = await sql<{ source_key: string }>(
		`SELECT source_key FROM data_sources WHERE is_active
		 ORDER BY source_key`,
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
