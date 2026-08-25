import type { Identity } from "../auth/identity";
import { resolvePolicyClass, type PolicyClass } from "../auth/policy";
import { queryAsUser } from "../data/userSession";
import { isDatabricksApp } from "../runtime";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import { compileQuery } from "./builder";
import { buildCacheKey, cacheGet, cacheSet, type CacheEntry } from "./cache";
import { QuerySpecError, type QuerySpec } from "./spec";

// Runs a query spec for one caller. This is the single entry point every
// visual, table and export goes through.
//
// Order matters and is enforced here rather than left to callers:
//   1. Resolve the caller policy class, and refuse if it could not be resolved.
//   2. Look in cache, keyed by that class.
//   3. On a miss, run against the warehouse under the caller own token, so
//      Unity Catalog applies row filters during the scan.
//   4. Cache the filtered result under the class that produced it.

export interface QueryResult {
	rows: Record<string, unknown>[];
	columns: string[];
	rowCount: number;
	// Where the result came from, for the client and for telemetry.
	source: "l1" | "l2" | "warehouse";
	// True when a stale entry was served while a refresh runs behind it.
	stale: boolean;
	computedAt: number;
	// Warehouse time, absent on a cache hit.
	queryMs: number | null;
	// End to end time the caller waited.
	durationMs: number;
}

export class QueryAccessError extends Error {}

// Tracks refreshes running behind a stale response, so a burst of requests for
// the same key triggers one warehouse query rather than one each.
const revalidating = new Set<string>();

// Shares an in-flight warehouse query between concurrent callers waiting on
// the same key. Without this, N users hitting a cold entry at once produce N
// identical warehouse queries.
const inflight = new Map<string, Promise<CacheEntry>>();

function toResult(
	entry: CacheEntry,
	source: QueryResult["source"],
	stale: boolean,
	queryMs: number | null,
	startedAt: number,
): QueryResult {
	return {
		rows: entry.rows,
		columns: entry.columns,
		rowCount: entry.rowCount,
		source,
		stale,
		computedAt: entry.computedAt,
		queryMs,
		durationMs: Date.now() - startedAt,
	};
}

export async function executeQuery(
	identity: Identity,
	spec: QuerySpec,
): Promise<QueryResult> {
	const startedAt = Date.now();

	const source = getSource(spec.sourceKey);
	if (!source) {
		throw new QuerySpecError(`Unknown source "${spec.sourceKey}"`);
	}

	const policy = await resolvePolicyClass(identity);

	// A policy class that could not be resolved means the platform does not
	// know what this caller may see. Serving anything would be a guess, so the
	// data is refused while the rest of the app keeps working.
	if (policy.degraded) {
		throw new QueryAccessError(
			"Access could not be verified. Group membership is temporarily unavailable.",
		);
	}

	const key = buildCacheKey(source, spec, policy);
	const lookup = await cacheGet(key);

	if (lookup.entry && !lookup.stale) {
		return toResult(
			lookup.entry,
			lookup.tier ?? "l1",
			false,
			null,
			startedAt,
		);
	}

	// Stale entry: return it now and refresh behind the request, so only a
	// genuinely cold class ever waits on the warehouse.
	if (lookup.entry && lookup.stale) {
		if (!revalidating.has(key)) {
			revalidating.add(key);
			void runAndCache(identity, source, spec, policy, key)
				.catch((error) => {
					console.warn(`Background refresh failed for ${key}:`, error);
				})
				.finally(() => revalidating.delete(key));
		}
		return toResult(lookup.entry, lookup.tier ?? "l1", true, null, startedAt);
	}

	const queryStartedAt = Date.now();
	const entry = await shareInflight(key, () =>
		runAndCache(identity, source, spec, policy, key),
	);
	return toResult(
		entry,
		"warehouse",
		false,
		Date.now() - queryStartedAt,
		startedAt,
	);
}

function shareInflight(
	key: string,
	run: () => Promise<CacheEntry>,
): Promise<CacheEntry> {
	const existing = inflight.get(key);
	if (existing) return existing;

	const pending = run().finally(() => inflight.delete(key));
	inflight.set(key, pending);
	return pending;
}

async function runAndCache(
	identity: Identity,
	source: SemanticSource,
	spec: QuerySpec,
	policy: PolicyClass,
	key: string,
): Promise<CacheEntry> {
	const compiled = compileQuery(source, spec);

	let rows;
	if (identity.userToken) {
		// The normal path: Unity Catalog filters rows for this caller.
		rows = await queryAsUser(identity.userToken, compiled.sql, compiled.params);
	} else if (!isDatabricksApp) {
		// Development only. Runs as the local Databricks credentials, so row
		// filtering reflects that identity rather than the caller's. The
		// module itself refuses to load in a deployed app.
		const { queryLocally } = await import("../data/localSession");
		rows = await queryLocally(compiled.sql, compiled.params);
	} else {
		throw new QueryAccessError(
			"A user token is required to query data. Enable user authorization " +
				"with the sql scope on the app.",
		);
	}

	return cacheSet(key, policy, source, rows, compiled.columns);
}
