import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { queryAsUser } from "../data/userSession";
import { plainDates } from "../format";
import { isDatabricksApp } from "../runtime";
import { getSource } from "../semantic/registry";
import { settings } from "../settings";
import { compileQuery } from "./builder";
import { assertCanReadSource, QueryAccessError } from "./execute";
import { changedSince } from "../freshness/marks";
import {
	buildSharedKey,
	isShareable,
	liveTtlSeconds,
	sharedValueGet,
	sharedValueSet,
} from "./cache";
import { QuerySpecError, type QueryFilter } from "./spec";
import { perProcess } from "../perProcess";

// The smallest and largest value a field actually takes.
//
// A slider needs real endpoints. Guessing them, or asking the reader to type
// bounds before they can drag anything, defeats the point of a slider: the
// whole value is seeing the shape of what is there.
//
// Derived by sorting rather than by MIN and MAX. A metric view resolves
// aggregation through MEASURE() and does not accept an arbitrary aggregate
// over a dimension, so the portable way to ask for an extreme is to order by
// it and take one row.

export interface FieldRange {
	min: string | null;
	max: string | null;
	// The type decides whether the client renders a date picker or a numeric
	// slider, so it travels with the bounds.
	dataType: string | null;
	// True when the bounds describe a single aggregate rather than a spread.
	//
	// A measure has no range of its own: asked without a grouping it returns
	// one total, so min and max are the same number. Its real spread depends
	// on the grain the reading visual groups by, which this widget cannot know.
	// A slider spanning a degenerate range would look broken and mean nothing,
	// so the client is told to offer boxes instead.
	degenerate: boolean;
}

interface CacheEntry {
	value: FieldRange;
	computedAt: number;
	expiresAt: number;
}

// One of each for the process. See lib/perProcess.
const cache = perProcess(
	"query/range:cache",
	() => new Map<string, CacheEntry>(),
);
const inflight = perProcess(
	"query/range:inflight",
	() => new Map<string, Promise<FieldRange>>(),
);
// A range is a few short strings, so many can be held. Each policy class
// holds its own copy of every field it reads, and the ceiling leaves room for
// a wide estate read by many classes at once.
const maxCacheEntries = 5000;

// Expired entries first, then oldest inserted. Dropping only the expired ones
// leaves the map over its ceiling in the case that matters, which is a burst of
// distinct fields arriving faster than anything ages out.
function evictIfNeeded(): void {
	if (cache.size <= maxCacheEntries) return;
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (entry.expiresAt <= now) cache.delete(key);
	}
	let excess = cache.size - maxCacheEntries;
	if (excess <= 0) return;
	for (const key of cache.keys()) {
		cache.delete(key);
		if (--excess <= 0) break;
	}
}

// The checks every range read makes before anything is asked, and the key its
// answer is held under.
async function rangeQuestion(
	identity: Identity,
	sourceKey: string,
	field: string,
	filters: QueryFilter[],
	bounds: "both" | "max",
) {
	const source = getSource(sourceKey);
	if (!source) throw new QuerySpecError(`Unknown source "${sourceKey}"`);

	const definition =
		source.dimensions.find((f) => f.name === field) ??
		source.measures.find((f) => f.name === field);
	if (!definition) {
		throw new QuerySpecError(`Unknown field "${field}" on "${sourceKey}"`);
	}

	await assertCanReadSource(identity, source.sourceKey);

	const policy = await resolvePolicyClass(identity);
	if (policy.degraded) {
		throw new QueryAccessError(
			"Access could not be verified. Group membership is temporarily unavailable.",
		);
	}

	// Bounds are as identity-scoped as any other read: which values exist is
	// itself something Unity Catalog filters. So they are shared on the same
	// condition a result is, which is that the walk has read every filter and
	// the policy class therefore means what it says.
	const shareable = isShareable(source);

	const scope = source.hasRowFilter ? policy.id : "unfiltered";
	const key = `${scope}:${sourceKey}:${field}:${bounds}:${JSON.stringify(filters)}`;
	return { source, definition, policy, shareable, key };
}

// Not once the data behind it has changed, which is when its newest value is
// most likely to have moved. See lib/freshness.
function heldRange(
	sourceKey: string,
	shareable: boolean,
	key: string,
	now: number,
): FieldRange | null {
	const cached = shareable ? cache.get(key) : undefined;
	if (
		cached &&
		cached.expiresAt > now &&
		!changedSince(sourceKey, cached.computedAt)
	) {
		return cached.value;
	}
	return null;
}

// The range this process already holds, without asking anything, or null.
// For a page rendered on the server, which hands over what is already known
// and leaves the rest for the browser to ask.
export async function heldFieldRange(
	identity: Identity,
	sourceKey: string,
	field: string,
	bounds: "both" | "max" = "both",
): Promise<FieldRange | null> {
	const { shareable, key } = await rangeQuestion(
		identity,
		sourceKey,
		field,
		[],
		bounds,
	);
	return heldRange(sourceKey, shareable, key, Date.now());
}

export async function getFieldRange(
	identity: Identity,
	sourceKey: string,
	field: string,
	filters: QueryFilter[] = [],
	// "max" asks only for the upper bound. A freshness stamp is a MAX and
	// nothing else, and the lower bound would double the warehouse cost of
	// every page load for a figure nobody reads.
	bounds: "both" | "max" = "both",
): Promise<FieldRange> {
	const { source, definition, policy, shareable, key } = await rangeQuestion(
		identity,
		sourceKey,
		field,
		filters,
		bounds,
	);
	const now = Date.now();

	const cached = heldRange(sourceKey, shareable, key, now);
	if (cached) return cached;

	const existing = shareable ? inflight.get(key) : undefined;
	if (existing) return existing;

	// The same question in the shared tier, so a range one replica read is
	// reused on every other. Keyed and guarded exactly as answers are.
	const sharedKey = buildSharedKey(
		source,
		policy,
		"range",
		JSON.stringify([field, bounds, filters]),
	);

	const pending = (async (): Promise<FieldRange> => {
		try {
			if (shareable) {
				const held = await sharedValueGet<FieldRange>(sharedKey);
				if (held) {
					cache.set(key, {
						value: held.value,
						computedAt: held.computedAt,
						expiresAt: held.expiresAt,
					});
					evictIfNeeded();
					return held.value;
				}
			}

			const isMeasure = source.measures.some((f) => f.name === field);

			// One row from each end. Two small queries rather than one clever
			// one, because a metric view will not aggregate a dimension and a
			// UNION across the two would have to.
			const endpoint = async (direction: "asc" | "desc") => {
				const compiled = compileQuery(source, {
					sourceKey,
					dimensions: isMeasure ? [] : [field],
					measures: isMeasure ? [field] : [],
					// An empty value carries no information about the range and
					// would otherwise sort to one end of it.
					filters: [...filters, { field, op: "is_not_empty" }],
					sort: [{ field, direction }],
					limit: 1,
					offset: 0,
					transforms: [],
				});

				const rows = plainDates(
					identity.userToken
						? await queryAsUser(
								identity.userToken,
								compiled.sql,
								compiled.params,
								identity.email.toLowerCase(),
							)
						: !isDatabricksApp
							? await (
									await import("../data/localSession")
								).queryLocally(compiled.sql, compiled.params)
							: (() => {
									throw new QueryAccessError(
										"A user token is required to read a field range.",
									);
								})(),
				);

				const value = rows[0]?.[field];
				return value === null || value === undefined
					? null
					: String(value);
			};

			const [min, max] = await Promise.all([
				bounds === "max" ? Promise.resolve(null) : endpoint("asc"),
				endpoint("desc"),
			]);

			const value: FieldRange = {
				min,
				max,
				dataType: definition.dataType,
				degenerate: min !== null && min === max,
			};

			if (shareable) {
				const computedAt = Date.now();
				// Longer than a result cache entry, because the extremes of a
				// column move far more slowly than the figures inside it.
				// Except on a live source, where the newest value is the one
				// that moves.
				const expiresAt =
					computedAt +
					(source.isLive
						? liveTtlSeconds()
						: settings().resultTtlSeconds * 4) *
						1000;
				cache.set(key, { value, computedAt, expiresAt });
				evictIfNeeded();
				sharedValueSet(
					sharedKey,
					policy,
					source,
					value,
					computedAt,
					expiresAt,
				);
			}

			return value;
		} finally {
			inflight.delete(key);
		}
	})();

	if (shareable) inflight.set(key, pending);
	return pending;
}
