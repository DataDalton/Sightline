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

const ttlMs = 30 * 1000;

interface Entry {
	value: unknown;
	expiresAt: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export async function cachedDefinition<T>(
	key: string,
	load: () => Promise<T>,
): Promise<T> {
	const now = Date.now();

	const held = entries.get(key);
	if (held && held.expiresAt > now) return held.value as T;

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
