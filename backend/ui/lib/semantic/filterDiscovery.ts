import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import {
	extractFilterGroups,
	mergeFilterGroups,
	metricViewSourcesComplete,
	parseMetricViewTables,
	type FilterGroups,
} from "./rowFilterGroups";
import { runCatalogQuery } from "./ucMetadata";
import {
	accessFields,
	filterColumns,
	type FoundFilter,
} from "../alerts/access";
import { parseMetricViewCalculations } from "./metricViewCalculations";
import { getSource } from "./registry";
import { quoteName, quotedRef } from "./types";

// Discovering which groups change what a reader sees.
//
// Read from the catalogue rather than configured, because a configured list is
// a list somebody has to remember to update when a filter changes, and the
// failure when they forget is silent: two readers who see different rows get
// the same policy class, and the second is served the first's cached answer.
//
// A filter sits on a base table rather than on the view over it, so this walks
// from each registered source to the tables it reads, then to the filters on
// those tables, then to the group names inside them.
//
// Nothing here decides access. Unity Catalog does that, per query, under the
// caller's own token. This decides only how finely cached answers are
// partitioned, which is why a name it misses is a correctness problem and a
// name it invents is merely wasteful.

export interface DiscoveredGroups extends FilterGroups {
	// Sources that could not be inspected, so an operator can see that the
	// discovery is incomplete rather than assume it found everything.
	unreadableSources: string[];
	// Why the first one failed.
	//
	// The walk carries on past a source it cannot open, which is right: one
	// unreadable table should not cost the groups every other filter names. But
	// swallowing the reason as well leaves a list of names and no way to tell a
	// missing privilege from an unreachable warehouse, and those need different
	// people to fix them.
	failureReason: string | null;
}

// Cached because it walks the catalogue, which is slow and changes rarely.
let cached: DiscoveredGroups | null = null;
let cachedAt = 0;
// The walk is expensive and row filters are edited about as often as the
// tables they sit on, which is to say hardly ever. Fifteen minutes meant
// repeating an expensive catalogue read four times an hour to find the same
// answer.
const ttlMs = 60 * 60 * 1000;

// The walk in progress, shared by everyone who asks while it runs.
let walking: Promise<DiscoveredGroups> | null = null;
// A forced walk waiting for the running one to finish.
let queuedWalk: Promise<DiscoveredGroups> | null = null;

export function lastDiscovery(): {
	groups: DiscoveredGroups | null;
	at: number;
} {
	return { groups: cached, at: cachedAt };
}

// Whether the group list can be relied on to partition a cache.
//
// False until a walk has finished, and false again if any source could not be
// opened: a source that was not read contributes no group names, which reads
// identically to a source that has no filter. Anything that would share one
// answer between two readers has to ask this first.
export function filterDiscoveryComplete(): boolean {
	return cached !== null && cached.unreadableSources.length === 0;
}

// Sources the last finished walk read the filters of.
//
// The walk reads only sources marked as filtered when it starts. A source whose
// protection is switched on afterwards has groups no policy class is built
// from yet, so a complete walk still says nothing about it.
let covered = new Set<string>();

// Whether the group list partitions a cache correctly for this one source.
// True only when the last walk finished cleanly and read this source.
export function filterDiscoveryCovers(sourceKey: string): boolean {
	return filterDiscoveryComplete() && covered.has(sourceKey);
}

async function tablesBehind(
	identity: Identity | null,
	catalog: string,
	schema: string,
	object: string,
	kind: string,
	recorded: string[] | null,
): Promise<{ tables: string[]; complete: boolean }> {
	const self = `${catalog}.${schema}.${object}`;

	// A plain table is its own base. A view is not: the filter is on what it
	// reads, so the definition has to be opened to find out what that is.
	if (kind !== "metric_view") return { tables: [self], complete: true };

	// Written down by the last sync, which ran under somebody holding SELECT on
	// the view. Reading it back costs nothing, where opening the definition
	// again costs a few hundred milliseconds and up to 110KB of YAML for a list
	// that only changes when the view does. Only a list read from a view whose
	// every source was a table is ever written down.
	if (recorded && recorded.length > 0) {
		return { tables: [self, ...recorded], complete: true };
	}

	const rows = await runCatalogQuery(
		identity,
		`SHOW CREATE TABLE ${quotedRef(catalog, schema, object)}`,
	);
	const statement = String(Object.values(rows[0] ?? {})[0] ?? "");
	const referenced = parseMetricViewTables(statement);

	// The view itself is included: a filter can be attached to it directly,
	// and a deployment that does that should not be missed.
	return {
		tables: [self, ...referenced],
		complete: metricViewSourcesComplete(statement),
	};
}

// The groups one filter or mask routine names, or null when its definition
// could not be read. The routine can live in another catalogue than the table
// it is attached to, so the catalogue is taken from its own qualified name.
async function routineGroups(
	identity: Identity | null,
	tableCatalog: string,
	qualified: string,
): Promise<FilterGroups | null> {
	const segments = qualified.split(".");
	const routineName = segments[segments.length - 1];
	const routineSchema = segments[segments.length - 2];
	const routineCatalog = segments[segments.length - 3] || tableCatalog;
	if (!routineSchema || !routineName) return null;

	const definitions = await runCatalogQuery(
		identity,
		`SELECT routine_definition
		 FROM ${quoteName(routineCatalog)}.information_schema.routines
		 WHERE routine_schema = :schema AND routine_name = :name`,
		{ schema: routineSchema, name: routineName },
	);
	// No definition is not a definition naming nobody. The groups it tests
	// are unknown, which is not the same as there being none.
	if (definitions.length === 0) return null;

	return mergeFilterGroups(
		definitions.map((definition) =>
			extractFilterGroups(String(definition.routine_definition ?? "")),
		),
	);
}

// Walks one source and returns the groups its filters name.
//
// Runs under whatever identity is given. The walk passes none, which means the
// application itself: this list decides how cached answers are partitioned, so
// it has to be the same whoever is browsing, and it has to be maintained
// without anybody remembering to ask for it.
//
// Masks are read the same way filters are. A mask that shows a column to one
// group and hides it from another splits readers exactly as a filter does, so
// the groups it tests are part of the policy class too.
//
// complete is false when anything that could decide what a reader sees was
// not read: a view source that is not a table, a table name that is not fully
// qualified, or a routine whose definition could not be found. Such a source
// is not covered by the group list, so nothing from it is shared.
export async function discoverSourceGroups(
	identity: Identity | null,
	source: {
		catalog_name: string;
		schema_name: string;
		object_name: string;
		kind: string;
		base_tables: string[] | null;
	},
): Promise<{
	groups: FilterGroups;
	tables: string[];
	filters: FoundFilter[];
	masked: boolean;
	complete: boolean;
}> {
	const behind = await tablesBehind(
		identity,
		source.catalog_name,
		source.schema_name,
		source.object_name,
		source.kind,
		source.base_tables,
	);
	const tables = behind.tables;
	let complete = behind.complete;

	const parts: FilterGroups[] = [];
	const found: FoundFilter[] = [];
	let masked = false;
	for (const table of tables) {
		const [catalog, schema, name] = table.split(".");
		if (!catalog || !schema || !name) {
			complete = false;
			continue;
		}

		const filters = await runCatalogQuery(
			identity,
			`SELECT filter_name, target_columns
			 FROM ${quoteName(catalog)}.information_schema.row_filters
			 WHERE table_schema = :schema AND table_name = :name`,
			{ schema, name },
		);

		// A mask changes what a column holds for one reader, which no
		// restriction on rows can reproduce.
		const masks = await runCatalogQuery(
			identity,
			`SELECT mask_name
			 FROM ${quoteName(catalog)}.information_schema.column_masks
			 WHERE table_schema = :schema AND table_name = :name`,
			{ schema, name },
		);
		if (masks.length > 0) masked = true;

		for (const row of filters) {
			found.push({
				table,
				columns: filterColumns(String(row.target_columns ?? "")),
			});
			const groups = await routineGroups(
				identity,
				catalog,
				String(row.filter_name ?? ""),
			);
			if (groups) parts.push(groups);
			else complete = false;
		}

		for (const row of masks) {
			const groups = await routineGroups(
				identity,
				catalog,
				String(row.mask_name ?? ""),
			);
			if (groups) parts.push(groups);
			else complete = false;
		}
	}

	return {
		groups: mergeFilterGroups(parts),
		tables,
		filters: found,
		masked,
		complete,
	};
}

// Which fields hold what a source's filters decide on, for alerts checked
// while their owner is away. Null when they cannot be mapped exactly.
async function mapAccessFields(
	identity: Identity | null,
	source: {
		source_key: string;
		catalog_name: string;
		schema_name: string;
		object_name: string;
		kind: string;
	},
	filters: FoundFilter[],
): Promise<string[] | null> {
	const registered = getSource(source.source_key);
	if (!registered) return null;

	let view = null;
	if (source.kind === "metric_view") {
		// Read on every walk rather than kept, because a field whose
		// expression moved to another column would otherwise go on being
		// compared against the old one.
		const rows = await runCatalogQuery(
			identity,
			`SHOW CREATE TABLE ${quotedRef(source.catalog_name, source.schema_name, source.object_name)}`,
		);
		view = parseMetricViewCalculations(
			String(Object.values(rows[0] ?? {})[0] ?? ""),
		);
	}

	return accessFields(
		{
			kind: registered.kind,
			catalog: source.catalog_name,
			schema: source.schema_name,
			object: source.object_name,
			dimensions: registered.dimensions,
		},
		filters,
		view,
	);
}

// Which groups the row filters across every source branch on.
//
// Walked by the application, on its own schedule, under its own identity. This
// decides how cached answers are partitioned, so it cannot depend on somebody
// remembering to refresh it: a filter that gains a group between one person
// clicking sync and the next is a filter the cache is no longer honouring.
//
// What is cached is the expensive half. Opening a metric view definition costs
// a few hundred milliseconds and up to 110KB of YAML to yield a handful of
// table names that change when the view changes, so those are written down and
// reused. The filters on those tables are re-read every walk, because that is
// the part that has to stay current.
export async function discoverFilterGroups(
	identity: Identity | null,
	force = false,
): Promise<DiscoveredGroups> {
	if (!force && cached && Date.now() - cachedAt < ttlMs) return cached;

	// One walk at a time, however many callers ask.
	//
	// The memo is only written when the walk finishes, and the walk takes tens
	// of seconds: it opens every filtered source in turn and a metric view
	// definition alone costs a few hundred milliseconds. The registry poll runs
	// every sixty seconds and does not await this, so without a shared promise
	// every poll that lands mid-walk starts another one, on every replica, each
	// issuing the same statements against the same warehouse.
	//
	// A forced walk queues one more walk behind the running one rather than
	// joining it. The running walk chose its sources when it started, so a
	// source switched to filtered since then is not in it, and joining would
	// leave that source uncovered until the next scheduled walk. Every forced
	// caller arriving during one walk shares the same queued walk.
	if (walking) {
		if (!force) return walking;
		if (!queuedWalk) {
			queuedWalk = walking
				.catch(() => undefined)
				.then(() => {
					queuedWalk = null;
					return discoverFilterGroups(identity, true);
				});
		}
		return queuedWalk;
	}

	walking = runWalk(identity).finally(() => {
		walking = null;
	});
	return walking;
}

async function runWalk(identity: Identity | null): Promise<DiscoveredGroups> {
	const sources = await sql<{
		source_key: string;
		catalog_name: string;
		schema_name: string;
		object_name: string;
		kind: string;
		base_tables: string[] | null;
	}>(
		`SELECT source_key, catalog_name, schema_name, object_name, kind,
		        base_tables
		 FROM data_sources
		 WHERE is_active = TRUE AND has_row_filter = TRUE`,
	);

	const parts: FilterGroups[] = [];
	const unreadable: string[] = [];
	const read = new Set<string>();
	let failureReason: string | null = null;

	for (const source of sources) {
		try {
			const { groups, tables, filters, masked, complete } =
				await discoverSourceGroups(identity, source);
			parts.push(groups);
			// Covered only when its groups are the whole story. A source
			// whose filter decides per reader, or whose filters were not all
			// read, is left out, so it is never shared while every other
			// source still is.
			if (complete && !groups.perReader) read.add(source.source_key);

			// Cleared first, so a walk that fails to map a source leaves it
			// on signed-in checks rather than on the last mapping.
			const fields = masked
				? null
				: await mapAccessFields(identity, source, filters).catch(
						() => null,
					);
			await sql(
				`UPDATE data_sources
				 SET access_fields = $2::jsonb, has_column_mask = $3
				 WHERE source_key = $1`,
				[
					source.source_key,
					fields ? JSON.stringify(fields) : null,
					masked,
				],
			).catch(() => {});

			// Derived rather than read, so keep it for next time. Only when
			// every source of the view was a table, or the next walk would
			// take a partial list as the whole of it.
			if (
				complete &&
				!source.base_tables &&
				source.kind === "metric_view"
			) {
				const derived = tables.filter(
					(t) =>
						t !==
						`${source.catalog_name}.${source.schema_name}.${source.object_name}`,
				);
				if (derived.length > 0) {
					await sql(
						`UPDATE data_sources SET base_tables = $2::jsonb
						 WHERE source_key = $1`,
						[source.source_key, JSON.stringify(derived)],
					).catch(() => {});
				}
			}
		} catch (error) {
			// Reported rather than read as having no filters, which would be
			// the dangerous reading: it would let two readers entitled to
			// different rows share one cached answer.
			if (!failureReason) {
				const message =
					error instanceof Error ? error.message : String(error);
				failureReason = message.slice(0, 400);
			}
			unreadable.push(source.source_key);
		}
	}

	cached = {
		...mergeFilterGroups(parts),
		unreadableSources: unreadable,
		failureReason,
	};
	covered = read;
	cachedAt = Date.now();

	if (failureReason) {
		console.warn(
			`Row filter discovery could not read ${unreadable.length} source(s). ` +
				`First failure: ${failureReason}`,
		);
	}

	return cached;
}

// Whether a walk is running now, for the administration page. A walk that is
// under way is why the group list is briefly the previous one.
export function filterDiscoveryRunning(): boolean {
	return walking !== null;
}
