"use client";

import type { QueryResponse } from "./useVisualQuery";

// Gathers the queries a page fires into one request.
//
// Every visual asks independently, which is right: a visual knows what it needs
// and nothing above it does. It is wrong as a wire protocol. Each request
// carried its own round trip, its own identity resolution, its own policy
// lookup and its own read of the shared cache, and a page pays that as many
// times as it has visuals. None of that work differs between them.
//
// Visuals do not mount in one synchronous burst, so the queue is flushed on a
// short timer rather than a microtask. The window is small enough to be well
// inside a frame and long enough to gather a page: it is a delay nobody can
// perceive traded for a round trip everybody waits on.
//
// Identical bodies inside one window are sent once and answered to every
// caller, which is the same guarantee SWR gives across renders, extended to
// callers that do not go through it.

const batchWindowMs = 8;

// Matches the server. A larger page is split across requests rather than
// refused.
const maxBatchSize = 50;

interface Waiting {
	body: string;
	resolve: (value: QueryResponse) => void;
	reject: (error: Error) => void;
}

let queue: Waiting[] = [];
let scheduled = false;

// Answers the server sent with the document.
//
// A page whose visuals are already cached can be handed their rows rather than
// asked for them, which removes the last round trip on a first paint: the
// bundle downloads, React hydrates, and the visuals already have what they
// need instead of starting a request at that moment.
//
// Held here rather than in SWR because not everything goes through SWR. The
// grid and the matrix own their rows, and seeding only the hooks would miss
// the visual type this estate has most of.
//
// Replaced wholesale when a page announces a new seed, so it never accumulates
// and never answers for a page the reader has left.
let seeded = new Map<string, QueryResponse>();

export function primeBatchCache(answers: Record<string, unknown>): void {
	seeded = new Map(Object.entries(answers) as [string, QueryResponse][]);
}

interface Slot {
	rows?: Record<string, unknown>[];
	columns?: string[];
	rowCount?: number;
	meta?: QueryResponse["meta"];
	error?: string;
}

async function send(batch: Waiting[]): Promise<void> {
	// One slot per distinct body, with every caller waiting on it recorded
	// against that slot.
	const order: string[] = [];
	const waitingFor = new Map<string, Waiting[]>();
	for (const item of batch) {
		const held = waitingFor.get(item.body);
		if (held) {
			held.push(item);
			continue;
		}
		waitingFor.set(item.body, [item]);
		order.push(item.body);
	}

	try {
		const response = await fetch("/api/query/batch", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: `{"queries":[${order.join(",")}]}`,
		});

		if (!response.ok) {
			const detail = await response.json().catch(() => null);
			const error: Error & { status?: number } = new Error(
				detail?.error ?? `Query failed (${response.status})`,
			);
			error.status = response.status;
			throw error;
		}

		const payload = (await response.json()) as { results?: Slot[] };
		const results = payload.results ?? [];

		order.forEach((body, index) => {
			const waiting = waitingFor.get(body) ?? [];
			const slot = results[index];
			if (!slot || slot.error) {
				const error: Error & { status?: number } = new Error(
					slot?.error ?? "Query failed",
				);
				for (const item of waiting) item.reject(error);
				return;
			}
			const answer: QueryResponse = {
				rows: slot.rows ?? [],
				columns: slot.columns ?? [],
				rowCount: slot.rowCount ?? 0,
				meta: slot.meta as QueryResponse["meta"],
			};
			for (const item of waiting) item.resolve(answer);
		});
	} catch (error) {
		// One failed batch fails only the callers it carried. Each of them
		// reports it the way it would have reported its own request.
		for (const item of batch) item.reject(error as Error);
	}
}

function flush(): void {
	scheduled = false;
	const pending = queue;
	queue = [];
	for (let at = 0; at < pending.length; at += maxBatchSize) {
		void send(pending.slice(at, at + maxBatchSize));
	}
}

// Runs one query, sent with whatever else is asked for in the same window.
//
// body is the canonical JSON of the spec, which is also the SWR key, so the
// string is not rebuilt here.
export function runBatchedQuery(body: string): Promise<QueryResponse> {
	// Already answered with the document. Taken rather than copied, so a seed
	// answers once and everything after it goes to the server the normal way
	// and gets a fresh reading.
	const held = seeded.get(body);
	if (held) {
		seeded.delete(body);
		return Promise.resolve(held);
	}

	return new Promise<QueryResponse>((resolve, reject) => {
		queue.push({ body, resolve, reject });
		if (scheduled) return;
		scheduled = true;
		setTimeout(flush, batchWindowMs);
	});
}
