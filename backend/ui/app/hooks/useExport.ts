"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Starting an export and following it to the file.
//
// The server accepts the request and does the work behind it, so this is three
// steps rather than one: ask, watch, collect. Watching is a poll because the
// replica that answers the poll is not necessarily the one doing the work, and
// the job row in Lakebase is the thing all of them can see.
//
// The job id is kept in session storage, so closing the tab or navigating away
// and coming back picks the same export back up instead of starting a second
// one. A reader who asks for fifty thousand rows and switches to another page
// is the case this is for.

export type ExportStatus =
	| "queued"
	| "running"
	| "complete"
	| "failed"
	| "expired";

export interface ExportJob {
	jobId: string;
	status: ExportStatus;
	filename: string;
	rowCount: number;
	byteCount: number;
	truncated: boolean;
	error: string | null;
}

export interface ExportRequestBody {
	spec: Record<string, unknown>;
	reportId?: string | null;
	pageId?: string | null;
	visualId?: string | null;
}

// Long enough not to hammer the platform store, short enough that a small
// export still feels immediate.
const pollMs = 1500;

// Session rather than local storage: an export belongs to the tab that asked
// for it, and a job id surviving a browser restart would point at something the
// retention window has already dropped.
function remember(key: string, jobId: string | null): void {
	try {
		if (jobId) sessionStorage.setItem(key, jobId);
		else sessionStorage.removeItem(key);
	} catch {
		// Private browsing, or storage turned off. The export still works, it
		// just does not survive leaving the page.
	}
}

function recall(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

function download(job: ExportJob): void {
	// A plain navigation rather than fetch and a blob. The response is streamed
	// and can be tens of megabytes, and reading it into a blob first would put
	// the whole file back in memory, which is what the streaming was for.
	const link = document.createElement("a");
	link.href = `/api/query/export/${encodeURIComponent(job.jobId)}`;
	link.download = job.filename;
	link.style.display = "none";
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}

export interface UseExport {
	// True from the moment it is asked for until the file is offered.
	busy: boolean;
	job: ExportJob | null;
	error: Error | null;
	start: (body: ExportRequestBody) => Promise<void>;
	dismiss: () => void;
}

// storageKey scopes the remembered job. Two grids on one page each get their
// own, so watching one does not show the other's progress.
export function useExport(storageKey: string): UseExport {
	const [job, setJob] = useState<ExportJob | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [busy, setBusy] = useState(false);

	// Whether this hook has already handed the file over, so a poll that lands
	// twice on a complete job does not download it twice.
	const collected = useRef<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const stop = useCallback(() => {
		if (timer.current) {
			clearTimeout(timer.current);
			timer.current = null;
		}
	}, []);

	const poll = useCallback(
		async (jobId: string) => {
			try {
				const response = await fetch(
					`/api/query/export?jobId=${encodeURIComponent(jobId)}`,
				);

				// The job is gone: collected, expired, or never this reader's.
				// Not an error, just nothing left to watch.
				if (response.status === 404) {
					remember(storageKey, null);
					setBusy(false);
					setJob(null);
					return;
				}

				if (!response.ok) throw new Error("Could not read the export");

				const next = (await response.json()) as ExportJob;
				setJob(next);

				if (next.status === "complete") {
					remember(storageKey, null);
					setBusy(false);
					if (collected.current !== next.jobId) {
						collected.current = next.jobId;
						download(next);
					}
					return;
				}

				if (next.status === "failed" || next.status === "expired") {
					remember(storageKey, null);
					setBusy(false);
					setError(
						new Error(next.error ?? "The export did not finish."),
					);
					return;
				}

				timer.current = setTimeout(() => void poll(jobId), pollMs);
			} catch (e) {
				setBusy(false);
				setError(e instanceof Error ? e : new Error("Export failed"));
			}
		},
		[storageKey],
	);

	// An export left running when the page was closed is picked back up.
	useEffect(() => {
		const pending = recall(storageKey);
		if (!pending) return;
		setBusy(true);
		void poll(pending);
		return stop;
	}, [storageKey, poll, stop]);

	useEffect(() => stop, [stop]);

	const start = useCallback(
		async (body: ExportRequestBody) => {
			stop();
			setError(null);
			setBusy(true);
			setJob(null);

			try {
				const response = await fetch("/api/query/export", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});

				if (!response.ok) {
					const detail = await response.json().catch(() => null);
					throw new Error(detail?.error ?? "Export failed");
				}

				const started = (await response.json()) as ExportJob;
				setJob(started);
				remember(storageKey, started.jobId);
				void poll(started.jobId);
			} catch (e) {
				setBusy(false);
				setError(e instanceof Error ? e : new Error("Export failed"));
			}
		},
		[storageKey, poll, stop],
	);

	const dismiss = useCallback(() => {
		stop();
		remember(storageKey, null);
		setBusy(false);
		setJob(null);
		setError(null);
	}, [storageKey, stop]);

	return { busy, job, error, start, dismiss };
}
