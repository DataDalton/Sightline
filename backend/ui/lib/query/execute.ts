import type { Identity } from "../auth/identity";
import { resolvePolicyClass, type PolicyClass } from "../auth/policy";
import { queryAsUser } from "../data/userSession";
import { plainDates } from "../format";
import { applyTransforms } from "./transform";
import { pagedSpec, sliceWindow, type RowWindow } from "./paging";
import { isDatabricksApp } from "../runtime";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import { assertFieldsPresent, compileQuery } from "./builder";
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
	promoteNewerShared,
	type CacheEntry,
} from "./cache";
import { createGate } from "./gate";
import { QuerySpecError, type QuerySpec } from "./spec";
import { perProcess } from "../perProcess";

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
const revalidating = perProcess(
	"query/execute:revalidating",
	() => new Set<string>(),
);

// How many warehouse queries one batch will start at the same time.
//
// A batch is one page, and a page that misses on everything should not open
// twenty statements against one warehouse session. The rest queue behind these
// and the reader waits the same total either way, with far less pressure on the
// session.
const maxBatchConcurrency = 6;

// Refreshes behind stale responses, across every request on this replica.
//
// A page whose answers expired together asks for all of them in one burst, and
// each stale answer starts a refresh. Run unbounded, that burst opens one
// statement per visual on the same warehouse session. Sized like a batch, so
// background work never presses on a session harder than a cold page does.
const backgroundRefreshes = perProcess(
	"query/execute:backgroundRefreshes",
	() => createGate(maxBatchConcurrency),
);

// Refreshes a stale entry behind the response that served it.
//
// Another replica may have refreshed the same key already, so the shared tier
// is asked first, and a newer answer found there is taken in place of a
// warehouse query. Only one refresh per key runs at a time on this replica.
function refreshBehind(
	identity: Identity,
	source: SemanticSource,
	spec: QuerySpec,
	policy: PolicyClass,
	key: string,
	held: CacheEntry,
): void {
	if (revalidating.has(key)) return;
	revalidating.add(key);
	void backgroundRefreshes
		.run(async () => {
			if (await promoteNewerShared(key, held)) return;
			await runAndCache(identity, source, spec, policy, key);
		})
		.catch((error) => {
			console.warn(`Background refresh failed for ${key}:`, error);
		})
		.finally(() => revalidating.delete(key));
}

// Shares an in-flight warehouse query between concurrent callers waiting on
// the same key. Without this, N users hitting a cold entry at once produce N
// identical warehouse queries.
const inflight = perProcess(
	"query/execute:inflight",
	() => new Map<string, Promise<CacheEntry>>(),
);

function toResult(
	entry: CacheEntry,
	source: QueryResult["source"],
	stale: boolean,
	queryMs: number | null,
	startedAt: number,
	semantic: SemanticSource,
	window: RowWindow | null,
): QueryResult {
	// A spec widened by pagedSpec is cached whole, and the page it asked for is
	// cut out here, on a hit and a miss alike.
	const rows = sliceWindow(entry.rows, window);
	return {
		rows,
		columns: entry.columns,
		rowCount: window ? rows.length : entry.rowCount,
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

	// A field the source stopped publishing is named as such before any cache
	// is asked. The error is a QuerySpecError, so the caller passes its
	// message to the reader, and it names only the field.
	assertFieldsPresent(source, spec);

	const policy = await resolvePolicyClass(identity);

	// A policy class that could not be resolved means the platform does not
	// know what this caller may see. Serving anything would be a guess, so the
	// data is refused while the rest of the app keeps working.
	if (policy.degraded) {
		throw new QueryAccessError(
			"Access could not be verified. Group membership is temporarily unavailable.",
		);
	}

	// Derived figures that read every row are worked out over the whole
	// answer, which is what is run and cached. See lib/query/paging.
	const { spec: runSpec, window } = pagedSpec(spec);
	const key = buildCacheKey(source, runSpec, policy);

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
			window,
		);
	}

	// Stale entry: return it now and refresh behind the request, so only a
	// genuinely cold class ever waits on the warehouse.
	// A live source is followed as it changes, so an expired answer is not
	// served while a fresh one is fetched. The page is already asking again on
	// the live interval and would draw the old figures twice.
	if (lookup.entry && lookup.stale && !source.isLive) {
		refreshBehind(identity, source, runSpec, policy, key, lookup.entry);
		return toResult(
			lookup.entry,
			lookup.tier ?? "l1",
			true,
			null,
			startedAt,
			source,
			window,
		);
	}

	// An answer that may not be shared is not shared in flight either. It was
	// computed under one reader's token.
	const queryStartedAt = Date.now();
	const run = () => runAndCache(identity, source, runSpec, policy, key);
	const entry = await (shareable ? shareInflight(key, run) : run());
	return toResult(
		entry,
		"warehouse",
		false,
		Date.now() - queryStartedAt,
		startedAt,
		source,
		window,
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
//
// onOutcome, when given, is told about each query the moment it settles, so a
// caller can answer cached queries without waiting for the cold ones. Answers
// found in cache settle before any warehouse query starts. Every query is
// reported exactly once, and the full list is still returned at the end.
export async function executeQueries(
	identity: Identity,
	specs: QuerySpec[],
	onOutcome?: (index: number, outcome: BatchOutcome) => void,
): Promise<BatchOutcome[]> {
	const startedAt = Date.now();

	const outcomes: BatchOutcome[] = new Array(specs.length);
	const settle = (index: number, outcome: BatchOutcome): void => {
		outcomes[index] = outcome;
		onOutcome?.(index, outcome);
	};
	const settleAll = (outcome: BatchOutcome): BatchOutcome[] => {
		specs.forEach((_, index) => settle(index, { ...outcome }));
		return outcomes;
	};

	const policy = await resolvePolicyClass(identity);
	if (policy.degraded) {
		return settleAll({
			error: "Access could not be verified. Group membership is temporarily unavailable.",
			status: 403,
		});
	}

	// Asked once for the batch. A spec on a source outside it is refused
	// before any cache is asked.
	let reachable: Set<string> | null;
	try {
		reachable = await reachableSet(identity);
	} catch (error) {
		console.warn("Source access could not be resolved:", error);
		return settleAll({
			error: "Access could not be verified.",
			status: 403,
		});
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
		// The spec that is run and cached, which for a paged query with
		// whole-answer figures is the whole answer. The one asked for is kept
		// for the checks that name its fields.
		const { spec: runSpec, window } = pagedSpec(spec);
		return {
			spec,
			runSpec,
			window,
			source,
			shareable: isShareable(source),
			key: buildCacheKey(source, runSpec, policy),
		};
	});

	// Only the shareable ones have a key worth asking about. An unshareable
	// source is answered from the warehouse every time by construction.
	const lookups = await cacheGetMany(
		prepared
			.filter((p) => p !== null && p.shareable)
			.map((p) => (p as NonNullable<typeof p>).key),
	);

	const pending: number[] = [];

	prepared.forEach((entry, index) => {
		if (refused.has(index)) {
			settle(index, {
				error: "That dataset is not one you can read.",
				status: 403,
			});
			return;
		}
		if (!entry) {
			settle(index, {
				error: `Unknown source "${specs[index].sourceKey}"`,
				status: 400,
			});
			return;
		}

		// Named before the cache is asked, as the single query path does.
		try {
			assertFieldsPresent(entry.source, entry.spec);
		} catch (error) {
			settle(index, {
				error: (error as Error).message,
				status: 400,
			});
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
			settle(index, {
				result: toResult(
					lookup.entry,
					lookup.tier ?? "l1",
					false,
					null,
					startedAt,
					entry.source,
					entry.window,
				),
			});
			return;
		}

		if (lookup.entry && lookup.stale && !entry.source.isLive) {
			// Served now, refreshed behind the response, exactly as the single
			// query path does it.
			refreshBehind(
				identity,
				entry.source,
				entry.runSpec,
				policy,
				entry.key,
				lookup.entry,
			);
			settle(index, {
				result: toResult(
					lookup.entry,
					lookup.tier ?? "l1",
					true,
					null,
					startedAt,
					entry.source,
					entry.window,
				),
			});
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
						entry.runSpec,
						policy,
						entry.key,
					);
				const answered = await (entry.shareable
					? shareInflight(entry.key, run)
					: run());
				settle(index, {
					result: toResult(
						answered,
						"warehouse",
						false,
						Date.now() - queryStartedAt,
						startedAt,
						entry.source,
						entry.window,
					),
				});
			} catch (error) {
				// A refusal or a problem with the request is the reader's to
				// read, a missing field included. A warehouse error can carry
				// schema details, so it is logged rather than returned.
				const readable =
					error instanceof QueryAccessError ||
					error instanceof QuerySpecError;
				if (!readable) {
					console.error(`Query failed for ${entry.key}:`, error);
				}
				settle(index, {
					error: readable ? (error as Error).message : "Query failed",
					status:
						error instanceof QueryAccessError
							? 403
							: error instanceof QuerySpecError
								? 400
								: 500,
				});
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
