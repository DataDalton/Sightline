import { sql } from "../data/lakebase";
import type { LatenessSetting } from "../freshness/arrivals";
import type { Identity } from "../auth/identity";
import { insertLog } from "../activityLog";
import { runCatalogQuery } from "./ucMetadata";
import { syncSourceFields } from "./fieldSync";
import { syncSourceMetadata } from "./ucMetadata";
import { loadRegistry } from "./registry";
import { lateStandingChanged } from "../freshness/status";
import { isValidObjectName } from "./types";

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
	// Protection asked for by hand. Detection turns protection on by itself
	// when the catalogue shows a row filter or column mask, so this is only
	// for forcing it on where detection cannot see one. See
	// lib/semantic/protection.
	hasRowFilter?: boolean;
	// How long an answer from this source may be held. Zero, the default,
	// means the platform setting decides. Only a source that genuinely differs
	// from the rest sets its own, because any positive number here wins over
	// the platform setting and makes that setting unreachable for it.
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
	// These names are written into warehouse SQL wherever the source is read,
	// so anything outside the plain identifier set is refused here.
	for (const name of [input.catalog, input.schema, input.object]) {
		if (!isValidObjectName(name)) {
			throw new RegistrationError(
				`${String(name).slice(0, 100)} is not a name this platform can register. Use letters, digits, underscores and hyphens.`,
			);
		}
	}

	const sourceKey = (
		input.sourceKey ?? sourceKeyFor(input.schema, input.object)
	)
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "_");

	// The same key is only the same source when all three parts match. The
	// key leaves the catalogue out, so comparing the object alone let a
	// registration of the same table in another catalogue re-point every
	// report on the key at it, and answers cached from the old table would go
	// on being served under the new one.
	const clash = await sql<{
		source_key: string;
		catalog_name: string;
		schema_name: string;
		object_name: string;
	}>(
		`SELECT source_key, catalog_name, schema_name, object_name
		 FROM data_sources WHERE source_key = $1`,
		[sourceKey],
	);
	const held = clash[0];
	if (
		held &&
		(held.catalog_name !== input.catalog ||
			held.schema_name !== input.schema ||
			held.object_name !== input.object)
	) {
		throw new RegistrationError(
			`Another source already uses the key ${sourceKey}. Give this one a different key.`,
		);
	}

	await sql(
		`INSERT INTO data_sources
		   (source_key, title, description, catalog_name, schema_name,
		    object_name, kind, access_mode, has_row_filter, row_filter_forced,
		    cache_ttl_seconds, created_by, modified_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,'direct',$8,$8,$9,$10,$10)
		 ON CONFLICT (source_key) DO UPDATE SET
		   title = EXCLUDED.title,
		   description = EXCLUDED.description,
		   catalog_name = EXCLUDED.catalog_name,
		   schema_name = EXCLUDED.schema_name,
		   object_name = EXCLUDED.object_name,
		   kind = EXCLUDED.kind,
		   -- Registering again never lowers protection. Only detection
		   -- confirming there is nothing to protect does that.
		   has_row_filter = data_sources.has_row_filter
		                    OR EXCLUDED.has_row_filter,
		   row_filter_forced = EXCLUDED.row_filter_forced,
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
			// Zero rather than a number, so a newly registered source follows
			// the platform setting instead of pinning itself to whatever that
			// setting happened to be on the day it was registered.
			Math.max(0, Math.floor(input.cacheTtlSeconds ?? 0)),
			identity.email,
		],
	);

	// Under the caller's token, so the columns discovered are the ones they can
	// see. A table they cannot read registers with nothing in it and says so.
	// The same pass asks the catalogue for row filters and column masks, so
	// protection is on before the first answer is cached.
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
		 WHERE source_key = $1 AND is_active = TRUE AND status = 'active'
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
	// A page or a visual can name a source of its own, so a report built on
	// another source can still read this one.
	const used = await sql<{ count: string }>(
		`SELECT count(*)::text AS count FROM reports r
		 WHERE r.is_active = TRUE
		   AND (r.source_key = $1
		        OR EXISTS (
		          SELECT 1 FROM report_pages p
		          WHERE p.report_id = r.report_id AND p.is_active = TRUE
		            AND (p.source_key = $1
		                 OR EXISTS (
		                   SELECT 1 FROM report_visuals v
		                   WHERE v.page_id = p.page_id AND v.is_active = TRUE
		                     AND v.source_key = $1))))`,
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
	// Whether the data streams in. See isLive in lib/semantic/types.
	isLive?: boolean;
	// How lateness is judged: learned, off, or set by hand. See
	// lib/freshness/arrivals.
	lateness?: LatenessSetting;
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
			   AND field_kind = 'dimension' AND status = 'active'`,
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
		   description = CASE WHEN $8 THEN $3 ELSE description END,
		   default_time_field = CASE WHEN $9 THEN $4 ELSE default_time_field END,
		   cache_ttl_seconds = COALESCE($5, cache_ttl_seconds),
		   is_live = COALESCE($6, is_live),
		   lateness = COALESCE($7::jsonb, lateness),
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
			input.isLive ?? null,
			input.lateness ? JSON.stringify(input.lateness) : null,
			// Present with a null value means cleared, and absent means left
			// as it is. COALESCE could not tell the two apart, so neither
			// could ever be emptied once set.
			input.description !== undefined,
			input.defaultTimeField !== undefined,
		],
	);
	if (updated.length === 0) {
		throw new RegistrationError("That source is not registered.");
	}
	// Its title and how its lateness is judged are held with its standing and
	// its load history.
	lateStandingChanged();
	// Judged again straight away, so the setting shows its effect on the
	// screen that changed it rather than a minute later.
	if (input.lateness) {
		const { evaluateLateness } = await import("../freshness/lateness");
		await evaluateLateness(true).catch(() => {});
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
			   display_name = CASE WHEN $6 THEN $3 ELSE display_name END,
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
				// Written only when the edit carries it. An edit to the
				// description alone leaves the display name out, and that is
				// not the same as blanking it.
				edit.displayName !== undefined,
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
