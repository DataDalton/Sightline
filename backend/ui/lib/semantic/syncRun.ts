import { sql } from "../data/lakebase";

// The state of a catalogue sync.
//
// A sync walks every source in turn and takes tens of seconds. The request that
// starts it is not the only thing that wants to know how it is going: the
// administrator who started it may navigate away, another may arrive mid-run,
// and a replica that never handled the request still has to answer for it. So
// progress lives in the database rather than in the handler.
//
// This is a record of what happened, not a lock. Two syncs at once would be
// wasteful rather than harmful, and refusing the second one on the strength of
// a row that a crashed run left behind would be worse.

export interface SyncRun {
	runId: string;
	startedBy: string;
	startedOn: string;
	finishedOn: string | null;
	total: number;
	completed: number;
	current: string | null;
	error: string | null;
}

interface Row {
	run_id: string;
	started_by: string;
	started_on: string;
	finished_on: string | null;
	total: number;
	completed: number;
	current: string | null;
	error: string | null;
}

function toRun(row: Row): SyncRun {
	return {
		runId: row.run_id,
		startedBy: row.started_by,
		startedOn: row.started_on,
		finishedOn: row.finished_on,
		total: Number(row.total) || 0,
		completed: Number(row.completed) || 0,
		current: row.current,
		error: row.error,
	};
}

export async function startSyncRun(
	startedBy: string,
	total: number,
): Promise<string | null> {
	try {
		const rows = await sql<{ run_id: string }>(
			`INSERT INTO sync_runs (started_by, total) VALUES ($1, $2)
			 RETURNING run_id`,
			[startedBy, total],
		);
		return rows[0]?.run_id ?? null;
	} catch (error) {
		// Losing the record costs visibility, never the sync itself.
		console.warn("Could not record the start of a sync:", error);
		return null;
	}
}

export async function noteSyncProgress(
	runId: string | null,
	completed: number,
	current: string | null,
): Promise<void> {
	if (!runId) return;
	try {
		await sql(
			`UPDATE sync_runs SET completed = $2, current = $3 WHERE run_id = $1`,
			[runId, completed, current],
		);
	} catch {
		// Progress is a courtesy. A failed write must not end the run.
	}
}

export async function finishSyncRun(
	runId: string | null,
	error?: string,
): Promise<void> {
	if (!runId) return;
	try {
		await sql(
			`UPDATE sync_runs
			 SET finished_on = now(), current = NULL, error = $2
			 WHERE run_id = $1`,
			[runId, error ?? null],
		);
	} catch (failure) {
		console.warn("Could not record the end of a sync:", failure);
	}
}

// The most recent run, finished or not.
//
// A run with no finish and no recent progress is one whose replica went away
// mid-sync. It is reported as it stands rather than repaired: the caller
// decides what to make of it, and starting another sync is always allowed.
export async function latestSyncRun(): Promise<SyncRun | null> {
	try {
		const rows = await sql<Row>(
			`SELECT run_id, started_by, started_on, finished_on, total,
			        completed, current, error
			 FROM sync_runs
			 ORDER BY started_on DESC
			 LIMIT 1`,
		);
		return rows[0] ? toRun(rows[0]) : null;
	} catch (error) {
		console.warn("Could not read the last sync:", error);
		return null;
	}
}
