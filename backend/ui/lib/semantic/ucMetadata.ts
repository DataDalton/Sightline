import { sql } from "../data/lakebase";
import { isDatabricksApp } from "../runtime";
import type { Identity } from "../auth/identity";

// Pulls column descriptions, data types and tags from Unity Catalog into the
// semantic layer.
//
// The comments are already written and maintained next to the data, which is
// where a definition belongs: a measure described in the metric view is the
// same description every other consumer of that view sees. Copying them into
// the app by hand would guarantee they drift.
//
// This refreshes what the seed imported rather than replacing it. A field an
// admin has edited in the app keeps its edit, because the app is where a
// business-facing wording lives when it differs from the technical one.

export interface UcColumn {
	columnName: string;
	dataType: string | null;
	comment: string | null;
	tags: Record<string, string>;
}

export interface SyncResult {
	sourceKey: string;
	columnsSeen: number;
	descriptionsUpdated: number;
	typesUpdated: number;
	tagsUpdated: number;
	error?: string;
}

// Reads information_schema for one object.
//
// Under a caller token when there is one, so a sync somebody runs sees what
// that person can see. Under the application itself when there is not, which is
// how the row filter walk runs: which groups a filter branches on is a property
// of the catalogue rather than of any reader, and asking under whoever happened
// to be browsing would make the answer depend on them.
//
// The application path reads metadata only. The service principal holds BROWSE
// and no SELECT, so it can see that an object exists and read the body of a
// filter, and it cannot read a row.
export async function runCatalogQuery(
	identity: Identity | null,
	statement: string,
	params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
	if (identity?.userToken) {
		const { queryAsUser } = await import("../data/userSession");
		return queryAsUser(identity.userToken, statement, params);
	}
	if (!isDatabricksApp) {
		const { queryLocally } = await import("../data/localSession");
		return queryLocally(statement, params);
	}
	const { queryAsApp } = await import("../data/appSession");
	return queryAsApp(statement, params);
}

export async function readColumns(
	identity: Identity | null,
	catalog: string,
	schema: string,
	object: string,
): Promise<UcColumn[]> {
	const runQuery = (statement: string, params: Record<string, unknown>) =>
		runCatalogQuery(identity, statement, params);

	const columns = await runQuery(
		`SELECT column_name, full_data_type, comment
		 FROM ${catalog}.information_schema.columns
		 WHERE table_schema = :schema AND table_name = :object
		 ORDER BY ordinal_position`,
		{ schema, object },
	);

	// Tags live in a separate view and are frequently empty, so a failure to
	// read them degrades the result rather than failing the sync.
	let tagRows: Record<string, unknown>[] = [];
	try {
		tagRows = await runQuery(
			`SELECT column_name, tag_name, tag_value
			 FROM ${catalog}.information_schema.column_tags
			 WHERE schema_name = :schema AND table_name = :object`,
			{ schema, object },
		);
	} catch {
		// No tag view, or no permission on it. Descriptions still sync.
	}

	const tagsByColumn = new Map<string, Record<string, string>>();
	for (const row of tagRows) {
		const column = String(row.column_name ?? "");
		const name = String(row.tag_name ?? "");
		if (!column || !name) continue;
		const existing = tagsByColumn.get(column) ?? {};
		existing[name] = String(row.tag_value ?? "");
		tagsByColumn.set(column, existing);
	}

	return columns.map((row) => ({
		columnName: String(row.column_name ?? ""),
		dataType: row.full_data_type ? String(row.full_data_type) : null,
		comment: row.comment ? String(row.comment) : null,
		tags: tagsByColumn.get(String(row.column_name ?? "")) ?? {},
	}));
}

// The tables behind a metric view, read from its definition and written down.
//
// Only for a metric view, and only best effort: a sync that cannot open the
// definition still syncs the fields, and the walk falls back to asking for
// itself. Measured at roughly 200 to 400ms and up to 110KB per view, which is
// why it happens here rather than on every walk.
async function recordBaseTables(
	identity: Identity | null,
	source: {
		source_key: string;
		catalog_name: string;
		schema_name: string;
		object_name: string;
		kind: string;
	},
): Promise<void> {
	if (source.kind !== "metric_view") return;

	const self = `${source.catalog_name}.${source.schema_name}.${source.object_name}`;
	try {
		const rows = await runCatalogQuery(
			identity,
			`SHOW CREATE TABLE ${self}`,
		);
		const statement = String(Object.values(rows[0] ?? {})[0] ?? "");
		const { parseMetricViewTables } = await import("./rowFilterGroups");
		const tables = parseMetricViewTables(statement);
		if (tables.length === 0) return;

		await sql(
			`UPDATE data_sources SET base_tables = $2::jsonb WHERE source_key = $1`,
			[source.source_key, JSON.stringify(tables)],
		);
	} catch (error) {
		console.warn(
			`Could not record the tables behind ${self}:`,
			error instanceof Error ? error.message : error,
		);
	}
}

export async function syncSourceMetadata(
	identity: Identity | null,
	sourceKey: string,
): Promise<SyncResult> {
	const rows = await sql<{
		catalog_name: string;
		schema_name: string;
		object_name: string;
		kind: string;
	}>(
		`SELECT catalog_name, schema_name, object_name, kind
		 FROM data_sources WHERE source_key = $1`,
		[sourceKey],
	);
	const source = rows[0];
	if (!source) {
		return {
			sourceKey,
			columnsSeen: 0,
			descriptionsUpdated: 0,
			typesUpdated: 0,
			tagsUpdated: 0,
			error: "Source is not registered",
		};
	}

	let columns: UcColumn[];
	try {
		columns = await readColumns(
			identity,
			source.catalog_name,
			source.schema_name,
			source.object_name,
		);
	} catch (error) {
		return {
			sourceKey,
			columnsSeen: 0,
			descriptionsUpdated: 0,
			typesUpdated: 0,
			tagsUpdated: 0,
			error:
				error instanceof Error ? error.message : "Metadata read failed",
		};
	}

	let descriptionsUpdated = 0;
	let typesUpdated = 0;
	let tagsUpdated = 0;

	for (const column of columns) {
		if (!column.columnName) continue;

		// The data type always comes from the catalogue: it is a fact about
		// the column, not an editorial choice, and it drives how the query
		// builder binds a filter value.
		if (column.dataType) {
			const updated = await sql<{ field_id: string }>(
				`UPDATE source_fields
				 SET data_type = $3, modified_on = now()
				 WHERE source_key = $1 AND field_name = $2
				   AND (data_type IS DISTINCT FROM $3)
				 RETURNING field_id`,
				[sourceKey, column.columnName, column.dataType],
			);
			typesUpdated += updated.length;
		}

		// A description is only filled in where the app has none. An admin who
		// wrote a business-facing wording keeps it; a field nobody has
		// described picks up whatever the catalogue says.
		if (column.comment) {
			const updated = await sql<{ field_id: string }>(
				`UPDATE source_fields
				 SET description = $3, modified_on = now()
				 WHERE source_key = $1 AND field_name = $2
				   AND (description IS NULL OR trim(description) = '')
				 RETURNING field_id`,
				[sourceKey, column.columnName, column.comment],
			);
			descriptionsUpdated += updated.length;
		}

		if (Object.keys(column.tags).length > 0) {
			const updated = await sql<{ field_id: string }>(
				`UPDATE source_fields
				 SET tags = $3::jsonb, modified_on = now()
				 WHERE source_key = $1 AND field_name = $2
				 RETURNING field_id`,
				[sourceKey, column.columnName, JSON.stringify(column.tags)],
			);
			tagsUpdated += updated.length;
		}
	}

	// Recorded here because a sync runs under the identity of whoever asked
	// for it, which is the only one allowed to open a metric view definition.
	await recordBaseTables(identity, { ...source, source_key: sourceKey });

	return {
		sourceKey,
		columnsSeen: columns.length,
		descriptionsUpdated,
		typesUpdated,
		tagsUpdated,
	};
}

export async function syncAllSources(
	identity: Identity | null,
	onProgress?: (completed: number, current: string) => void,
): Promise<SyncResult[]> {
	const sources = await sql<{ source_key: string }>(
		`SELECT source_key FROM data_sources WHERE is_active = TRUE ORDER BY source_key`,
	);

	const results: SyncResult[] = [];
	// Sequential rather than parallel: this is an admin action that runs
	// rarely, and a burst of information_schema queries would compete with
	// the reader-facing traffic for warehouse slots. It also means progress is
	// a real count rather than an estimate.
	for (const source of sources) {
		onProgress?.(results.length, source.source_key);
		results.push(await syncSourceMetadata(identity, source.source_key));
	}
	onProgress?.(results.length, "");
	return results;
}

export async function countActiveSources(): Promise<number> {
	const rows = await sql<{ n: string }>(
		`SELECT count(*)::text AS n FROM data_sources WHERE is_active = TRUE`,
	);
	return Number(rows[0]?.n ?? 0);
}
