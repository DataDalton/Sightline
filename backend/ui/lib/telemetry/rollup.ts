import { sql, withAdvisoryLock } from "../data/lakebase";

// Collapsing usage events into a shape the administration screens can read.
//
// Nothing is deleted. The raw events are the audit record and an aggregate
// cannot answer a question nobody thought to aggregate for, so they stay
// exactly as they were written. What changes is where the screens read from:
// counting and ranking over a window is answered from one row per day per
// reader per report per source, rather than from every event in that window.
//
// The saving is not marginal. A day of events at real volume is millions of
// rows and the same day rolled up is thousands, and the screens run several
// aggregates each time somebody opens them.
//
// Rebuilt rather than appended. A day is recomputed from its events with an
// upsert, so a run that overlaps another, or one that repeats after a failure,
// converges on the same numbers instead of doubling them.

// Days re-examined on every run.
//
// Today is always incomplete, and yesterday can still gain rows: telemetry
// buffers in memory and a replica that stops mid-buffer flushes late, so a day
// is not final the moment it ends. Three days is comfortably past both and
// still a small amount of work.
const rebuildDays = 3;

export interface RollupResult {
	days: number;
	rowsWritten: number;
	ranMs: number;
}

// Identifies the rollup lock. One replica rebuilds at a time.
const rollupLockKey = 8577403;

// Rebuilds the recent window. Safe to run on any replica at any time.
//
// Held behind a lock because every replica runs this on the same schedule and
// the work is identical: without one they would all rewrite the same days at
// the same time, which is correct and pointless. A replica that cannot take the
// lock has nothing to do, because whoever holds it is doing it.
export async function rollupUsage(days = rebuildDays): Promise<RollupResult> {
	const startedAt = Date.now();

	// One statement per day rather than one for the window, so a long run does
	// not hold a single transaction open across all of it and a failure part
	// way leaves the days it did finish correct.
	let rowsWritten = 0;
	await withAdvisoryLock(rollupLockKey, async () => {
		for (let back = 0; back < days; back++) {
			rowsWritten += await rollupDay(back);
		}
	});

	await sql(
		`INSERT INTO usage_rollup_state (id, built_to, ran_on)
		 VALUES (TRUE, current_date, now())
		 ON CONFLICT (id) DO UPDATE SET
		   built_to = EXCLUDED.built_to,
		   ran_on = EXCLUDED.ran_on`,
	).catch(() => {});

	return { days, rowsWritten, ranMs: Date.now() - startedAt };
}

async function rollupDay(back: number): Promise<number> {
	// Deleted then rewritten rather than merged, so a row whose underlying
	// events were themselves corrected does not keep a stale total. Both
	// statements name the same day, so the pair is idempotent.
	await sql(`DELETE FROM usage_daily WHERE day = current_date - $1::int`, [
		back,
	]);

	const written = await sql<{ n: string }>(
		`WITH rolled AS (
		   INSERT INTO usage_daily (
		     day, event_type, user_email, report_id, source_key,
		     events, cache_hits, cacheable,
		     duration_sum, duration_n,
		     query_ms_sum, query_ms_n, query_ms_max, rows_sum,
		     first_event, last_event)
		   SELECT
		     occurred_on::date,
		     event_type,
		     lower(user_email),
		     report_id,
		     source_key,
		     count(*),
		     count(*) FILTER (WHERE cache_hit IS TRUE),
		     count(*) FILTER (WHERE cache_hit IS NOT NULL),
		     coalesce(sum(duration_ms), 0),
		     count(duration_ms),
		     coalesce(sum(query_ms), 0),
		     count(query_ms),
		     coalesce(max(query_ms), 0),
		     coalesce(sum(row_count), 0),
		     min(occurred_on),
		     max(occurred_on)
		   FROM usage_events
		   WHERE occurred_on::date = current_date - $1::int
		   GROUP BY 1, 2, 3, 4, 5
		   RETURNING 1
		 )
		 SELECT count(*)::text AS n FROM rolled`,
		[back],
	);

	// Latency separately, because a percentile cannot be recovered from sums
	// and counts and has to be measured where the samples still exist.
	await sql(
		`DELETE FROM usage_daily_latency WHERE day = current_date - $1::int`,
		[back],
	);
	await sql(
		`INSERT INTO usage_daily_latency (day, source_key, samples, p50_ms, p95_ms, max_ms)
		 SELECT
		   occurred_on::date,
		   coalesce(source_key, ''),
		   count(query_ms),
		   percentile_cont(0.5) WITHIN GROUP (ORDER BY query_ms),
		   percentile_cont(0.95) WITHIN GROUP (ORDER BY query_ms),
		   max(query_ms)
		 FROM usage_events
		 WHERE occurred_on::date = current_date - $1::int
		   AND query_ms IS NOT NULL
		 GROUP BY 1, 2`,
		[back],
	);

	return Number(written[0]?.n ?? 0);
}

export async function rollupState(): Promise<{
	builtTo: string | null;
	ranOn: string | null;
}> {
	try {
		const rows = await sql<{
			built_to: string | null;
			ran_on: string | null;
		}>(
			`SELECT built_to::text, ran_on::text FROM usage_rollup_state WHERE id`,
		);
		return {
			builtTo: rows[0]?.built_to ?? null,
			ranOn: rows[0]?.ran_on ?? null,
		};
	} catch {
		return { builtTo: null, ranOn: null };
	}
}
