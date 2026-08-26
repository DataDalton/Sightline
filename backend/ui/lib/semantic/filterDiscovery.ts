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
): Promise<string[]> {
	const self = `${catalog}.${schema}.${object}`;

	// A plain table is its own base. A view is not: the filter is on what it
	// reads, so the definition has to be opened to find out what that is.
	if (kind !== "metric_view") return [self];

	const rows = await runCatalogQuery(identity, `SHOW CREATE TABLE ${self}`);
	const statement = String(Object.values(rows[0] ?? {})[0] ?? "");
	const referenced = parseMetricViewTables(statement);

	// The view itself is included: a filter can be attached to it directly,
	// and a deployment that does that should not be missed.
	return [self, ...referenced];
}

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
	}>(
		`SELECT source_key, catalog_name, schema_name, object_name, kind
		 FROM data_sources
		 WHERE is_active = TRUE AND has_row_filter = TRUE`,
	);

	const parts: FilterGroups[] = [];
	const unreadable: string[] = [];
	const seenTables = new Set<string>();

	for (const source of sources) {
		let tables: string[];
		try {
			tables = await tablesBehind(
				identity,
				source.catalog_name,
				source.schema_name,
				source.object_name,
				source.kind,
			);
		} catch {
			unreadable.push(source.source_key);
			continue;
		}

		for (const table of tables) {
			if (seenTables.has(table)) continue;
			seenTables.add(table);

			const [catalog, schema, name] = table.split(".");
			if (!catalog || !schema || !name) continue;

			try {
				// The filter attached to the table, and the body of the
				// function it names. Two lookups because information_schema
				// records the attachment and the definition separately.
				const filters = await runCatalogQuery(
					identity,
					`SELECT filter_name
					 FROM ${catalog}.information_schema.row_filters
					 WHERE table_schema = :schema AND table_name = :name`,
					{ schema, name },
				);

				for (const row of filters) {
					const qualified = String(row.filter_name ?? "");
					const parts_ = qualified.split(".");
					const routineSchema = parts_[parts_.length - 2];
					const routineName = parts_[parts_.length - 1];
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
			} catch {
				// A catalogue this identity cannot read is reported rather
				// than treated as having no filters, which would be the
				// dangerous reading.
				unreadable.push(table);
			}
		}
	}

	cached = { ...mergeFilterGroups(parts), unreadableSources: unreadable };
	cachedAt = Date.now();
	return cached;
}
