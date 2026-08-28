"use client";

import useSWR from "swr";
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
	const key = query ? canonical(query) : null;

	const { data, error, isLoading, mutate } = useSWR<QueryResponse>(
		key,
		runBatchedQuery,
		{
			revalidateOnFocus: false,
			// The server already caches by policy class, so a client-side
			// refetch on mount would only add latency.
			revalidateIfStale: false,
			keepPreviousData: true,
		},
	);

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
