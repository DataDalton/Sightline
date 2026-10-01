"use client";

import { useCallback, useEffect, useRef } from "react";
import useSWR from "swr";
import { useVisualVisibility } from "../visuals/LazyVisual";
import { canonical } from "./canonicalKey";
import { runBatchedQuery } from "./queryBatch";

// Runs one visual's query. Every visual on a page calls this, so the request
// body is the cache key: two visuals asking for the same shape share one
// in-flight request and one cached result rather than each hitting the API.

export interface QueryMeta {
	source: "l1" | "l2" | "warehouse";
	stale: boolean;
	computedAt: number;
	durationMs: number;
	// Set when the source is live. The query is asked again after this long,
	// so an open page follows data that streams in.
	refreshAfterMs?: number | null;
}

export interface QueryResponse {
	rows: Record<string, unknown>[];
	columns: string[];
	rowCount: number;
	meta: QueryMeta;
}

export interface VisualQuery {
	sourceKey: string;
	dimensions?: string[];
	measures?: string[];
	filters?: unknown[];
	sort?: { field: string; direction: "asc" | "desc" }[];
	limit?: number;
	offset?: number;
}

// Frozen so the emptiness cannot be written into by a caller that mistakes it
// for its own array.
const noRows = Object.freeze([]) as readonly Record<
	string,
	unknown
>[] as Record<string, unknown>[];
const noColumns = Object.freeze([]) as readonly string[] as string[];

export function useVisualQuery(query: VisualQuery | null) {
	// The canonical form of the query is the SWR key, so identical requests
	// deduplicate across every visual on the page however the object was
	// spelled. Plain stringify made the key depend on property order, which two
	// components writing the same query eventually disagree on.
	//
	// No key until the visual is within a screen of being seen, so a visual
	// further down a long report asks nothing until the reader heads for it.
	const { near, onScreen } = useVisualVisibility();
	const key = query && near ? canonical(query) : null;

	// Zero for a source on a schedule. A live one names its own interval,
	// which stops while the visual is out of sight. SWR restarts its timer
	// when this function changes, so it is rebuilt only when that does.
	//
	// The delay runs to the next wall clock multiple of the interval rather
	// than a full interval from when this answer arrived. Every live visual on
	// the page then asks at the same moment, inside one batch, and the timers
	// do not drift apart as answers land at different times.
	const refreshInterval = useCallback(
		(latest: QueryResponse | undefined) => {
			const interval = onScreen ? (latest?.meta?.refreshAfterMs ?? 0) : 0;
			if (interval <= 0) return 0;
			return interval - (Date.now() % interval);
		},
		[onScreen],
	);

	const { data, error, isLoading, mutate } = useSWR<QueryResponse>(
		key,
		runBatchedQuery,
		{
			revalidateOnFocus: false,
			// The server already caches by policy class, so a client-side
			// refetch on mount would only add latency.
			revalidateIfStale: false,
			keepPreviousData: true,
			// SWR also pauses this while the tab is hidden.
			refreshInterval,
		},
	);

	// A live visual coming back into sight asks straight away, since what it
	// shows stopped following the source when it left.
	const wasOnScreen = useRef(onScreen);
	const live = Boolean(data?.meta?.refreshAfterMs);
	useEffect(() => {
		const returned = onScreen && !wasOnScreen.current;
		wasOnScreen.current = onScreen;
		if (returned && live) void mutate();
	}, [onScreen, live, mutate]);

	return {
		// Shared constants rather than fresh literals.
		//
		// A new [] on every render is a new identity, so anything listing rows
		// or columns as a dependency recomputes every time even though nothing
		// arrived. That is wasted work everywhere it happens, and where the
		// recomputed value feeds an effect that sets state it is an infinite
		// loop: a query with no key never has data, so it handed out a
		// different empty array forever.
		rows: data?.rows ?? noRows,
		columns: data?.columns ?? noColumns,
		rowCount: data?.rowCount ?? 0,
		meta: data?.meta,
		error: error as (Error & { status?: number }) | undefined,
		isLoading,
		refresh: mutate,
	};
}
