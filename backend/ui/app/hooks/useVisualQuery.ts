"use client";

import useSWR from "swr";

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

async function postQuery(body: string): Promise<QueryResponse> {
	const response = await fetch("/api/query", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});

	if (!response.ok) {
		const detail = await response.json().catch(() => null);
		const error: Error & { status?: number } = new Error(
			detail?.error ?? `Query failed (${response.status})`,
		);
		error.status = response.status;
		throw error;
	}
	return response.json();
}

export function useVisualQuery(query: VisualQuery | null) {
	// Serializing the query makes it the SWR key, so identical requests
	// deduplicate across every visual on the page.
	const key = query ? JSON.stringify(query) : null;

	const { data, error, isLoading, mutate } = useSWR<QueryResponse>(
		key,
		postQuery,
		{
			revalidateOnFocus: false,
			// The server already caches by policy class, so a client-side
			// refetch on mount would only add latency.
			revalidateIfStale: false,
			keepPreviousData: true,
		},
	);

	return {
		rows: data?.rows ?? [],
		columns: data?.columns ?? [],
		rowCount: data?.rowCount ?? 0,
		meta: data?.meta,
		error: error as (Error & { status?: number }) | undefined,
		isLoading,
		refresh: mutate,
	};
}
