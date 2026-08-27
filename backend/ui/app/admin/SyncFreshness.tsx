"use client";

import styles from "./Admin.module.css";

// How old the source metadata is.
//
// The catalogue walk runs on one button and nothing schedules it, so field
// metadata drifts from the warehouse silently: a column added upstream is
// invisible until somebody remembers to sync. Every run has been recorded since
// sync runs existed and nothing read the age of the last one, so a source list
// last refreshed in March read exactly like one refreshed this morning.

interface Run {
	runId: string;
	startedBy: string;
	startedOn: string;
	finishedOn: string | null;
	total: number;
	completed: number;
	error: string | null;
	// Neither finished nor heard from recently, so its replica went away
	// mid-walk. Reported by the server rather than guessed at from timestamps.
	abandoned?: boolean;
}

// Past this, the list on screen is old enough that somebody should be told
// rather than left to work it out from a timestamp.
const staleAfterDays = 7;

function daysSince(iso: string): number {
	return (Date.now() - new Date(iso).getTime()) / 86400000;
}

function describe(iso: string): string {
	const days = daysSince(iso);
	if (days < 1) {
		const hours = Math.floor(days * 24);
		return hours < 1 ? "less than an hour ago" : `${hours} hours ago`;
	}
	const whole = Math.floor(days);
	return whole === 1 ? "yesterday" : `${whole} days ago`;
}

export function SyncFreshness({ run }: { run: Run | null }) {
	if (!run) {
		return (
			<div className={`${styles.notice} ${styles.noticeWarn}`}>
				<div>
					<div className={styles.noticeTitle}>
						No catalogue sync has been recorded
					</div>
					<p className={styles.noticeBody}>
						Everything below came from whatever was registered by
						hand. Run a sync to pick up columns, comments and types
						from Unity Catalog.
					</p>
				</div>
			</div>
		);
	}

	if (run.error) {
		return (
			<div className={`${styles.notice} ${styles.noticeError}`}>
				<div>
					<div className={styles.noticeTitle}>
						The last sync failed {describe(run.startedOn)}
					</div>
					<p className={styles.noticeBody}>
						{run.error} It reached {run.completed} of {run.total}{" "}
						sources, so some of the list below may be current and
						some may not.
					</p>
				</div>
			</div>
		);
	}

	// Stopped rather than running.
	//
	// A run is only under way while it is still saying so. Reading an unfinished
	// row as a running one meant a sync whose replica died two days ago was
	// still announced as in progress on every visit, with the count frozen
	// wherever it stopped, and nothing on the page suggested running another.
	if (!run.finishedOn && run.abandoned) {
		return (
			<div className={`${styles.notice} ${styles.noticeWarn}`}>
				<div>
					<div className={styles.noticeTitle}>
						The last sync stopped before it finished
					</div>
					<p className={styles.noticeBody}>
						It reached {run.completed} of {run.total} sources{" "}
						{describe(run.startedOn)} and has not reported since, so
						some of the list below may be current and some may not.
						Running it again picks up from the catalogue as it
						stands now.
					</p>
				</div>
			</div>
		);
	}

	if (!run.finishedOn) {
		return (
			<div className={styles.notice}>
				<div>
					<div className={styles.noticeTitle}>A sync is running</div>
					<p className={styles.noticeBody}>
						{run.completed} of {run.total} sources, started by{" "}
						{run.startedBy}.
					</p>
				</div>
			</div>
		);
	}

	const stale = daysSince(run.finishedOn) > staleAfterDays;
	if (!stale) return null;

	return (
		<div className={`${styles.notice} ${styles.noticeWarn}`}>
			<div>
				<div className={styles.noticeTitle}>
					Last synced {describe(run.finishedOn)}
				</div>
				<p className={styles.noticeBody}>
					Nothing schedules this, so a column added upstream since
					then is not in the list below. {run.startedBy} ran the last
					one.
				</p>
			</div>
		</div>
	);
}
