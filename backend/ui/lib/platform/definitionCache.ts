// What a report is, as opposed to who may see it or what it currently says.
//
// A report definition is the same object for every reader: the pages, the
// visuals on them, and how each is configured. Only the decision about whether
// somebody may open it is per reader, and only the rows inside it are per
// query. So the definition is fetched once and reused, while the access check
// still runs on every request.
//
// Held in memory rather than in Lakebase, because this stands in front of
// Lakebase. Reading it back from there would replace three round trips with
// one, and reading it from here replaces them with none.
//
// A short lifetime rather than a version check, because checking the version is
// itself the round trip this exists to avoid. The replica that handles an edit
// drops its own entry immediately, so an editor never sees their own change
// lag. Another replica serves the previous definition for at most this long.

const ttlMs = 2 * 60 * 1000;

interface Entry {
	value: unknown;
	expiresAt: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

// An expired entry is never read, but it is still held: the map only ever grew,
// one slot per report the installation has, each holding a full definition.
// Swept on write rather than on a timer, so a module instance that stops being
// asked stops doing work.
const sweepIntervalMs = 60 * 1000;
let sweptAt = 0;

// A ceiling as well as a sweep.
//
// The sweep drops what has expired, which is enough while every key is a report
// and an installation has hundreds. Per caller keys changed that: navigation is
// memoised per policy class and reader, so the number of live keys follows the
// number of people using the app rather than the number of reports.
const maxEntries = 50000;

function sweep(now: number): void {
	// The interval bounds the expiry walk. The ceiling below is checked every
	// time, because a burst of distinct callers can cross it inside one
	// interval and the point of a ceiling is that it is not crossed.
	if (now - sweptAt < sweepIntervalMs) {
		if (entries.size > maxEntries) trim();
		return;
	}
	sweptAt = now;
	for (const [key, held] of entries) {
		if (held.expiresAt <= now) entries.delete(key);
	}

	trim();
}

function trim(): void {
	if (entries.size <= maxEntries) return;
	// Oldest expiry first. A dropped entry costs one caller one recomputation.
	const byExpiry = Array.from(entries.entries()).sort(
		(a, b) => a[1].expiresAt - b[1].expiresAt,
	);
	for (const [key] of byExpiry.slice(0, entries.size - maxEntries)) {
		entries.delete(key);
	}
}

export async function cachedDefinition<T>(
	key: string,
	load: () => Promise<T>,
): Promise<T> {
	const now = Date.now();

	const held = entries.get(key);
	if (held && held.expiresAt > now) return held.value as T;

	sweep(now);

	// One load per key, however many requests arrive together. Without this a
	// popular report opened by ten people at once is ten identical queries.
	const existing = inflight.get(key);
	if (existing) return existing as Promise<T>;

	const pending = (async () => {
		try {
			const value = await load();
			entries.set(key, { value, expiresAt: Date.now() + ttlMs });
			return value;
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, pending);
	return pending as Promise<T>;
}

// Called on the write path. Takes a prefix so one edit can drop everything
// derived from the thing that changed.
export function invalidateDefinitions(prefix?: string): void {
	if (!prefix) {
		entries.clear();
		return;
	}
	for (const key of entries.keys()) {
		if (key.startsWith(prefix)) entries.delete(key);
	}
}

export function definitionCacheStats(): { entries: number } {
	return { entries: entries.size };
}
