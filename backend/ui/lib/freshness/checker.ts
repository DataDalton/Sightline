import { sql } from "../data/lakebase";
import { asApp } from "../alerts/runner";
import { liveTtlSeconds } from "../query/cache";
import { demoMode, isDatabricksApp, resolveWarehousePath } from "../runtime";
import { parseMetricViewTables } from "../semantic/rowFilterGroups";
import { listSources } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import { runCatalogQuery } from "../semantic/ucMetadata";
import { settings } from "../settings";
import {
	isDataChange,
	readHistory,
	toHistory,
	type HistoryEntry,
} from "./history";
import { evaluateLateness } from "./lateness";
import { refreshMarks } from "./marks";

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
// seconds does not ask again, and a view that cannot be resolved is not
// opened on every pass.
const tablesHeld = new Map<string, { at: number; tables: string[] | null }>();
const tablesHeldMs = 10 * 60_000;

async function tablesFor(source: SemanticSource): Promise<string[] | null> {
	const held = tablesHeld.get(source.sourceKey);
	if (held && Date.now() - held.at < tablesHeldMs) return held.tables;
	const tables = await resolveTables(source);
	tablesHeld.set(source.sourceKey, { at: Date.now(), tables });
	return tables;
}

async function resolveTables(source: SemanticSource): Promise<string[] | null> {
	const self = `${source.catalog}.${source.schema}.${source.object}`;
	if (source.kind !== "metric_view") return [self];

	const rows = await sql<{ base_tables: string[] | null }>(
		`SELECT base_tables FROM data_sources WHERE source_key = $1`,
		[source.sourceKey],
	);
	const recorded = rows[0]?.base_tables;
	if (Array.isArray(recorded) && recorded.length > 0) return recorded;

	// Not recorded yet. Read from the view's definition once and kept, as
	// the catalogue sync would.
	try {
		const created = await runCatalogQuery(
			null,
			`SHOW CREATE TABLE ${self}`,
		);
		const tables = parseMetricViewTables(
			String(Object.values(created[0] ?? {})[0] ?? ""),
		);
		if (tables.length === 0) return null;
		await sql(
			`UPDATE data_sources SET base_tables = $2::jsonb WHERE source_key = $1`,
			[source.sourceKey, JSON.stringify(tables)],
		);
		return tables;
	} catch {
		return null;
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

let warehouseState: { at: number; running: boolean } | null = null;

// Whether the SQL warehouse is up, asked of the workspace rather than of the
// warehouse, so asking never starts it. Assumed up outside a deployment, and
// when the answer cannot be had, since a look that was not needed costs less
// than an answer that stayed old.
async function warehouseRunning(): Promise<boolean> {
	if (demoMode || !isDatabricksApp) return true;
	if (warehouseState && Date.now() - warehouseState.at < 15_000) {
		return warehouseState.running;
	}
	let running = true;
	try {
		const id = resolveWarehousePath().split("/").pop();
		if (id) {
			const { WorkspaceClient } =
				await import("@databricks/sdk-experimental");
			const warehouse = await new WorkspaceClient({}).warehouses.get({
				id,
			});
			running = warehouse.state === "RUNNING";
		}
	} catch {
		running = true;
	}
	warehouseState = { at: Date.now(), running };
	return running;
}

let passing = false;

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

	for (const source of sources) {
		const tables = await tablesFor(source);
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

	for (const source of unreadable) {
		await sql(
			`UPDATE data_sources SET freshness_mode = 'timer', freshness_note = $2
			 WHERE source_key = $1`,
			[
				source.sourceKey,
				"The tables this reads are not known, so it is refreshed on a timer.",
			],
		);
	}

	const tables = [...intervalByTable.keys()];
	if (tables.length === 0) return;
	await sql(
		`INSERT INTO source_checks (table_name)
		 SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`,
		[tables],
	);

	// Claimed in one statement, so replicas ticking together take different
	// tables. A table somebody asked about is taken whatever the warehouse is
	// doing. The rest wait for it to be running.
	const running = await warehouseRunning();
	const due = await sql<{
		table_name: string;
		version: string | null;
		version_at: string | null;
		learned_on: string | null;
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
		           learned_on::text`,
		[tables, running],
	);
	if (due.length === 0) return;

	const changedTables = new Set<string>();
	const queue = [...due];
	const workers = Array.from({ length: 3 }, async () => {
		for (let row = queue.shift(); row; row = queue.shift()) {
			const interval = intervalByTable.get(row.table_name) ?? 3600;
			try {
				const history = await tableHistory(row.table_name);
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
				if (learnDue) {
					await sql(
						`UPDATE source_checks SET learned_on = now()
						 WHERE table_name = $1`,
						[row.table_name],
					);
				}
				await sql(
					`UPDATE source_checks SET
					   version = $2, version_at = $3, checked_on = now(),
					   changed_on = CASE WHEN $4 THEN now() ELSE changed_on END,
					   next_check_on = now() + make_interval(secs => $5),
					   last_error = NULL
					 WHERE table_name = $1`,
					[
						row.table_name,
						latest?.version ?? null,
						latest?.timestamp ? new Date(latest.timestamp) : null,
						changed,
						interval,
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

	await settleSources(nextTables, changedTables);
	await refreshMarks();
	await evaluateLateness().catch((error) => {
		console.warn("Judging late data failed:", error);
	});
}

// Brings each source's standing up to date from its tables: watched when every
// table it reads was read, on a timer when any could not be, and changed when
// any changed on this pass.
async function settleSources(
	tablesOf: Map<string, string[]>,
	changedTables: Set<string>,
): Promise<void> {
	const all = [...new Set([...tablesOf.values()].flat())];
	const state = await sql<{
		table_name: string;
		version: string | null;
		checked_on: string | null;
		last_error: string | null;
	}>(
		`SELECT table_name, version::text, checked_on::text, last_error
		 FROM source_checks WHERE table_name = ANY($1::text[])`,
		[all],
	);
	const byTable = new Map(state.map((s) => [s.table_name, s]));

	for (const [sourceKey, tables] of tablesOf) {
		const rows = tables.map((t) => byTable.get(t));
		const failed = rows.find((r) => r?.last_error);
		const unseen = rows.some((r) => !r || r.version === null);
		const changed = tables.some((t) => changedTables.has(t));
		const oldestLook = rows
			.map((r) => (r?.checked_on ? Date.parse(r.checked_on) : 0))
			.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);

		const mode = failed || unseen ? "timer" : "checked";
		const note = failed
			? `Its history could not be read, so it is refreshed on a timer: ${failed.last_error}`
			: unseen
				? "Not looked at yet."
				: null;

		await sql(
			`UPDATE data_sources SET
			   freshness_mode = $2, freshness_note = $3,
			   checked_on = $4,
			   data_changed_on = CASE WHEN $5 THEN now() ELSE data_changed_on END
			 WHERE source_key = $1`,
			[
				sourceKey,
				mode,
				note,
				Number.isFinite(oldestLook) && oldestLook > 0
					? new Date(oldestLook)
					: null,
				changed,
			],
		);
		if (changed) {
			await sql(`DELETE FROM result_cache WHERE source_key = $1`, [
				sourceKey,
			]);
		}
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
