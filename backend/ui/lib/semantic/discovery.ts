import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import { insertLog } from "../activityLog";
import { runCatalogQuery } from "./ucMetadata";
import { syncSourceFields } from "./fieldSync";
import { syncSourceMetadata } from "./ucMetadata";
import { loadRegistry } from "./registry";

// Finding tables in Unity Catalog and registering one as a source.
//
// Everything else in the platform is built on a source: a visual reads one, a
// page groups visuals that read one, a report groups pages. Until now a source
// could only be created by writing SQL against data_sources by hand, so a fresh
// installation pointed at a catalogue full of tables had nothing to build on
// and no way in the application to change that.
//
// Browsing runs under the caller's own token, so an administrator sees the
// catalogues, schemas and tables they can see and no more. Registering does not
// grant anybody anything: reachability still comes from Unity Catalog when a
// query runs, so registering a table only means the platform knows it exists.

export interface CatalogObject {
	name: string;
	kind: "metric_view" | "table";
	comment: string | null;
	// True when a source already points at this object.
	registered: boolean;
}

function text(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

export async function listCatalogs(identity: Identity): Promise<string[]> {
	const rows = await runCatalogQuery(identity, "SHOW CATALOGS");
	return (
		rows
			.map((r) => text(r.catalog ?? r.catalog_name ?? r.databaseName))
			.filter(Boolean)
			// system holds the catalogue's own metadata rather than anything worth
			// reporting on.
			.filter((name) => name !== "system")
			.sort()
	);
}

export async function listSchemas(
	identity: Identity,
	catalog: string,
): Promise<string[]> {
	const rows = await runCatalogQuery(
		identity,
		`SELECT schema_name FROM ${quoted(catalog)}.information_schema.schemata
		 ORDER BY schema_name`,
	);
	return rows
		.map((r) => text(r.schema_name))
		.filter(Boolean)
		.filter((name) => name !== "information_schema");
}

// Backticked, because a catalogue or schema name can carry a hyphen and cannot
// be a bound parameter: it is part of the object being addressed rather than a
// value in a predicate. Backticks inside the name are doubled, which is how
// Databricks escapes them, so a crafted name closes nothing.
function quoted(name: string): string {
	return "`" + name.replace(/`/g, "``") + "`";
}

export async function listObjects(
	identity: Identity,
	catalog: string,
	schema: string,
): Promise<CatalogObject[]> {
	const rows = await runCatalogQuery(
		identity,
		`SELECT table_name, table_type, comment
		 FROM ${quoted(catalog)}.information_schema.tables
		 WHERE table_schema = :schema
		 ORDER BY table_name`,
		{ schema },
	);

	const registered = await sql<{ object_name: string }>(
		`SELECT object_name FROM data_sources
		 WHERE catalog_name = $1 AND schema_name = $2 AND is_active = TRUE`,
		[catalog, schema],
	);
	const taken = new Set(registered.map((r) => r.object_name));

	return rows.map((row) => {
		const name = text(row.table_name);
		const type = text(row.table_type).toUpperCase();
		return {
			name,
			// A metric view owns its own aggregation, which changes how the
			// query builder addresses its fields. Everything else is read as a
			// table, including an ordinary view.
			kind: type.includes("METRIC") ? "metric_view" : "table",
			comment: row.comment ? text(row.comment) : null,
			registered: taken.has(name),
		};
	});
}

// A key is used in a report definition and in a cache key, so it is derived
// once and never changes.
export function sourceKeyFor(schema: string, object: string): string {
	const clean = (value: string) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "");
	const key = `${clean(schema)}_${clean(object)}`.slice(0, 120);
	return key || clean(object) || "source";
}

export class RegistrationError extends Error {}

export interface RegisterInput {
	catalog: string;
	schema: string;
	object: string;
	kind: "metric_view" | "table";
	title: string;
	description?: string | null;
	sourceKey?: string;
	// Whether Unity Catalog applies a row filter or column mask. Decides
	// whether an answer may be shared beyond one policy class, so it is asked
	// rather than assumed.
	hasRowFilter?: boolean;
	cacheTtlSeconds?: number;
}

export interface RegisterResult {
	sourceKey: string;
	dimensions: number;
	measures: number;
	warning: string | null;
}

// Registers an object and reads its fields.
//
// The row and the fields land together. A source with no fields is one that
// looks registered and cannot be built on, which is worse than a failure that
// says so.
export async function registerSource(
	identity: Identity,
	input: RegisterInput,
): Promise<RegisterResult> {
	const title = input.title.trim();
	if (!title) throw new RegistrationError("A name is required.");
	if (!input.catalog || !input.schema || !input.object) {
		throw new RegistrationError("Choose a table to register.");
	}

	const sourceKey = (
		input.sourceKey ?? sourceKeyFor(input.schema, input.object)
	)
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "_");

	const clash = await sql<{ source_key: string; object_name: string }>(
		`SELECT source_key, object_name FROM data_sources WHERE source_key = $1`,
		[sourceKey],
	);
	if (clash.length > 0 && clash[0].object_name !== input.object) {
		throw new RegistrationError(
			`Another source already uses the key ${sourceKey}. Give this one a different key.`,
		);
	}

	await sql(
		`INSERT INTO data_sources
		   (source_key, title, description, catalog_name, schema_name,
		    object_name, kind, access_mode, has_row_filter, cache_ttl_seconds,
		    created_by, modified_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,'direct',$8,$9,$10,$10)
		 ON CONFLICT (source_key) DO UPDATE SET
		   title = EXCLUDED.title,
		   description = EXCLUDED.description,
		   catalog_name = EXCLUDED.catalog_name,
		   schema_name = EXCLUDED.schema_name,
		   object_name = EXCLUDED.object_name,
		   kind = EXCLUDED.kind,
		   has_row_filter = EXCLUDED.has_row_filter,
		   cache_ttl_seconds = EXCLUDED.cache_ttl_seconds,
		   is_active = TRUE,
		   modified_by = EXCLUDED.modified_by,
		   modified_on = now()`,
		[
			sourceKey,
			title.slice(0, 200),
			input.description ?? null,
			input.catalog,
			input.schema,
			input.object,
			input.kind,
			input.hasRowFilter === true,
			input.cacheTtlSeconds ?? 300,
			identity.email,
		],
	);

	// Under the caller's token, so the columns discovered are the ones they can
	// see. A table they cannot read registers with nothing in it and says so.
	const fields = await syncSourceFields(identity, sourceKey);
	await syncSourceMetadata(identity, sourceKey).catch(() => {
		// Descriptions and tags are decoration. A source without them is
		// usable; one without fields is not, which is what is checked below.
	});

	await insertLog({
		recordType: "source",
		recordId: sourceKey,
		action: "register_source",
		changedBy: identity.email,
		newValue: `${input.catalog}.${input.schema}.${input.object}`,
	});

	// So the source is queryable on the next request rather than after the
	// registry's next poll.
	await loadRegistry(true);

	// Counted from what actually landed rather than from what the sync
	// reported, because the sync reports what it saw and this reports what is
	// there to build on.
	const stored = await sql<{ field_kind: string; count: string }>(
		`SELECT field_kind, count(*)::text AS count
		 FROM source_fields
		 WHERE source_key = $1 AND is_active = TRUE
		 GROUP BY field_kind`,
		[sourceKey],
	);
	const counted = (kind: string) =>
		Number(stored.find((r) => r.field_kind === kind)?.count ?? 0);
	const dimensions = counted("dimension");
	const measures = counted("measure");

	return {
		sourceKey,
		dimensions,
		measures,
		warning:
			fields.error ??
			(dimensions + measures === 0
				? "No columns could be read. Check that you have SELECT on this table."
				: measures === 0
					? "No numeric columns were found, so there is nothing to total. Charts and scorecards need at least one measure."
					: null),
	};
}

export async function deactivateSource(
	identity: Identity,
	sourceKey: string,
): Promise<void> {
	const used = await sql<{ count: string }>(
		`SELECT count(*)::text AS count FROM reports
		 WHERE source_key = $1 AND is_active = TRUE`,
		[sourceKey],
	);
	if (Number(used[0]?.count ?? 0) > 0) {
		throw new RegistrationError(
			"Reports are built on this source. Remove them first.",
		);
	}

	await sql(
		`UPDATE data_sources SET is_active = FALSE WHERE source_key = $1`,
		[sourceKey],
	);
	await insertLog({
		recordType: "source",
		recordId: sourceKey,
		action: "remove_source",
		changedBy: identity.email,
	});
	await loadRegistry(true);
}

// --- Editing what was registered --------------------------------------------

// Correcting the presentation of a source and its fields.
//
// Registration and deactivation were the only two operations, so everything a
// report author saw came out of the catalogue verbatim. A column named badly
// upstream was a field named badly in every visual built on it, permanently,
// and the only fix was in Unity Catalog.
//
// Presentation only. Nothing here changes what is queried: the field name is
// the key a stored report refers to, and renaming that would break every
// visual that names it. The display name, the description and the format hint
// are labels, so they are safe to own here.

export interface SourceEdit {
	title?: string;
	description?: string | null;
	defaultTimeField?: string | null;
	// How long an answer from this source is reused. Zero means the source has
	// no opinion and the platform setting decides.
	cacheTtlSeconds?: number;
}

export async function updateSource(
	identity: Identity,
	sourceKey: string,
	input: SourceEdit,
): Promise<void> {
	const title = input.title?.trim();
	if (title !== undefined && !title) {
		throw new RegistrationError("A title is required.");
	}

	if (input.defaultTimeField) {
		const field = await sql<{ field_name: string }>(
			`SELECT field_name FROM source_fields
			 WHERE source_key = $1 AND field_name = $2
			   AND field_kind = 'dimension'`,
			[sourceKey, input.defaultTimeField],
		);
		if (field.length === 0) {
			throw new RegistrationError(
				"That source has no dimension by that name.",
			);
		}
	}

	const updated = await sql<{ source_key: string }>(
		`UPDATE data_sources SET
		   title = COALESCE($2, title),
		   description = COALESCE($3, description),
		   default_time_field = COALESCE($4, default_time_field),
		   cache_ttl_seconds = COALESCE($5, cache_ttl_seconds),
		   modified_on = now()
		 WHERE source_key = $1 AND is_active = TRUE
		 RETURNING source_key`,
		[
			sourceKey,
			title?.slice(0, 200) ?? null,
			input.description ?? null,
			input.defaultTimeField ?? null,
			input.cacheTtlSeconds === undefined
				? null
				: Math.max(0, Math.floor(input.cacheTtlSeconds)),
		],
	);
	if (updated.length === 0) {
		throw new RegistrationError("That source is not registered.");
	}

	await insertLog({
		recordType: "source",
		recordId: sourceKey,
		action: "update_source",
		changedBy: identity.email,
		newValue: title ?? null,
	});

	await loadRegistry(true);
}

export interface FieldEdit {
	fieldName: string;
	displayName?: string | null;
	description?: string | null;
	formatHint?: string | null;
}

// Labels for one source's fields, written in one statement per field.
//
// A sync rewrites what it discovered and leaves these alone, so a correction
// made here survives the next catalogue walk. See fieldSync for the columns it
// does and does not touch.
export async function updateSourceFields(
	identity: Identity,
	sourceKey: string,
	edits: FieldEdit[],
): Promise<number> {
	if (edits.length === 0) return 0;

	let changed = 0;
	for (const edit of edits) {
		const rows = await sql<{ field_id: string }>(
			`UPDATE source_fields SET
			   display_name = $3,
			   description = COALESCE($4, description),
			   format_hint = COALESCE($5, format_hint)
			 WHERE source_key = $1 AND field_name = $2
			 RETURNING field_id::text AS field_id`,
			[
				sourceKey,
				edit.fieldName,
				// Cleared rather than defaulted when it is blanked: emptying a
				// display name is how somebody says the key was fine as it was.
				edit.displayName?.trim() || null,
				edit.description ?? null,
				edit.formatHint ?? null,
			],
		);
		changed += rows.length;
	}

	await insertLog({
		recordType: "source",
		recordId: sourceKey,
		action: "update_source_fields",
		changedBy: identity.email,
		newValue: edits.map((e) => e.fieldName).join(","),
	});

	await loadRegistry(true);
	return changed;
}
