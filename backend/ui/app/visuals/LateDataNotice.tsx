"use client";

import useSWR from "swr";
import { describePattern } from "../../lib/freshness/arrivals";
import { lateKey } from "../../lib/query/requestKey";
import type { StoredPattern } from "../../lib/freshness/lateness";

// Which datasets a page reads have not arrived when they usually do, so its figures are
// read as possibly behind rather than as today's. Told in the page's data status. See
// app/r/DataHealth.
//
// Asked of the server for the sources the page reads. Asking is also what
// settles a source that is past due but has not been looked at since, so the
// notice can appear a moment after the page opens rather than with it.

export interface LateSource {
	sourceKey: string;
	title: string;
	state: string;
	lastArrival: string | null;
	pattern: StoredPattern | null;
}

// Asked again every few minutes, which is as often as a late load is likely
// to land and be noticed.
const refreshMs = 5 * 60 * 1000;

function browserZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

function when(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	return at.toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function useLateSources(sourceKeys: string[]): LateSource[] {
	const { data } = useSWR<{ sources: LateSource[] }>(lateKey(sourceKeys), {
		refreshInterval: refreshMs,
	});
	return (data?.sources ?? []).filter((s) => s.state === "late");
}

// Since when a late source has not updated, and when it usually does.
export function lateDetail(source: LateSource): string {
	const since = source.lastArrival
		? `Not updated since ${when(source.lastArrival)}, so figures from it may be behind.`
		: "Not updated when expected, so figures from it may be behind.";
	return source.pattern
		? `${since} ${describePattern(source.pattern, browserZone())}`
		: since;
}
