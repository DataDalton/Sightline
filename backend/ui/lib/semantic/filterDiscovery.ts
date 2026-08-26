import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import {
	extractFilterGroups,
	mergeFilterGroups,
	parseMetricViewTables,
	type FilterGroups,
} from "./rowFilterGroups";
import { runCatalogQuery } from "./ucMetadata";

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
const ttlMs = 15 * 60 * 1000;

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

async function tablesBehind(
	identity: Identity | null,
	catalog: string,
	schema: string,
	object: string,
	kind: string,
	recorded: string[] | null,
): Promise<string[]> {
	const self = `${catalog}.${schema}.${object}`;

	// A plain table is its own base. A view is not: the filter is on what it
	// reads, so the definition has to be opened to find out what that is.
	if (kind !== "metric_view") return [self];

	// Written down by the last sync, which ran under somebody holding SELECT on
	// the view. Reading it back costs nothing, where opening the definition
	// again costs a few hundred milliseconds and up to 110KB of YAML for a list
	// that only changes when the view does.
	if (recorded && recorded.length > 0) return [self, ...recorded];

	const rows = await runCatalogQuery(identity, `SHOW CREATE TABLE ${self}`);
	const statement = String(Object.values(rows[0] ?? {})[0] ?? "");
	const referenced = parseMetricViewTables(statement);

	// The view itself is included: a filter can be attached to it directly,
	// and a deployment that does that should not be missed.
	return [self, ...referenced];
}

// Walks one source and returns the groups its filters name.
//
// Called by a sync, under the identity of whoever asked for it. That identity
// can see information_schema rows the application cannot, which is the whole
// reason this happens at sync time rather than on a timer.
// The groups the filters on one source name.
//
// Runs under whatever identity is given. The walk passes none, which means the
// application itself: this list decides how cached answers are partitioned, so
// it has to be the same whoever is browsing, and it has to be maintained
// without anybody remembering to ask for it.
export async function discoverSourceGroups(
	identity: Identity | null,
	source: {
		catalog_name: string;
		schema_name: string;
		object_name: string;
		kind: string;
		base_tables: string[] | null;
	},
): Promise<{ groups: FilterGroups; tables: string[] }> {
	const tables = await tablesBehind(
		identity,
		source.catalog_name,
		source.schema_name,
		source.object_name,
		source.kind,
		source.base_tables,
	);

	const parts: FilterGroups[] = [];
	for (const table of tables) {
		const [catalog, schema, name] = table.split(".");
		if (!catalog || !schema || !name) continue;

		const filters = await runCatalogQuery(
			identity,
			`SELECT filter_name
			 FROM ${catalog}.information_schema.row_filters
			 WHERE table_schema = :schema AND table_name = :name`,
			{ schema, name },
		);

		for (const row of filters) {
			const qualified = String(row.filter_name ?? "");
			const segments = qualified.split(".");
			const routineSchema = segments[segments.length - 2];
			const routineName = segments[segments.length - 1];
			if (!routineSchema || !routineName) continue;

			const definitions = await runCatalogQuery(
				identity,
				`SELECT routine_definition
				 FROM ${catalog}.information_schema.routines
				 WHERE routine_schema = :schema AND routine_name = :name`,
				{ schema: routineSchema, name: routineName },
			);

			for (const definition of definitions) {
				parts.push(
					extractFilterGroups(
						String(definition.routine_definition ?? ""),
					),
				);
			}
		}
	}

	return { groups: mergeFilterGroups(parts), tables };
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
	let failureReason: string | null = null;

	for (const source of sources) {
		try {
			const { groups, tables } = await discoverSourceGroups(
				identity,
				source,
			);
			parts.push(groups);

			// Derived rather than read, so keep it for next time.
			if (!source.base_tables && source.kind === "metric_view") {
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
	cachedAt = Date.now();

	if (failureReason) {
		console.warn(
			`Row filter discovery could not read ${unreadable.length} source(s). ` +
				`First failure: ${failureReason}`,
		);
	}

	return cached;
}
