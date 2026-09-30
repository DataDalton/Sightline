import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import { decideProtection, type Detection } from "./protection";
import { parseMetricViewTables } from "./rowFilterGroups";
import { quoteName, quotedRef } from "./types";
import { runCatalogQuery } from "./ucMetadata";

// Asks Unity Catalog whether a source carries a row filter or a column mask,
// and sets its protection flags from the answer. See protection.ts for the
// rule that decides what the answer may change.
//
// A filter or mask sits on a base table rather than on a metric view over it,
// so a metric view is followed to the tables it reads, the same walk the row
// filter group discovery makes.

export interface ProtectionResult {
	hasRowFilter: boolean;
	hasColumnMask: boolean;
	turnedOn: boolean;
	changed: boolean;
	// Why detection could not complete, when it could not.
	error: string | null;
}

interface SourceRow {
	catalog_name: string;
	schema_name: string;
	object_name: string;
	kind: string;
	base_tables: string[] | null;
	has_row_filter: boolean;
	has_column_mask: boolean;
	row_filter_forced: boolean | null;
}

async function tablesFor(
	identity: Identity | null,
	source: SourceRow,
): Promise<{ tables: string[]; complete: boolean }> {
	const self = `${source.catalog_name}.${source.schema_name}.${source.object_name}`;
	if (source.kind !== "metric_view")
		return { tables: [self], complete: true };

	try {
		const rows = await runCatalogQuery(
			identity,
			`SHOW CREATE TABLE ${quotedRef(source.catalog_name, source.schema_name, source.object_name)}`,
		);
		const statement = String(Object.values(rows[0] ?? {})[0] ?? "");
		const tables = parseMetricViewTables(statement);
		if (tables.length > 0)
			return { tables: [self, ...tables], complete: true };
	} catch {
		// Falls back to what the last sync recorded below.
	}

	// The recorded list may be out of date, so it can find protection but
	// never confirm its absence.
	return { tables: [self, ...(source.base_tables ?? [])], complete: false };
}

// Reads the catalogue for one source. Throws only when nothing at all could be
// read, so a partial answer can still turn protection on.
async function detect(
	identity: Identity | null,
	source: SourceRow,
): Promise<{ detection: Detection; error: string | null }> {
	const { tables, complete: tablesKnown } = await tablesFor(identity, source);

	let rowFilter = false;
	let columnMask = false;
	let complete = tablesKnown;
	let error: string | null = tablesKnown
		? null
		: "The tables behind the view could not be read.";
	let readAny = false;

	for (const table of tables) {
		const [catalog, schema, name] = table.split(".");
		if (!catalog || !schema || !name) {
			complete = false;
			continue;
		}
		try {
			// A table the reader cannot see lists no filters, so seeing the
			// table itself is what makes "none found" mean none.
			const [visible, filters, masks] = await Promise.all([
				runCatalogQuery(
					identity,
					`SELECT count(*) AS n
					 FROM ${quoteName(catalog)}.information_schema.tables
					 WHERE table_schema = :schema AND table_name = :name`,
					{ schema, name },
				),
				runCatalogQuery(
					identity,
					`SELECT count(*) AS n
					 FROM ${quoteName(catalog)}.information_schema.row_filters
					 WHERE table_schema = :schema AND table_name = :name`,
					{ schema, name },
				),
				runCatalogQuery(
					identity,
					`SELECT count(*) AS n
					 FROM ${quoteName(catalog)}.information_schema.column_masks
					 WHERE table_schema = :schema AND table_name = :name`,
					{ schema, name },
				),
			]);
			readAny = true;
			if (Number(filters[0]?.n ?? 0) > 0) rowFilter = true;
			if (Number(masks[0]?.n ?? 0) > 0) columnMask = true;
			if (Number(visible[0]?.n ?? 0) === 0) {
				complete = false;
				error ??= `${table} is not visible to the reader.`;
			}
		} catch (failure) {
			complete = false;
			error ??=
				failure instanceof Error
					? failure.message.slice(0, 400)
					: String(failure);
		}
	}

	if (!readAny) {
		throw new Error(error ?? "No table behind the source could be read.");
	}
	return { detection: { rowFilter, columnMask, complete }, error };
}

// Detects and applies. Never throws. A detection that fails leaves the flags
// as they are and records why.
export async function refreshProtection(
	identity: Identity | null,
	sourceKey: string,
): Promise<ProtectionResult | null> {
	const rows = await sql<SourceRow>(
		`SELECT catalog_name, schema_name, object_name, kind, base_tables,
		        has_row_filter, has_column_mask, row_filter_forced
		 FROM data_sources WHERE source_key = $1`,
		[sourceKey],
	).catch(() => [] as SourceRow[]);
	const source = rows[0];
	if (!source) return null;

	const current = {
		hasRowFilter: source.has_row_filter,
		hasColumnMask: source.has_column_mask,
	};
	const forced = source.row_filter_forced === true;

	let detection: Detection | null = null;
	let error: string | null = null;
	try {
		const read = await detect(identity, source);
		detection = read.detection;
		error = read.error;
	} catch (failure) {
		error =
			failure instanceof Error
				? failure.message.slice(0, 400)
				: String(failure);
		console.warn(
			`Could not detect row filters or column masks on ${sourceKey}. ` +
				`Its protection is left as it was. Reason: ${error}`,
		);
	}

	const decision = decideProtection(current, forced, detection);

	try {
		await sql(
			`UPDATE data_sources
			 SET has_row_filter = $2, has_column_mask = $3,
			     protection_checked_on = now(), protection_error = $4
			 WHERE source_key = $1`,
			[
				sourceKey,
				decision.next.hasRowFilter,
				decision.next.hasColumnMask,
				error,
			],
		);
	} catch (failure) {
		console.warn(`Could not record protection for ${sourceKey}:`, failure);
		return {
			...current,
			turnedOn: false,
			changed: false,
			error: "The detected protection could not be saved.",
		};
	}

	if (decision.turnedOn) {
		// Every answer cached so far was stored as shareable, which is exactly
		// what this source's readers must no longer be served.
		const { invalidateSource } = await import("../query/cache");
		await invalidateSource(sourceKey);
		console.warn(
			`${sourceKey} carries a row filter or column mask. Protection is ` +
				"now on and its cached answers were dropped.",
		);
	}

	return {
		...decision.next,
		turnedOn: decision.turnedOn,
		changed: decision.changed,
		error,
	};
}
