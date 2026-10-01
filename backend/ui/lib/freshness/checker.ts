import { sql } from "../data/lakebase";
import { asApp } from "../alerts/runner";
import { liveTtlSeconds } from "../query/cache";
import { demoMode } from "../runtime";
import {
	metricViewSourcesComplete,
	parseMetricViewTables,
} from "../semantic/rowFilterGroups";
import { listSources } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import { runCatalogQuery } from "../semantic/ucMetadata";
import { settings } from "../settings";
import {
	commitsSinceSeen,
	isDataChange,
	readHistory,
	toHistory,
	type HistoryEntry,
} from "./history";
import { evaluateLateness } from "./lateness";
import { refreshMarks } from "./marks";
import { routineLooksAllowed } from "./warehouse";

// Watches the tables behind each source for new data.
//
// Each source is looked at on its interval: live ones every few seconds, the
// rest as often as their setting says. A look reads the table's Delta history,
// a small metadata query, never its rows. When a commit since the last look
// changed data, every source built on that table has its cached answers
// cleared, and the next person to open one of its pages gets new figures. When
// nothing changed, nothing else happens, however long the answers have been
// kept.
//
// A metric view is looked at through the tables it reads, recorded by the
// catalogue sync. A table is its own. A source whose tables cannot be read
// this way, such as an ordinary view, is refreshed on its interval as a timer
// instead, and says so.
//
// Looks are made only while the warehouse is already running, so watching
// never starts it. A reader who meets an answer whose tables are overdue a
// look asks for one, and that look runs whether or not the warehouse is up.

const claimLease = "2 minutes";
const historyPage = 25;
const perPass = 50;

// How much history is read to learn when a table loads, once a day. Delta
// keeps about a month by default, and a month of a table loaded every hour is
// several hundred commits, so this reaches back as far as most tables keep.
const learningPage = 1000;
const learnEveryMs = 24 * 60 * 60 * 1000;

// Commits closer together than this are recorded as one arrival, so a stream
// writing every few seconds keeps a few hundred rows a day rather than
// thousands. The learning only needs to know it arrives often.
const arrivalSpacingMs = 4 * 60 * 1000;

export function intervalFor(source: SemanticSource): number {
	if (source.isLive) return liveTtlSeconds();
	return source.cacheTtlSeconds > 0
		? source.cacheTtlSeconds
		: settings().resultTtlSeconds;
}

function quoted(table: string): string {
	return table
		.split(".")
		.map((part) => `\`${part.replace(/`/g, "``")}\``)
		.join(".");
}

// What each source was found to read, held for a while so a pass every few
// seconds does not ask again.
const tablesHeld = new Map<string, { at: number; tables: string[] | null }>();
const tablesHeldMs = 10 * 60_000;

// Metric views whose definitions are being read behind the passes.
let resolving: Promise<void> | null = null;

// The tables behind every source, or null for one whose tables are not known.
// A table is its own. A metric view's come from what the catalogue sync
// recorded, read for every view that needs it in one statement. A view with
// nothing recorded is read from its definition behind the pass, so a slow
// warehouse cannot hold up the looks at every other table, and is on a timer
// until that finishes.
async function tablesForAll(
	sources: SemanticSource[],
): Promise<Map<string, string[] | null>> {
	const found = new Map<string, string[] | null>();
	const now = Date.now();
	const unknown: SemanticSource[] = [];
	for (const source of sources) {
		if (source.kind !== "metric_view") {
			found.set(source.sourceKey, [
				`${source.catalog}.${source.schema}.${source.object}`,
			]);
			continue;
		}
		const held = tablesHeld.get(source.sourceKey);
		if (held && now - held.at < tablesHeldMs) {
			found.set(source.sourceKey, held.tables);
			continue;
		}
		unknown.push(source);
	}
	if (unknown.length === 0) return found;

	const rows = await sql<{
		source_key: string;
		base_tables: string[] | null;
		base_tables_checked_on: string | null;
	}>(
		`SELECT source_key, base_tables,
		        base_tables_checked_on::text AS base_tables_checked_on
		 FROM data_sources WHERE source_key = ANY($1::text[])`,
		[unknown.map((s) => s.sourceKey)],
	);
	const byKey = new Map(rows.map((r) => [r.source_key, r]));
	const unresolved: SemanticSource[] = [];
	for (const source of unknown) {
		const row = byKey.get(source.sourceKey);
		const recorded = row?.base_tables;
		const tables =
			Array.isArray(recorded) && recorded.length > 0 ? recorded : null;
		tablesHeld.set(source.sourceKey, { at: now, tables });
		found.set(source.sourceKey, tables);
		// A view whose definition was already found to name something other
		// than tables is not read again until the catalogue sync records a
		// new list for it.
		if (!tables && row && !row.base_tables_checked_on) {
			unresolved.push(source);
		}
	}
	if (unresolved.length > 0 && !resolving) {
		resolving = resolveDefinitions(unresolved)
			.catch((error) => {
				console.warn("Reading metric view definitions failed:", error);
			})
			.finally(() => {
				resolving = null;
			});
	}
	return found;
}

// Reads each view's definition for the tables it names, as the catalogue sync
// would, only while the warehouse is already up, so this never starts it. A
// complete list is kept on the source. A definition naming something other
// than tables is marked as checked, so it is not read again. A read that fails
// is tried again once the hold runs out.
async function resolveDefinitions(sources: SemanticSource[]): Promise<void> {
	for (const source of sources) {
		if (!(await routineLooksAllowed())) return;
		const self = `${source.catalog}.${source.schema}.${source.object}`;
		let statement: string;
		try {
			const created = await runCatalogQuery(
				null,
				`SHOW CREATE TABLE ${quoted(self)}`,
			);
			statement = String(Object.values(created[0] ?? {})[0] ?? "");
		} catch {
			continue;
		}
		// A view reading from a query or a short name has sources that cannot
		// all be named, and a partial list would be kept as if it were whole.
		const tables = metricViewSourcesComplete(statement)
			? parseMetricViewTables(statement)
			: [];
		if (tables.length > 0) {
			await sql(
				`UPDATE data_sources
				 SET base_tables = $2::jsonb, base_tables_checked_on = NULL
				 WHERE source_key = $1 AND base_tables IS NULL`,
				[source.sourceKey, JSON.stringify(tables)],
			);
			tablesHeld.set(source.sourceKey, { at: Date.now(), tables });
		} else {
			await sql(
				`UPDATE data_sources SET base_tables_checked_on = now()
				 WHERE source_key = $1 AND base_tables IS NULL`,
				[source.sourceKey],
			);
		}
	}
}

// The demonstration's tables are Postgres, which has no Delta history. The
// count of rows ever written stands in for the version, which rises with
// every write and so answers the same question.
async function demoHistory(table: string): Promise<HistoryEntry[]> {
	const [, schema, name] = table.split(".");
	const rows = await sql<{ version: string }>(
		`SELECT (n_tup_ins + n_tup_upd + n_tup_del)::text AS version
		 FROM pg_stat_user_tables WHERE schemaname = $1 AND relname = $2`,
		[schema, name],
	);
	if (!rows[0]) throw new Error("Table not found.");
	return [
		{
			version: Number(rows[0].version),
			operation: "WRITE",
			timestamp: null,
		},
	];
}

async function tableHistory(
	table: string,
	limit = historyPage,
): Promise<HistoryEntry[]> {
	if (demoMode) return demoHistory(table);
	const rows = await asApp(
		`DESCRIBE HISTORY ${quoted(table)} LIMIT ${limit}`,
		{},
	);
	return toHistory(rows);
}

// Commits that changed data, recorded as arrivals, timed by the commit. The
// demonstration's stand-in history has no times, so a change it notices is
// timed by the look that noticed it.
async function recordArrivals(
	table: string,
	entries: HistoryEntry[],
	noticedNow: boolean,
): Promise<void> {
	const times = entries
		.filter((e) => isDataChange(e.operation) && e.timestamp !== null)
		.map((e) => e.timestamp as number);
	if (noticedNow && times.length === 0) times.push(Date.now());
	if (times.length === 0) return;

	// Newest first, keeping one per spacing, so a load's last commit is the
	// one kept and a stream is thinned to a steady beat.
	const kept: number[] = [];
	for (const t of [...new Set(times)].sort((a, b) => b - a)) {
		if (
			kept.length === 0 ||
			kept[kept.length - 1] - t >= arrivalSpacingMs
		) {
			kept.push(t);
		}
	}
	await sql(
		`INSERT INTO table_arrivals (table_name, arrived_on)
		 SELECT $1, t FROM unnest($2::timestamptz[]) AS t
		 WHERE NOT EXISTS (
		   SELECT 1 FROM table_arrivals a
		   WHERE a.table_name = $1
		     AND a.arrived_on BETWEEN t - make_interval(secs => $3)
		                          AND t + make_interval(secs => $3)
		 )
		 ON CONFLICT DO NOTHING`,
		[
			table,
			kept.map((t) => new Date(t).toISOString()),
			arrivalSpacingMs / 1000,
		],
	);
}

let passing = false;
// The tables the last pass made sure had a row, as one sorted key.
let knownTables = "";

export async function runChecks(): Promise<void> {
	if (passing) return;
	passing = true;
	try {
		await pass();
	} finally {
		passing = false;
	}
}

async function pass(): Promise<void> {
	const sources = listSources();
	const nextTables = new Map<string, string[]>();
	const intervalByTable = new Map<string, number>();
	const unreadable: SemanticSource[] = [];

	const resolved = await tablesForAll(sources);
	for (const source of sources) {
		const tables = resolved.get(source.sourceKey) ?? null;
		if (!tables) {
			unreadable.push(source);
			continue;
		}
		nextTables.set(source.sourceKey, tables);
		const interval = intervalFor(source);
		for (const table of tables) {
			intervalByTable.set(
				table,
				Math.min(interval, intervalByTable.get(table) ?? interval),
			);
		}
	}

	// Written only where it differs, since this runs every few seconds on
	// every replica.
	if (unreadable.length > 0) {
		await sql(
			`UPDATE data_sources SET freshness_mode = 'timer', freshness_note = $2
			 WHERE source_key = ANY($1::text[])
			   AND (freshness_mode <> 'timer'
			        OR freshness_note IS DISTINCT FROM $2)`,
			[
				unreadable.map((s) => s.sourceKey),
				"The tables this reads are not known, so it is refreshed on a timer.",
			],
		);
	}

	const tables = [...intervalByTable.keys()];
	if (tables.length === 0) return;
	// Rows for new tables, written when the set of tables changes rather
	// than on every pass.
	const tableKey = [...tables].sort().join(",");
	if (tableKey !== knownTables) {
		await sql(
			`INSERT INTO source_checks (table_name)
			 SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`,
			[tables],
		);
		knownTables = tableKey;
	}

	// Claimed in one statement, so replicas ticking together take different
	// tables. A table somebody asked about is taken whatever the warehouse is
	// doing. The rest wait for it to be running with readers on it.
	const running = await routineLooksAllowed();
	const due = await sql<{
		table_name: string;
		version: string | null;
		version_at: string | null;
		learned_on: string | null;
		lease: string;
	}>(
		`UPDATE source_checks SET
		   next_check_on = now() + interval '${claimLease}',
		   wanted_on = NULL
		 WHERE table_name IN (
		   SELECT table_name FROM source_checks
		   WHERE table_name = ANY($1::text[])
		     AND (wanted_on IS NOT NULL OR ($2 AND next_check_on <= now()))
		   ORDER BY next_check_on
		   LIMIT ${perPass}
		   FOR UPDATE SKIP LOCKED
		 )
		 RETURNING table_name, version::text, version_at::text,
		           learned_on::text, next_check_on::text AS lease`,
		[tables, running],
	);
	if (due.length === 0) return;

	const changedTables = new Set<string>();
	const queue = [...due];
	const workers = Array.from({ length: 3 }, async () => {
		for (let row = queue.shift(); row; row = queue.shift()) {
			const interval = intervalByTable.get(row.table_name) ?? 3600;
			// The lease starts again as each look starts, so a table waiting
			// behind slow looks is still held when its turn comes. A table
			// whose lease another replica took over in the meantime is left
			// to it.
			const held = await sql(
				`UPDATE source_checks
				 SET next_check_on = now() + interval '${claimLease}'
				 WHERE table_name = $1 AND next_check_on = $2::timestamptz
				 RETURNING 1`,
				[row.table_name, row.lease],
			).catch(() => null);
			if (held !== null && held.length === 0) continue;
			try {
				let history = await tableHistory(row.table_name);
				const lastSeen =
					row.version === null
						? null
						: {
								version: Number(row.version),
								timestamp: row.version_at
									? Date.parse(row.version_at)
									: null,
							};
				const { latest, changed } = readHistory(history, lastSeen);
				if (changed) changedTables.add(row.table_name);

				// A page that stopped short of the version last seen is read
				// again far enough back to reach it, so the commit that
				// loaded the data is found and timed.
				const reach = demoMode
					? null
					: commitsSinceSeen(history, lastSeen);
				if (reach !== null)
					history = await tableHistory(
						row.table_name,
						Math.min(reach, learningPage),
					).catch(() => history);

				// What this page of history says about when the table
				// loads, and once a day the longer history, so a table is
				// learned on its first look rather than after weeks.
				const learnDue =
					!demoMode &&
					(!row.learned_on ||
						Date.now() - Date.parse(row.learned_on) > learnEveryMs);
				const learnFrom = learnDue
					? await tableHistory(row.table_name, learningPage).catch(
							() => history,
						)
					: history.filter(
							(e) =>
								lastSeen === null ||
								e.version > lastSeen.version,
						);
				await recordArrivals(
					row.table_name,
					learnFrom,
					demoMode && changed,
				);
				await sql(
					`UPDATE source_checks SET
					   version = $2, version_at = $3, checked_on = now(),
					   changed_on = CASE WHEN $4 THEN now() ELSE changed_on END,
					   next_check_on = now() + make_interval(secs => $5),
					   learned_on = CASE WHEN $6 THEN now() ELSE learned_on END,
					   last_error = NULL
					 WHERE table_name = $1`,
					[
						row.table_name,
						latest?.version ?? null,
						latest?.timestamp ? new Date(latest.timestamp) : null,
						changed,
						interval,
						learnDue,
					],
				);
			} catch (error) {
				// The version last seen is kept, so a table dropped and made
				// again is still noticed as a change once it can be read.
				await sql(
					`UPDATE source_checks SET
					   last_error = $2,
					   next_check_on = now() + make_interval(secs => $3)
					 WHERE table_name = $1`,
					[
						row.table_name,
						(error instanceof Error
							? error.message
							: String(error)
						).slice(0, 300),
						interval,
					],
				);
			}
		}
	});
	await Promise.all(workers);

	// Only sources reading a table looked at in this pass can have moved.
	const looked = new Set(due.map((d) => d.table_name));
	const touched = new Map(
		[...nextTables].filter(([, list]) => list.some((t) => looked.has(t))),
	);
	await settleSources(touched, changedTables);
	await refreshMarks();
	await evaluateLateness().catch((error) => {
		console.warn("Judging late data failed:", error);
	});
}

// Brings each source's standing up to date from its tables: watched when every
// table it reads was read, on a timer when any could not be, and changed when
// any changed on this pass. When each table was last looked at stays on its
// row in source_checks, so a look that changes nothing writes nothing here.
// See lookedOnSql in ./marks.
async function settleSources(
	tablesOf: Map<string, string[]>,
	changedTables: Set<string>,
): Promise<void> {
	const all = [...new Set([...tablesOf.values()].flat())];
	const state = await sql<{
		table_name: string;
		version: string | null;
		last_error: string | null;
	}>(
		`SELECT table_name, version::text, last_error
		 FROM source_checks WHERE table_name = ANY($1::text[])`,
		[all],
	);
	const byTable = new Map(state.map((s) => [s.table_name, s]));

	const keys: string[] = [];
	const modes: string[] = [];
	const notes: (string | null)[] = [];
	const changes: boolean[] = [];
	for (const [sourceKey, tables] of tablesOf) {
		const rows = tables.map((t) => byTable.get(t));
		const failed = rows.find((r) => r?.last_error);
		const unseen = rows.some((r) => !r || r.version === null);
		const changed = tables.some((t) => changedTables.has(t));

		const mode = failed || unseen ? "timer" : "checked";
		const note = failed
			? `Its history could not be read, so it is refreshed on a timer: ${failed.last_error}`
			: unseen
				? "Not looked at yet."
				: null;

		keys.push(sourceKey);
		modes.push(mode);
		notes.push(note);
		changes.push(changed);
	}
	if (keys.length === 0) return;

	// One statement for every source, writing only the rows whose mode or
	// note moved or whose data changed.
	await sql(
		`UPDATE data_sources d SET
		   freshness_mode = u.mode, freshness_note = u.note,
		   data_changed_on = CASE WHEN u.changed THEN now()
		                          ELSE d.data_changed_on END
		 FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[])
		      AS u(key, mode, note, changed)
		 WHERE d.source_key = u.key
		   AND (u.changed
		        OR (d.freshness_mode, d.freshness_note)
		           IS DISTINCT FROM (u.mode, u.note))`,
		[keys, modes, notes, changes],
	);
	const changedKeys = keys.filter((_, i) => changes[i]);
	if (changedKeys.length > 0) {
		await sql(
			`DELETE FROM result_cache WHERE source_key = ANY($1::text[])`,
			[changedKeys],
		);
	}
}

// Asks for the tables behind a source to be looked at on the next pass, even
// with the warehouse stopped. Called when a reader was served an answer from a
// source that has gone too long without a look. The tables are read from the
// platform tables rather than from this module, which may be a different
// instance from the one running the passes.
const lastAsked = new Map<string, number>();

export function requestCheck(sourceKey: string): void {
	const now = Date.now();
	if (now - (lastAsked.get(sourceKey) ?? 0) < 60_000) return;
	lastAsked.set(sourceKey, now);
	void sql(
		`UPDATE source_checks SET wanted_on = now()
		 WHERE table_name IN (
		   SELECT jsonb_array_elements_text(coalesce(base_tables, '[]'::jsonb))
		   FROM data_sources WHERE source_key = $1 AND kind = 'metric_view'
		   UNION
		   SELECT catalog_name || '.' || schema_name || '.' || object_name
		   FROM data_sources WHERE source_key = $1 AND kind <> 'metric_view'
		 )`,
		[sourceKey],
	).catch(() => {});
}
