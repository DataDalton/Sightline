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
import { claimRun } from "../freshness/claim";
import {
	chunk,
	groupByCatalog,
	pairKey,
	pairPredicate,
	routineRef,
	splitTable,
	type NameRef,
} from "./catalogBatch";
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
//
// One replica walks for all of them. Its result is kept in filter_walks with
// when the walk started and finished, and every other replica takes it from
// there. A replica holding no walk, or only one older than another replica's,
// behaves exactly as it does while its own walk is unfinished.

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
// When the walk behind it finished, on this replica's clock.
let cachedAt = 0;
// When the walk behind it started, on the platform store's clock, so a walk
// kept by another replica can be told apart as newer or older.
let cachedStartedOn: string | null = null;
// The walk is expensive and row filters are edited about as often as the
// tables they sit on, which is to say hardly ever. Fifteen minutes meant
// repeating an expensive catalogue read four times an hour to find the same
// answer.
const ttlMs = 60 * 60 * 1000;

// How long one replica's claim to walk holds. Long enough for a walk to
// finish, short enough that a replica stopped part way through is replaced.
const walkHoldSeconds = 10 * 60;

// How many sources have their definitions read at once, and how many pairs
// one information_schema statement asks about.
const sourceWorkers = 3;
const pairsPerStatement = 50;

// The walk in progress, shared by everyone who asks while it runs.
let walking: Promise<DiscoveredGroups | null> | null = null;
// A forced walk waiting for the running one to finish.
let queuedWalk: Promise<DiscoveredGroups | null> | null = null;

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

interface SourceRow {
	source_key: string;
	catalog_name: string;
	schema_name: string;
	object_name: string;
	kind: string;
	base_tables: string[] | null;
}

async function tablesBehind(
	identity: Identity | null,
	source: SourceRow,
): Promise<{ tables: string[]; complete: boolean }> {
	const { catalog_name: catalog, schema_name: schema } = source;
	const object = source.object_name;
	const self = `${catalog}.${schema}.${object}`;

	// A plain table is its own base. A view is not: the filter is on what it
	// reads, so the definition has to be opened to find out what that is.
	if (source.kind !== "metric_view") {
		return { tables: [self], complete: true };
	}

	// Written down by the last sync, which ran under somebody holding SELECT on
	// the view. Reading it back costs nothing, where opening the definition
	// again costs a round trip and a large YAML document for a list that only
	// changes when the view does. Only a list read from a view whose every
	// source was a table is ever written down.
	const recorded = source.base_tables;
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

// Runs the work for each item, a few at a time.
async function eachLimited<T>(
	items: T[],
	limit: number,
	work: (item: T) => Promise<void>,
): Promise<void> {
	const queue = [...items];
	await Promise.all(
		Array.from({ length: Math.min(limit, queue.length) }, async () => {
			for (let item = queue.shift(); item; item = queue.shift()) {
				await work(item);
			}
		}),
	);
}

function message(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		400,
	);
}

// Rows of one information_schema view for many schema and name pairs of one
// catalogue, keyed by pair. Asked in a few statements however many pairs
// there are.
async function readByPairs(
	identity: Identity | null,
	catalog: string,
	pairs: { schema: string; name: string }[],
	view: string,
	schemaColumn: string,
	nameColumn: string,
	columns: string,
): Promise<Map<string, Record<string, unknown>[]>> {
	const out = new Map<string, Record<string, unknown>[]>();
	for (const part of chunk(pairs, pairsPerStatement)) {
		const { clause, params } = pairPredicate(
			part,
			schemaColumn,
			nameColumn,
		);
		const rows = await runCatalogQuery(
			identity,
			`SELECT ${schemaColumn}, ${nameColumn}, ${columns}
			 FROM ${quoteName(catalog)}.information_schema.${view}
			 WHERE ${clause}`,
			params,
		);
		for (const row of rows) {
			const key = pairKey(
				String(row[schemaColumn] ?? ""),
				String(row[nameColumn] ?? ""),
			);
			const held = out.get(key) ?? [];
			held.push(row);
			out.set(key, held);
		}
	}
	return out;
}

// What the catalogue holds about every table and routine the walk reaches:
// filters and masks per table, definitions per routine, and the catalogues
// that could not be read, with why.
interface CatalogueFacts {
	filters: Map<string, Record<string, unknown>[]>;
	masks: Map<string, Record<string, unknown>[]>;
	routines: Map<string, string[]>;
	tableFailures: Map<string, string>;
	routineFailures: Map<string, string>;
}

function tableKeyOf(ref: NameRef): string {
	return `${ref.catalog}\u0000${pairKey(ref.schema, ref.name)}`;
}

async function readCatalogues(
	identity: Identity | null,
	tables: NameRef[],
): Promise<CatalogueFacts> {
	const facts: CatalogueFacts = {
		filters: new Map(),
		masks: new Map(),
		routines: new Map(),
		tableFailures: new Map(),
		routineFailures: new Map(),
	};

	// One row_filters and one column_masks statement per catalogue.
	await eachLimited(
		[...groupByCatalog(tables)],
		sourceWorkers,
		async ([catalog, pairs]) => {
			try {
				const [filters, masks] = await Promise.all([
					readByPairs(
						identity,
						catalog,
						pairs,
						"row_filters",
						"table_schema",
						"table_name",
						"filter_name, target_columns",
					),
					// A mask changes what a column holds for one reader,
					// which no restriction on rows can reproduce.
					readByPairs(
						identity,
						catalog,
						pairs,
						"column_masks",
						"table_schema",
						"table_name",
						"mask_name",
					),
				]);
				for (const [key, rows] of filters) {
					facts.filters.set(`${catalog}\u0000${key}`, rows);
				}
				for (const [key, rows] of masks) {
					facts.masks.set(`${catalog}\u0000${key}`, rows);
				}
			} catch (error) {
				facts.tableFailures.set(catalog, message(error));
			}
		},
	);

	// Then one routines statement per catalogue the routines live in.
	const routineRefs: NameRef[] = [];
	for (const table of tables) {
		const key = tableKeyOf(table);
		const named = [
			...(facts.filters.get(key) ?? []).map((r) => r.filter_name),
			...(facts.masks.get(key) ?? []).map((r) => r.mask_name),
		];
		for (const qualified of named) {
			const ref = routineRef(table.catalog, String(qualified ?? ""));
			if (ref) routineRefs.push(ref);
		}
	}
	await eachLimited(
		[...groupByCatalog(routineRefs)],
		sourceWorkers,
		async ([catalog, pairs]) => {
			try {
				const definitions = await readByPairs(
					identity,
					catalog,
					pairs,
					"routines",
					"routine_schema",
					"routine_name",
					"routine_definition",
				);
				for (const [key, rows] of definitions) {
					facts.routines.set(
						`${catalog}\u0000${key}`,
						rows.map((r) => String(r.routine_definition ?? "")),
					);
				}
			} catch (error) {
				facts.routineFailures.set(catalog, message(error));
			}
		},
	);
	return facts;
}

// What one source's filters name, from what the catalogue reads found.
//
// Masks are read the same way filters are. A mask that shows a column to one
// group and hides it from another splits readers exactly as a filter does, so
// the groups it tests are part of the policy class too.
//
// complete is false when anything that could decide what a reader sees was
// not read: a view source that is not a table, a table name that is not fully
// qualified, or a routine whose definition could not be found. Such a source
// is not covered by the group list, so nothing from it is shared. Throws when
// a catalogue the source depends on could not be read at all, so the source
// is reported as unreadable rather than taken to have no filters.
function groupsOfSource(
	behind: { tables: string[]; complete: boolean },
	facts: CatalogueFacts,
): {
	groups: FilterGroups;
	filters: FoundFilter[];
	masked: boolean;
	complete: boolean;
} {
	let complete = behind.complete;
	const parts: FilterGroups[] = [];
	const found: FoundFilter[] = [];
	let masked = false;

	// The groups one filter or mask routine names, or null when its
	// definition could not be found. No definition is not a definition naming
	// nobody. The groups it tests are unknown, which is not the same as there
	// being none.
	const routineGroups = (
		tableCatalog: string,
		qualified: string,
	): FilterGroups | null => {
		const ref = routineRef(tableCatalog, qualified);
		if (!ref) return null;
		const failure = facts.routineFailures.get(ref.catalog);
		if (failure) throw new Error(failure);
		const definitions = facts.routines.get(tableKeyOf(ref)) ?? [];
		if (definitions.length === 0) return null;
		return mergeFilterGroups(definitions.map(extractFilterGroups));
	};

	for (const table of behind.tables) {
		const ref = splitTable(table);
		if (!ref) {
			complete = false;
			continue;
		}
		const failure = facts.tableFailures.get(ref.catalog);
		if (failure) throw new Error(failure);

		const key = tableKeyOf(ref);
		const filters = facts.filters.get(key) ?? [];
		const masks = facts.masks.get(key) ?? [];
		if (masks.length > 0) masked = true;

		for (const row of filters) {
			found.push({
				table,
				columns: filterColumns(String(row.target_columns ?? "")),
			});
			const groups = routineGroups(
				ref.catalog,
				String(row.filter_name ?? ""),
			);
			if (groups) parts.push(groups);
			else complete = false;
		}
		for (const row of masks) {
			const groups = routineGroups(
				ref.catalog,
				String(row.mask_name ?? ""),
			);
			if (groups) parts.push(groups);
			else complete = false;
		}
	}

	return {
		groups: mergeFilterGroups(parts),
		filters: found,
		masked,
		complete,
	};
}

// Which fields hold what a source's filters decide on, for alerts checked
// while their owner is away. Null when they cannot be mapped exactly.
async function mapAccessFields(
	identity: Identity | null,
	source: SourceRow,
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
// What is cached is the expensive half. Opening a metric view definition is a
// round trip and a large YAML document to yield a handful of table names that
// change when the view changes, so those are written down and reused. The
// filters on those tables are re-read every walk, because that is the part
// that has to stay current.
//
// Resolves to null when there is nothing newer than what this replica already
// applied, because another replica holds the claim to walk and has not
// finished. The caller then keeps the groups it already tracks.
export async function discoverFilterGroups(
	identity: Identity | null,
	force = false,
): Promise<DiscoveredGroups | null> {
	if (!force && cached && Date.now() - cachedAt < ttlMs) return cached;

	// One walk at a time on this replica, however many callers ask.
	//
	// The memo is only written when the walk finishes, and the walk takes a
	// while. The registry poll does not await this, so without a shared
	// promise every poll that lands mid-walk would start another one.
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

	// A forced walk runs here and now, since its caller needs a source
	// switched to filtered a moment ago read. A walk under somebody's own
	// identity sees only what they can, so it is neither shared nor taken
	// from another replica.
	walking = (
		force || identity !== null ? runWalk(identity) : sharedWalk()
	).finally(() => {
		walking = null;
	});
	return walking;
}

interface StoredWalk {
	started_on: string;
	result: DiscoveredGroups;
	covered: string[];
	fresh: boolean;
	age_ms: number;
}

async function readStoredWalk(): Promise<StoredWalk | null> {
	const rows = await sql<StoredWalk>(
		`SELECT started_on::text AS started_on, result, covered,
		        walked_on > now() - make_interval(secs => $1) AS fresh,
		        (extract(epoch FROM now() - walked_on) * 1000)::float8 AS age_ms
		 FROM filter_walks WHERE walk_id = 1`,
		[ttlMs / 1000],
	);
	return rows[0] ?? null;
}

function newerThanHeld(walk: StoredWalk): boolean {
	return (
		cachedStartedOn === null ||
		Date.parse(walk.started_on) > Date.parse(cachedStartedOn)
	);
}

// Applies a walk another replica kept. Its covered list is the sources that
// walk read cleanly, so a source switched to filtered after it started is
// left out here exactly as it is on the replica that walked.
function adopt(walk: StoredWalk): DiscoveredGroups {
	cached = walk.result;
	covered = new Set(walk.covered);
	cachedAt = Date.now() - Math.max(0, Number(walk.age_ms) || 0);
	cachedStartedOn = walk.started_on;
	return walk.result;
}

// The scheduled walk. Takes a recent walk another replica kept when there is
// one, walks when this replica wins the claim to, and otherwise waits for the
// replica that won it.
async function sharedWalk(): Promise<DiscoveredGroups | null> {
	let stored: StoredWalk | null;
	let claimed: boolean;
	try {
		stored = await readStoredWalk();
		if (stored?.fresh) {
			if (newerThanHeld(stored)) return adopt(stored);
			// The walk this replica already holds, still recent by the
			// store's clock.
			if (
				cachedStartedOn !== null &&
				Date.parse(stored.started_on) === Date.parse(cachedStartedOn)
			) {
				cachedAt = Date.now() - Math.max(0, Number(stored.age_ms) || 0);
				return null;
			}
		}
		claimed = await claimRun("filter-walk", walkHoldSeconds);
	} catch (error) {
		// Without the shared table each replica walks for itself.
		console.warn(
			"The shared row filter walk could not be read, walking here:",
			error,
		);
		return runWalk(null);
	}
	if (claimed) return runWalk(null);
	// Another replica is walking. A replica holding an older walk goes on
	// using one while its own walk runs, so a kept walk newer than that is
	// the better of the two. A replica holding none takes nothing that is
	// not recent, and shares nothing filtered until the walk lands.
	if (stored && cached !== null && newerThanHeld(stored)) {
		return adopt(stored);
	}
	return null;
}

async function runWalk(identity: Identity | null): Promise<DiscoveredGroups> {
	const startedOn =
		identity === null
			? await sql<{ at: string }>(`SELECT now()::text AS at`)
					.then((rows) => rows[0]?.at ?? null)
					.catch(() => null)
			: null;
	const sources = await sql<SourceRow>(
		`SELECT source_key, catalog_name, schema_name, object_name, kind,
		        base_tables
		 FROM data_sources
		 WHERE is_active = TRUE AND has_row_filter = TRUE`,
	);

	const parts: FilterGroups[] = [];
	const unreadable: string[] = [];
	const read = new Set<string>();
	let failureReason: string | null = null;
	// Reported rather than read as having no filters, which would be the
	// dangerous reading. It would let two readers entitled to different rows
	// share one cached answer.
	const fail = (source: SourceRow, error: unknown) => {
		failureReason ??= message(error);
		unreadable.push(source.source_key);
	};

	// What each source reads, a few sources at a time, since a metric view
	// with nothing recorded has its definition opened.
	const behind = new Map<string, { tables: string[]; complete: boolean }>();
	await eachLimited(sources, sourceWorkers, async (source) => {
		try {
			behind.set(source.source_key, await tablesBehind(identity, source));
		} catch (error) {
			fail(source, error);
		}
	});

	// Then the filters, masks and routines behind every one of them, asked
	// per catalogue rather than per table.
	const tables = [...behind.values()]
		.flatMap((b) => b.tables)
		.map(splitTable)
		.filter((ref): ref is NameRef => ref !== null);
	const facts = await readCatalogues(identity, tables);

	await eachLimited(
		sources.filter((s) => behind.has(s.source_key)),
		sourceWorkers,
		async (source) => {
			const tablesOf = behind.get(source.source_key)!;
			let found: ReturnType<typeof groupsOfSource>;
			try {
				found = groupsOfSource(tablesOf, facts);
			} catch (error) {
				fail(source, error);
				return;
			}
			const { groups, filters, masked, complete } = found;
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
				const self = `${source.catalog_name}.${source.schema_name}.${source.object_name}`;
				const derived = tablesOf.tables.filter((t) => t !== self);
				if (derived.length > 0) {
					await sql(
						`UPDATE data_sources
						 SET base_tables = $2::jsonb, base_tables_checked_on = NULL
						 WHERE source_key = $1`,
						[source.source_key, JSON.stringify(derived)],
					).catch(() => {});
				}
			}
		},
	);

	const result: DiscoveredGroups = {
		...mergeFilterGroups(parts),
		unreadableSources: unreadable,
		failureReason,
	};

	// A walk that started before the one this replica already holds is not
	// allowed to replace it.
	const applied =
		startedOn === null ||
		cachedStartedOn === null ||
		Date.parse(startedOn) >= Date.parse(cachedStartedOn);
	if (applied) {
		cached = result;
		covered = read;
		cachedAt = Date.now();
		cachedStartedOn = startedOn;
	}

	if (failureReason) {
		console.warn(
			`Row filter discovery could not read ${unreadable.length} source(s). ` +
				`First failure: ${failureReason}`,
		);
	}

	// Kept for the other replicas, unless a walk that started later is
	// already there.
	if (startedOn !== null) {
		await sql(
			`INSERT INTO filter_walks
			   (walk_id, started_on, walked_on, result, covered)
			 VALUES (1, $1::timestamptz, now(), $2::jsonb, $3::jsonb)
			 ON CONFLICT (walk_id) DO UPDATE SET
			   started_on = EXCLUDED.started_on,
			   walked_on = EXCLUDED.walked_on,
			   result = EXCLUDED.result,
			   covered = EXCLUDED.covered
			 WHERE filter_walks.started_on <= EXCLUDED.started_on`,
			[startedOn, JSON.stringify(result), JSON.stringify([...read])],
		).catch((error) => {
			console.warn("Could not keep the row filter walk:", error);
		});
	}

	return applied || cached === null ? result : cached;
}

// Whether a walk is running now, for the administration page. A walk that is
// under way is why the group list is briefly the previous one.
export function filterDiscoveryRunning(): boolean {
	return walking !== null;
}
