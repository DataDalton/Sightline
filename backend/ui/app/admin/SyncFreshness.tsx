"use client";

import { useEffect, useState } from "react";
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

const minute = 60000;
const hour = 60 * minute;
const day = 24 * hour;

function daysSince(iso: string): number {
	return (Date.now() - new Date(iso).getTime()) / day;
}

// How long ago, at the resolution somebody can act on. A run reported only to
// the hour read the same the moment it finished as it did fifty minutes later,
// which is the one distinction the person who just pressed the button needs.
function ago(iso: string): string {
	const elapsed = Date.now() - new Date(iso).getTime();
	if (elapsed < minute) return "just now";
	if (elapsed < hour) {
		const minutes = Math.floor(elapsed / minute);
		return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
	}
	if (elapsed < day) {
		const hours = Math.floor(elapsed / hour);
		return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
	}
	const days = Math.floor(elapsed / day);
	return days === 1 ? "yesterday" : `${days} days ago`;
}

// The wall clock reading, dated once it is from a different day. This is what
// a run gets matched against: somebody who pressed the button knows when they
// pressed it, and an elapsed time alone leaves them working it out.
function clock(iso: string): string {
	const at = new Date(iso);
	const time = at.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
	const now = new Date();
	const sameDay =
		at.getFullYear() === now.getFullYear() &&
		at.getMonth() === now.getMonth() &&
		at.getDate() === now.getDate();
	if (sameDay) return time;
	const date = at.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	});
	return `${time} on ${date}`;
}

// Both halves, because either one alone leaves a question open.
function describe(iso: string): string {
	return `at ${clock(iso)}, ${ago(iso)}`;
}

// Keeps the relative half moving. Nothing on the pane refreshes once a sync
// has finished, so a note reading just now went on reading it for as long as
// the tab stayed open.
function useTick(every: number) {
	const [, setTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTick((n) => n + 1), every);
		return () => clearInterval(id);
	}, [every]);
}

export function SyncFreshness({ run }: { run: Run | null }) {
	useTick(30000);

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
						{run.startedBy} {describe(run.startedOn)}.
					</p>
				</div>
			</div>
		);
	}

	// A finished run is always reported, not only once it is old enough to
	// complain about. Saying nothing after a successful sync left the one
	// question somebody presses the button to answer, whether it worked,
	// answerable only by the message that disappeared when they navigated
	// away.
	const stale = daysSince(run.finishedOn) > staleAfterDays;
	if (!stale) {
		return (
			<p className={styles.paneNote}>
				Last synced {describe(run.finishedOn)} by {run.startedBy},{" "}
				{run.total} {run.total === 1 ? "source" : "sources"}.
			</p>
		);
	}

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
