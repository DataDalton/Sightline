import { createHash } from "node:crypto";
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

interface MemoryEntry {
	value: CacheEntry;
	// Insertion counter used for least-recently-used eviction.
	touched: number;
}

const memory = new Map<string, MemoryEntry>();
let counter = 0;

function memoryGet(key: string): CacheEntry | null {
	const found = memory.get(key);
	if (!found) return null;
	found.touched = ++counter;
	return found.value;
}

function memorySet(key: string, value: CacheEntry): void {
	memory.set(key, { value, touched: ++counter });

	const max = settings().resultMaxEntries;
	if (memory.size <= max) return;

	// Drop expired entries first, then the least recently used.
	const now = Date.now();
	for (const [k, v] of memory) {
		if (v.value.expiresAt <= now) memory.delete(k);
	}
	if (memory.size > max) {
		const sorted = Array.from(memory.entries()).sort(
			(a, b) => a[1].touched - b[1].touched,
		);
		for (const [k] of sorted.slice(0, memory.size - max)) {
			memory.delete(k);
		}
	}
}

// --- L2: Lakebase ----------------------------------------------------------

interface CacheRow {
	payload: { rows: Record<string, unknown>[]; columns: string[] };
	row_count: number;
	created_on: string;
	expires_on: string;
}

async function sharedGet(key: string): Promise<CacheEntry | null> {
	try {
		const rows = await sql<CacheRow>(
			`SELECT payload, row_count, created_on, expires_on
			 FROM result_cache
			 WHERE cache_key = $1`,
			[key],
		);
		const row = rows[0];
		if (!row) return null;

		return {
			rows: row.payload.rows ?? [],
			columns: row.payload.columns ?? [],
			rowCount: row.row_count,
			computedAt: new Date(row.created_on).getTime(),
			expiresAt: new Date(row.expires_on).getTime(),
		};
	} catch (error) {
		// A cache read that fails is a miss, never an error the user sees.
		console.warn("Shared cache read failed:", error);
		return null;
	}
}

async function sharedSet(
	key: string,
	policy: PolicyClass,
	source: SemanticSource,
	entry: CacheEntry,
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
				JSON.stringify({ rows: entry.rows, columns: entry.columns }),
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
		if (local.expiresAt > now) return { entry: local, tier: "l1", stale: false };
		if (allowStale) return { entry: local, tier: "l1", stale: true };
	}

	const shared = await sharedGet(key);
	if (shared) {
		// Promote into L1 so the next hit on this replica skips the round trip.
		memorySet(key, shared);
		if (shared.expiresAt > now) {
			return { entry: shared, tier: "l2", stale: false };
		}
		if (allowStale) return { entry: shared, tier: "l2", stale: true };
	}

	return { entry: null, tier: null, stale: false };
}

export async function cacheSet(
	key: string,
	policy: PolicyClass,
	source: SemanticSource,
	rows: Record<string, unknown>[],
	columns: string[],
): Promise<CacheEntry> {
	const now = Date.now();
	const ttlSeconds = source.cacheTtlSeconds || settings().resultTtlSeconds;
	const entry: CacheEntry = {
		rows,
		columns,
		rowCount: rows.length,
		computedAt: now,
		expiresAt: now + ttlSeconds * 1000,
	};

	memorySet(key, entry);
	await sharedSet(key, policy, source, entry);
	return entry;
}

// Drops cached results for one source across both tiers. Called when a dataset
// is refreshed or its semantic definition changes.
export async function invalidateSource(sourceKey: string): Promise<void> {
	for (const key of memory.keys()) {
		if (key.startsWith(`${sourceKey}:`)) memory.delete(key);
	}
	try {
		await sql(`DELETE FROM result_cache WHERE source_key = $1`, [sourceKey]);
	} catch (error) {
		console.warn("Shared cache invalidation failed:", error);
	}
}

export function cacheStats(): { l1Entries: number } {
	return { l1Entries: memory.size };
}
