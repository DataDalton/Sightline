import { createHash } from "node:crypto";
import { filterDiscoveryComplete } from "../semantic/filterDiscovery";
import { sql } from "../data/lakebase";
import { settings } from "../settings";
import type { PolicyClass } from "../auth/policy";
import type { SemanticSource } from "../semantic/types";
import { canonicalizeSpec, type QuerySpec } from "./spec";

// Three cache tiers in front of the warehouse:
//
//   L1  per-replica memory   microseconds, lost on restart
//   L2  Lakebase result_cache  milliseconds, shared across replicas, survives
//                              restarts, so a cold replica does not go
//                              straight to the warehouse
//   L3  the warehouse itself   seconds, and the only authoritative source
//
// The policy class is part of the key by construction. A caller cannot build a
// key without one, so there is no code path that caches a filtered result
// under a shareable key.

export interface CacheEntry {
	rows: Record<string, unknown>[];
	columns: string[];
	rowCount: number;
	// When the entry was computed, so callers can show data freshness.
	computedAt: number;
	expiresAt: number;
}

export interface CacheLookup {
	entry: CacheEntry | null;
	tier: "l1" | "l2" | null;
	// True when the entry is past its TTL but still usable while a refresh
	// runs behind the request.
	stale: boolean;
}

// Builds the cache key. Sources that Unity Catalog filters are keyed by policy
// class; unfiltered sources return identical rows to everyone and so share one
// entry across the whole population.
//
// This is the single most security-relevant function in the query path: get it
// wrong and one group reads another group rows.
// Whether an answer from this source may be reused for another reader.
//
// A filtered source is only shareable within a policy class, and a policy class
// is only meaningful once every group its filters branch on is being probed.
// Until the catalogue walk has finished cleanly the class is not known to be
// complete, so two readers entitled to different rows could carry the same one.
// The safe reading of an unfinished walk is that nothing filtered is shareable,
// which costs warehouse time and never costs somebody else rows.
export function isShareable(source: SemanticSource): boolean {
	return !source.hasRowFilter || filterDiscoveryComplete();
}

export function buildCacheKey(
	source: SemanticSource,
	spec: QuerySpec,
	policy: PolicyClass,
): string {
	const scope = source.hasRowFilter ? policy.id : "unfiltered";
	const digest = createHash("sha256")
		.update(canonicalizeSpec(spec))
		.digest("hex")
		.slice(0, 32);
	// The scope is a literal prefix rather than part of the hashed input, so
	// no digest collision can ever cross a policy boundary.
	return `${source.sourceKey}:${scope}:${digest}`;
}

// --- L1: per-replica memory ------------------------------------------------

// Bounded by weight, not by count.
//
// A result is whatever the query returned, and those differ by four orders of
// magnitude: a scorecard holds one row, a grid page holds a few hundred, an
// unaggregated extract holds the query limit. Counting entries prices all of
// them the same, so a ceiling set where a thousand small results fit is a
// ceiling a hundred large ones blow through without ever reaching. Measured on
// representative rows, a single 50000-row result holds about 79MB, so the old
// two thousand entry cap stood at roughly 150GB and the container died long
// before eviction ran once.
//
// Weight is measured from the JSON the L2 write already produces, so nothing is
// serialized twice. Resident objects cost more than their serialized form, near
// enough to double on the shapes measured, and the multiplier below carries
// that so the budget can be stated in the memory it is actually protecting.
const residentPerJsonByte = 2;

// Evicting exactly enough to fit means the next insert evicts again, and each
// eviction orders the whole map. Dropping to a low mark instead amortizes that
// over the entries the headroom absorbs.
const evictionLowMark = 0.8;

// The largest share of the budget one entry may hold. Past this it is served
// to the caller and not retained: a single result big enough to evict most of
// the cache costs every other reader their hits to benefit one query shape.
const maxEntryShare = 0.25;

interface MemoryEntry {
	value: CacheEntry;
	// Insertion counter used for least-recently-used eviction.
	touched: number;
	bytes: number;
}

const memory = new Map<string, MemoryEntry>();
let counter = 0;
let heldBytes = 0;

function budgetBytes(): number {
	return settings().resultMaxBytes * 1024 * 1024;
}

function memoryGet(key: string): CacheEntry | null {
	const found = memory.get(key);
	if (!found) return null;
	found.touched = ++counter;
	return found.value;
}

function memoryDelete(key: string): void {
	const held = memory.get(key);
	if (!held) return;
	heldBytes -= held.bytes;
	memory.delete(key);
}

// jsonBytes is the length of the serialized payload. Callers that already have
// it pass it; the rest estimate, because measuring costs a serialization this
// is trying to avoid.
function memorySet(key: string, value: CacheEntry, jsonBytes: number): void {
	const bytes = jsonBytes * residentPerJsonByte;
	const budget = budgetBytes();

	// Too big to hold without evicting most of what is there. The caller still
	// has its answer, so this costs a repeat query and not a wrong one.
	if (bytes > budget * maxEntryShare) {
		memoryDelete(key);
		return;
	}

	memoryDelete(key);
	memory.set(key, { value, touched: ++counter, bytes });
	heldBytes += bytes;

	const max = settings().resultMaxEntries;
	if (heldBytes <= budget && memory.size <= max) return;

	// Expired entries first: they are free to drop and cost nobody a hit.
	const now = Date.now();
	for (const [k, v] of memory) {
		if (v.value.expiresAt <= now) memoryDelete(k);
	}

	const targetBytes = budget * evictionLowMark;
	const targetCount = Math.floor(max * evictionLowMark);
	if (heldBytes <= targetBytes && memory.size <= targetCount) return;

	// Ordered once, then walked. The low mark above is what keeps this from
	// running on every insert.
	const byAge = Array.from(memory.entries()).sort(
		(a, b) => a[1].touched - b[1].touched,
	);
	for (const [k] of byAge) {
		if (heldBytes <= targetBytes && memory.size <= targetCount) break;
		// Never evict what was just inserted: the caller is about to read it.
		if (k === key) continue;
		memoryDelete(k);
	}
}

// --- L2: Lakebase ----------------------------------------------------------

interface CacheRow {
	payload: { rows: Record<string, unknown>[]; columns: string[] };
	row_count: number;
	created_on: string;
	expires_on: string;
}

function toEntry(row: CacheRow): CacheEntry {
	return {
		rows: row.payload.rows ?? [],
		columns: row.payload.columns ?? [],
		rowCount: row.row_count,
		computedAt: new Date(row.created_on).getTime(),
		expiresAt: new Date(row.expires_on).getTime(),
	};
}

async function sharedGet(
	key: string,
): Promise<{ entry: CacheEntry; bytes: number } | null> {
	try {
		const rows = await sql<CacheRow>(
			`SELECT payload, row_count, created_on, expires_on
			 FROM result_cache
			 WHERE cache_key = $1`,
			[key],
		);
		const row = rows[0];
		if (!row) return null;

		const entry = toEntry(row);

		// Estimated rather than measured. Serializing it back to weigh it would
		// cost as much as the read did, and the estimate only has to be close
		// enough to keep the budget honest.
		const bytes = estimateJsonBytes(entry);
		return { entry, bytes };
	} catch (error) {
		// A cache read that fails is a miss, never an error the user sees.
		console.warn("Shared cache read failed:", error);
		return null;
	}
}

// Reads several keys as one question.
//
// A page asks one query per visual, and each of those used to check the shared
// tier on its own connection. Twenty visuals meant twenty round trips to
// Postgres before any of them could decide whether it needed the warehouse, and
// the pool holds ten connections, so half of them queued behind the others
// while holding a request open.
//
// Memory is consulted first and only what is missing is asked for, so a warm
// replica does no database work at all.
export async function cacheGetMany(
	keys: string[],
): Promise<Map<string, CacheLookup>> {
	const now = Date.now();
	const allowStale = settings().staleWhileRevalidate;
	const found = new Map<string, CacheLookup>();

	// Deduplicated, because two visuals on a page regularly ask the same
	// question and the answer is one row either way.
	const wanted = Array.from(new Set(keys));
	const missing: string[] = [];

	for (const key of wanted) {
		const local = memoryGet(key);
		if (local && local.expiresAt > now) {
			found.set(key, { entry: local, tier: "l1", stale: false });
			continue;
		}
		if (local && allowStale) {
			found.set(key, { entry: local, tier: "l1", stale: true });
			continue;
		}
		missing.push(key);
	}

	if (missing.length > 0) {
		try {
			const rows = await sql<CacheRow & { cache_key: string }>(
				`SELECT cache_key, payload, row_count, created_on, expires_on
				 FROM result_cache
				 WHERE cache_key = ANY($1)`,
				[missing],
			);
			for (const row of rows) {
				const entry = toEntry(row);
				// Promoted, so a second page asking the same question on this
				// replica does no database work.
				memorySet(row.cache_key, entry, estimateJsonBytes(entry));
				if (entry.expiresAt > now) {
					found.set(row.cache_key, {
						entry,
						tier: "l2",
						stale: false,
					});
				} else if (allowStale) {
					found.set(row.cache_key, {
						entry,
						tier: "l2",
						stale: true,
					});
				}
			}
		} catch (error) {
			// A failed read is a miss for everything it covered, never an error
			// the caller sees.
			console.warn("Shared cache batch read failed:", error);
		}
	}

	for (const key of wanted) {
		if (!found.has(key)) {
			found.set(key, { entry: null, tier: null, stale: false });
		}
	}
	return found;
}

// Weight without serializing. Samples the first rows rather than walking every
// one, because this runs on the read path and a thousand-row result would cost
// more to measure than to return.
function estimateJsonBytes(entry: CacheEntry): number {
	if (entry.rows.length === 0) return 64;
	const sampleSize = Math.min(entry.rows.length, 20);
	let sampled = 0;
	for (let i = 0; i < sampleSize; i++) {
		sampled += JSON.stringify(entry.rows[i]).length;
	}
	return Math.round((sampled / sampleSize) * entry.rows.length) + 64;
}

async function sharedSet(
	key: string,
	policy: PolicyClass,
	source: SemanticSource,
	entry: CacheEntry,
	payload: string,
): Promise<void> {
	try {
		await sql(
			`INSERT INTO result_cache
			   (cache_key, policy_class, source_key, payload, row_count, created_on, expires_on)
			 VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7))
			 ON CONFLICT (cache_key) DO UPDATE SET
			   payload = EXCLUDED.payload,
			   row_count = EXCLUDED.row_count,
			   created_on = EXCLUDED.created_on,
			   expires_on = EXCLUDED.expires_on`,
			[
				key,
				source.hasRowFilter ? policy.id : "unfiltered",
				source.sourceKey,
				payload,
				entry.rowCount,
				entry.computedAt / 1000,
				entry.expiresAt / 1000,
			],
		);
	} catch (error) {
		// A cache write that fails costs performance, not correctness.
		console.warn("Shared cache write failed:", error);
	}
}

// --- Public interface ------------------------------------------------------

export async function cacheGet(key: string): Promise<CacheLookup> {
	const now = Date.now();
	const allowStale = settings().staleWhileRevalidate;

	const local = memoryGet(key);
	if (local) {
		if (local.expiresAt > now)
			return { entry: local, tier: "l1", stale: false };
		if (allowStale) return { entry: local, tier: "l1", stale: true };
	}

	const shared = await sharedGet(key);
	if (shared) {
		// Promote into L1 so the next hit on this replica skips the round trip.
		memorySet(key, shared.entry, shared.bytes);
		if (shared.entry.expiresAt > now) {
			return { entry: shared.entry, tier: "l2", stale: false };
		}
		if (allowStale) return { entry: shared.entry, tier: "l2", stale: true };
	}

	return { entry: null, tier: null, stale: false };
}

// Which of these keys already hold a fresh answer.
//
// Asked as one question rather than one per key. Warming decides what is worth
// a warehouse query by checking every spec a report would make, and a key that
// is not in memory costs a round trip to Postgres to rule out, so checking a
// hundred specs one at a time spent a hundred round trips deciding what not to
// do. That cost is what kept the warmer looking at five reports.
//
// Nothing is promoted into memory here. The caller wants to know what to skip,
// not to read the rows, and pulling a payload it will not use would trade the
// round trips this removes for the bytes it does not need.
export async function cacheFresh(keys: string[]): Promise<Set<string>> {
	const now = Date.now();
	const fresh = new Set<string>();
	const unknown: string[] = [];

	for (const key of keys) {
		const held = memory.get(key);
		if (held && held.value.expiresAt > now) fresh.add(key);
		else unknown.push(key);
	}

	if (unknown.length === 0) return fresh;

	try {
		const rows = await sql<{ cache_key: string }>(
			`SELECT cache_key FROM result_cache
			 WHERE cache_key = ANY($1) AND expires_on > now()`,
			[unknown],
		);
		for (const row of rows) fresh.add(row.cache_key);
	} catch (error) {
		// A failed check means warming does more work than it needed to, never
		// that it does the wrong work.
		console.warn("Bulk cache check failed:", error);
	}

	return fresh;
}

export async function cacheSet(
	key: string,
	policy: PolicyClass,
	source: SemanticSource,
	rows: Record<string, unknown>[],
	columns: string[],
): Promise<CacheEntry> {
	const now = Date.now();
	// A source may set its own, and zero means it does not.
	//
	// Every source row carried 300 by default and any positive number wins
	// here, so the platform-wide setting was unreachable: changing it did
	// nothing to any source, because every source had already answered the
	// question with a value nobody chose.
	const ttlSeconds =
		source.cacheTtlSeconds > 0
			? source.cacheTtlSeconds
			: settings().resultTtlSeconds;
	const entry: CacheEntry = {
		rows,
		columns,
		rowCount: rows.length,
		computedAt: now,
		expiresAt: now + ttlSeconds * 1000,
	};

	// Serialized once, here, and used for both the weight and the write.
	const payload = JSON.stringify({ rows, columns });
	memorySet(key, entry, payload.length);

	// Not awaited. Nothing in this request reads it back, and the caller has
	// been holding a finished result while a payload of several megabytes went
	// to Postgres. A failed write is already handled as a miss on the next read.
	void sharedSet(key, policy, source, entry, payload);

	return entry;
}

// Drops cached results for one source across both tiers. Called when a dataset
// is refreshed or its semantic definition changes.
export async function invalidateSource(sourceKey: string): Promise<void> {
	for (const key of Array.from(memory.keys())) {
		if (key.startsWith(`${sourceKey}:`)) memoryDelete(key);
	}
	try {
		await sql(`DELETE FROM result_cache WHERE source_key = $1`, [
			sourceKey,
		]);
	} catch (error) {
		console.warn("Shared cache invalidation failed:", error);
	}
}

export function cacheStats(): {
	l1Entries: number;
	l1Bytes: number;
	l1BudgetBytes: number;
} {
	return {
		l1Entries: memory.size,
		l1Bytes: heldBytes,
		l1BudgetBytes: budgetBytes(),
	};
}
