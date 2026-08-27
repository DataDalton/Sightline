"use client";

// What a visual has already asked for, kept outside the component.
//
// Charts go through SWR, so leaving a report and coming back re-renders them
// from cache. The grid and the matrix own their rows as component state
// instead, because they page, expand and reorder them, and state does not
// survive unmount: navigating away and back threw everything out and asked
// again, which is a full reload of what the reader just waited for.
//
// Bounded by count and by age. Age because a tab left open overnight should not
// show yesterday's numbers on a revisit, and count because a reader who opens
// forty reports should not be holding forty result sets.

export interface ResultMemo<T> {
	get(key: string): T | null;
	set(key: string, value: T): void;
	clear(): void;
}

interface Held<T> {
	value: T;
	at: number;
}

export function createResultMemo<T>(
	maxEntries: number,
	// A function rather than a number, so a memo built at module scope still
	// sees a lifetime the server supplies later.
	maxAgeMs: () => number,
): ResultMemo<T> {
	const held = new Map<string, Held<T>>();

	return {
		get(key) {
			const found = held.get(key);
			if (!found) return null;
			if (Date.now() - found.at > maxAgeMs()) {
				held.delete(key);
				return null;
			}
			// Re-inserted so insertion order is recency order, which is what
			// makes evicting the first key evict the least recently used.
			held.delete(key);
			held.set(key, found);
			return found.value;
		},
		set(key, value) {
			held.delete(key);
			held.set(key, { value, at: Date.now() });
			while (held.size > maxEntries) {
				const oldest = held.keys().next().value;
				if (oldest === undefined) break;
				held.delete(oldest);
			}
		},
		clear() {
			held.clear();
		},
	};
}

// How long a held result may be shown.
//
// This is meant to match the lifetime the server gives an answer, so a page
// held here is never older than one the server would hand back anyway. It was a
// constant mirroring another constant, which stayed true only while nobody
// changed either: the source lifetime moved from five minutes to an hour and
// this kept throwing away rows the server would still have served.
//
// Read from the server instead, with the old value as the floor for a client
// that has not been told yet.
let serverTtlMs = 5 * 60 * 1000;

export function resultMaxAge(): number {
	return serverTtlMs;
}

// Called once the branding payload arrives, which carries the setting.
export function setResultMaxAge(seconds: number): void {
	if (Number.isFinite(seconds) && seconds > 0) {
		serverTtlMs = seconds * 1000;
	}
}
