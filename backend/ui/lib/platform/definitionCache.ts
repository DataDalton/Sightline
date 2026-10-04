import { announce, onChange } from "./changes";
import { perProcess } from "../perProcess";

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
// Held until what it holds changes. The instance that makes a change drops
// its own entries at once and announces the change, and every other replica
// and module instance drops theirs as the announcement arrives. See
// lib/platform/changes. The lifetime below is only a backstop, for a change
// written without being announced.

const ttlMs = 60 * 60 * 1000;

interface Entry {
	value: unknown;
	expiresAt: number;
}

// Kept in order of last use, oldest first. A read moves its key to the end,
// so the first key is always the one to give up when the ceiling is reached.
const entries = perProcess(
	"platform/definitionCache:entries",
	() => new Map<string, Entry>(),
);

// Every key under each prefix that ends at a ':' or '|', so dropping a prefix
// visits only the keys beneath it rather than every key held. Per reader keys
// end their reader's part with '|', which makes dropping one reader's entries
// a lookup.
const families = perProcess(
	"platform/definitionCache:families",
	() => new Map<string, Set<string>>(),
);

function familiesOf(key: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < key.length; i++) {
		const c = key.charCodeAt(i);
		// ':' and '|'
		if (c === 58 || c === 124) out.push(key.slice(0, i + 1));
	}
	return out;
}

function hold(key: string, entry: Entry): void {
	if (entries.has(key)) entries.delete(key);
	else {
		for (const family of familiesOf(key)) {
			let members = families.get(family);
			if (!members) families.set(family, (members = new Set()));
			members.add(key);
		}
	}
	entries.set(key, entry);
	if (entries.size > maxEntries) {
		// The least recently read.
		const oldest = entries.keys().next().value;
		if (oldest !== undefined) release(oldest);
	}
}

function release(key: string): void {
	if (!entries.delete(key)) return;
	for (const family of familiesOf(key)) {
		const members = families.get(family);
		if (!members) continue;
		members.delete(key);
		if (members.size === 0) families.delete(family);
	}
}

// A load in progress, and whether an invalidation reached its key while it
// ran. A load whose key was invalidated may have read the rows the write
// replaced, so it answers its own callers but is not kept. Loads under other
// keys are untouched, so an edit to one report does not discard a navigation
// or search load running at the same moment.
interface Pending {
	promise: Promise<unknown>;
	stale: boolean;
}

const inflight = perProcess(
	"platform/definitionCache:inflight",
	() => new Map<string, Pending>(),
);

// An expired entry is never read, and is dropped as it is found. Walked once
// a minute as well, so entries nobody asks for again do not hold memory until
// the ceiling pushes them out. Run on write rather than on a timer, so a
// module instance that stops being asked stops doing work.
const sweepIntervalMs = 60 * 1000;
let sweptAt = 0;

// How many entries are held at most. Per reader keys make the count follow
// the number of people using the app rather than the number of reports, so
// the ceiling is sized for people. Reaching it drops the entry read longest
// ago, which costs that reader one recomputation.
const maxEntries = 1_000_000;

function sweep(now: number): void {
	if (now - sweptAt < sweepIntervalMs) return;
	sweptAt = now;
	for (const [key, held] of entries) {
		if (held.expiresAt <= now) release(key);
	}
}

export async function cachedDefinition<T>(
	key: string,
	load: () => Promise<T>,
	// A different backstop for an entry built from something that drifts
	// without being announced. Defaults to the definition lifetime.
	lifetimeMs = ttlMs,
): Promise<T> {
	const now = Date.now();

	const held = entries.get(key);
	if (held && held.expiresAt > now) {
		entries.delete(key);
		entries.set(key, held);
		return held.value as T;
	}

	sweep(now);

	// One load per key, however many requests arrive together. Without this a
	// popular report opened by ten people at once is ten identical queries.
	const existing = inflight.get(key);
	if (existing) return existing.promise as Promise<T>;

	const pending = { stale: false } as Pending;
	pending.promise = (async () => {
		const value = await load();
		if (!pending.stale) {
			hold(key, { value, expiresAt: Date.now() + lifetimeMs });
		}
		return value;
	})().finally(() => {
		if (inflight.get(key) === pending) inflight.delete(key);
	});

	inflight.set(key, pending);
	return pending.promise as Promise<T>;
}

// The held value for a key, without loading it. For a caller that gathers the
// keys it is missing and reads them all in one question.
export function peekDefinition<T>(key: string): T | undefined {
	const held = entries.get(key);
	if (!held || held.expiresAt <= Date.now()) return undefined;
	return held.value as T;
}

// Called on the write path. Takes a prefix so one edit can drop everything
// derived from the thing that changed.
//
// A load already running is dropped from the in-flight map as well, so a
// request after the edit starts a fresh read rather than joining one that may
// have read the rows before it.
export function invalidateDefinitions(prefix?: string): void {
	dropDefinitionsLocally(prefix);
	announce("definitions", prefix ?? "");
}

// The same, on this instance only, for applying a change announced by
// another, which must not be announced again.
export function dropDefinitionsLocally(prefix?: string): void {
	if (!prefix) {
		dropMatchingLocally(() => true);
		return;
	}
	// The keys under the longest family the prefix names, of which only those
	// that start with the whole prefix are dropped.
	let cut = -1;
	for (let i = prefix.length - 1; i >= 0; i--) {
		const c = prefix.charCodeAt(i);
		if (c === 58 || c === 124) {
			cut = i;
			break;
		}
	}
	const matches = (key: string) => key.startsWith(prefix);
	if (cut < 0) {
		dropMatchingLocally(matches);
		return;
	}
	const members = families.get(prefix.slice(0, cut + 1));
	if (members) {
		for (const key of [...members]) if (matches(key)) release(key);
	}
	dropInflight(matches);
}

onChange(
	"definitions",
	(prefix) => dropDefinitionsLocally(prefix || undefined),
	() => dropDefinitionsLocally(),
);

// Drops every entry and every load in progress whose key the test accepts, on
// this instance only. A caller that needs the change seen everywhere
// announces it in a form other instances can apply, as access does with its
// own kind of change.
export function dropMatchingLocally(test: (key: string) => boolean): void {
	for (const key of [...entries.keys()]) {
		if (test(key)) release(key);
	}
	dropInflight(test);
}

function dropInflight(test: (key: string) => boolean): void {
	for (const [key, pending] of inflight) {
		if (!test(key)) continue;
		pending.stale = true;
		inflight.delete(key);
	}
}

export function definitionCacheStats(): { entries: number } {
	return { entries: entries.size };
}
