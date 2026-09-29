import type { Identity } from "../auth/identity";
import { resolvePolicyClass, type PolicyClass } from "../auth/policy";
import { queryAsUser } from "../data/userSession";
import { plainDates } from "../format";
import { applyTransforms } from "./transform";
import { isDatabricksApp } from "../runtime";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import { compileQuery } from "./builder";
import { reachableSet } from "../platform/sources";
import { intervalFor, requestCheck } from "../freshness/checker";
import { overdue } from "../freshness/marks";
import {
	buildCacheKey,
	cacheGet,
	cacheGetMany,
	cacheSet,
	isShareable,
	liveTtlSeconds,
	type CacheEntry,
} from "./cache";
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
	// Set for a live source. How long until the page should ask again, so an
	// open page follows data that streams in.
	refreshAfterMs: number | null;
}

export class QueryAccessError extends Error {}

// Refuses a source the caller cannot read.
//
// Checked before any cache is asked, because a cached answer is keyed by policy
// class or held unscoped, and neither says whether this caller holds a grant on
// the source. reachableSet answers null where no filtering applies, such as
// local development, where the query itself runs under the developer's own
// credentials.
export async function assertCanReadSource(
	identity: Identity,
	sourceKey: string,
): Promise<void> {
	const reachable = await reachableSet(identity);
	if (reachable && !reachable.has(sourceKey)) {
		throw new QueryAccessError("That dataset is not one you can read.");
	}
}

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
	semantic: SemanticSource,
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
		refreshAfterMs: semantic.isLive ? liveTtlSeconds() * 1000 : null,
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

	await assertCanReadSource(identity, source.sourceKey);

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

	// A filtered source whose filters have not been read is answered from the
	// warehouse every time, under this reader token. Slower, and the only
	// reading that cannot hand somebody another reader rows.
	const shareable = isShareable(source);
	const lookup = shareable
		? await cacheGet(key)
		: { entry: null, stale: false, tier: null };

	if (lookup.entry && !lookup.stale) {
		nudge(source);
		return toResult(
			lookup.entry,
			lookup.tier ?? "l1",
			false,
			null,
			startedAt,
			source,
		);
	}

	// Stale entry: return it now and refresh behind the request, so only a
	// genuinely cold class ever waits on the warehouse.
	// A live source is followed as it changes, so an expired answer is not
	// served while a fresh one is fetched. The page is already asking again on
	// the live interval and would draw the old figures twice.
	if (lookup.entry && lookup.stale && !source.isLive) {
		if (!revalidating.has(key)) {
			revalidating.add(key);
			void runAndCache(identity, source, spec, policy, key)
				.catch((error) => {
					console.warn(
						`Background refresh failed for ${key}:`,
						error,
					);
				})
				.finally(() => revalidating.delete(key));
		}
		return toResult(
			lookup.entry,
			lookup.tier ?? "l1",
			true,
			null,
			startedAt,
			source,
		);
	}

	// An answer that may not be shared is not shared in flight either. It was
	// computed under one reader's token.
	const queryStartedAt = Date.now();
	const run = () => runAndCache(identity, source, spec, policy, key);
	const entry = await (shareable ? shareInflight(key, run) : run());
	return toResult(
		entry,
		"warehouse",
		false,
		Date.now() - queryStartedAt,
		startedAt,
		source,
	);
}

// A watched source that has gone too long without a look, because the
// warehouse was stopped and the looks were skipped, is looked at now that a
// reader is here. The answer already held is served meanwhile, as an expired
// one is. See lib/freshness/checker.
function nudge(source: SemanticSource): void {
	if (overdue(source.sourceKey, intervalFor(source))) {
		requestCheck(source.sourceKey);
	}
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
		rows = await queryAsUser(
			identity.userToken,
			compiled.sql,
			compiled.params,
			identity.email.toLowerCase(),
		);
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

	rows = plainDates(rows);

	// Derived figures are worked out here, before the answer is stored, so a
	// cache hit serves them alongside everything else and costs nothing. They
	// are part of the key, so an answer computed with them is never handed to
	// a request that asked without them.
	const derived = applyTransforms(rows, compiled.columns, spec.transforms);

	// Stored only when it may be reused. Writing an answer computed for one
	// reader while the class is not known to be complete would hand it to the
	// next reader the moment the walk finished.
	if (!isShareable(source)) {
		return {
			rows: derived.rows,
			columns: derived.columns,
			rowCount: derived.rows.length,
			computedAt: Date.now(),
			expiresAt: Date.now(),
		};
	}

	return cacheSet(key, policy, source, derived.rows, derived.columns);
}

// --- Several queries at once ------------------------------------------------

// How many warehouse queries one batch will start at the same time.
//
// A batch is one page, and a page that misses on everything should not open
// twenty statements against one warehouse session. The rest queue behind these
// and the reader waits the same total either way, with far less pressure on the
// session.
const maxBatchConcurrency = 6;

export interface BatchOutcome {
	result?: QueryResult;
	error?: string;
	// Set where the caller should treat the failure as a refusal rather than a
	// fault, matching the status the single query endpoint would have answered.
	status?: number;
}

// Runs a page's worth of queries together.
//
// Identical to calling executeQuery for each, with two differences that matter
// at the size a real page reaches: the caller's policy class is resolved once
// rather than per query, and the shared cache is asked about every key in one
// round trip rather than one per visual. Everything after that is the same code
// path, so a batched query and a single one produce the same entry under the
// same key.
export async function executeQueries(
	identity: Identity,
	specs: QuerySpec[],
): Promise<BatchOutcome[]> {
	const startedAt = Date.now();

	const policy = await resolvePolicyClass(identity);
	if (policy.degraded) {
		return specs.map(() => ({
			error: "Access could not be verified. Group membership is temporarily unavailable.",
			status: 403,
		}));
	}

	// Asked once for the batch. A spec on a source outside it is refused
	// before any cache is asked.
	let reachable: Set<string> | null;
	try {
		reachable = await reachableSet(identity);
	} catch (error) {
		console.warn("Source access could not be resolved:", error);
		return specs.map(() => ({
			error: "Access could not be verified.",
			status: 403,
		}));
	}
	const refused = new Set<number>();

	// Resolved once per spec and kept, so nothing is recomputed below.
	const prepared = specs.map((spec, index) => {
		const source = getSource(spec.sourceKey);
		if (!source) return null;
		if (reachable && !reachable.has(source.sourceKey)) {
			refused.add(index);
			return null;
		}
		return {
			spec,
			source,
			shareable: isShareable(source),
			key: buildCacheKey(source, spec, policy),
		};
	});

	// Only the shareable ones have a key worth asking about. An unshareable
	// source is answered from the warehouse every time by construction.
	const lookups = await cacheGetMany(
		prepared
			.filter((p) => p !== null && p.shareable)
			.map((p) => (p as NonNullable<typeof p>).key),
	);

	const outcomes: BatchOutcome[] = new Array(specs.length);
	const pending: number[] = [];

	prepared.forEach((entry, index) => {
		if (refused.has(index)) {
			outcomes[index] = {
				error: "That dataset is not one you can read.",
				status: 403,
			};
			return;
		}
		if (!entry) {
			outcomes[index] = {
				error: `Unknown source "${specs[index].sourceKey}"`,
				status: 400,
			};
			return;
		}

		const lookup = entry.shareable
			? (lookups.get(entry.key) ?? {
					entry: null,
					tier: null,
					stale: false,
				})
			: { entry: null, tier: null, stale: false };

		if (lookup.entry && !lookup.stale) {
			nudge(entry.source);
			outcomes[index] = {
				result: toResult(
					lookup.entry,
					lookup.tier ?? "l1",
					false,
					null,
					startedAt,
					entry.source,
				),
			};
			return;
		}

		if (lookup.entry && lookup.stale && !entry.source.isLive) {
			// Served now, refreshed behind the response, exactly as the single
			// query path does it.
			if (!revalidating.has(entry.key)) {
				revalidating.add(entry.key);
				void runAndCache(
					identity,
					entry.source,
					entry.spec,
					policy,
					entry.key,
				)
					.catch((error) => {
						console.warn(
							`Background refresh failed for ${entry.key}:`,
							error,
						);
					})
					.finally(() => revalidating.delete(entry.key));
			}
			outcomes[index] = {
				result: toResult(
					lookup.entry,
					lookup.tier ?? "l1",
					true,
					null,
					startedAt,
					entry.source,
				),
			};
			return;
		}

		pending.push(index);
	});

	if (pending.length === 0) return outcomes;

	// The cold ones, a few at a time.
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const slot = next++;
			if (slot >= pending.length) return;
			const index = pending[slot];
			const entry = prepared[index];
			if (!entry) continue;

			const queryStartedAt = Date.now();
			try {
				const run = () =>
					runAndCache(
						identity,
						entry.source,
						entry.spec,
						policy,
						entry.key,
					);
				const answered = await (entry.shareable
					? shareInflight(entry.key, run)
					: run());
				outcomes[index] = {
					result: toResult(
						answered,
						"warehouse",
						false,
						Date.now() - queryStartedAt,
						startedAt,
						entry.source,
					),
				};
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Query failed";
				outcomes[index] = {
					error: message,
					status: error instanceof QueryAccessError ? 403 : 500,
				};
			}
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(maxBatchConcurrency, pending.length) },
			worker,
		),
	);

	return outcomes;
}
