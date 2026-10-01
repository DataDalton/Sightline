import { createHash } from "node:crypto";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { queryAsUser } from "../data/userSession";
import { plainDates } from "../format";
import { isDatabricksApp } from "../runtime";
import { getSource } from "../semantic/registry";
import { settings } from "../settings";
import { QuerySpecError } from "./spec";
import { assertCanReadSource, QueryAccessError } from "./execute";
import {
	buildSharedKey,
	isShareable,
	sharedValueGet,
	sharedValueSet,
} from "./cache";
import type { QueryFilter } from "./spec";
import { compileQuery } from "./builder";
import { changedSince } from "../freshness/marks";

// Distinct values for one dimension, feeding the column filter dropdown.
//
// The list respects the filters already applied to the grid, so choosing
// "Division = Medical" narrows what the Business Unit filter offers. That
// cascading behaviour is what makes a filter usable on a column with thousands
// of distinct values.
//
// Results are cached by policy class like any other read: which values exist is
// itself information Unity Catalog filters, so two users with different grants
// must not share a list.

export interface ValuesRequest {
	sourceKey: string;
	field: string;
	// Free text typed into the dropdown, matched as a contains.
	search?: string;
	// Filters currently applied to the grid, so the list cascades.
	filters?: QueryFilter[];
	limit?: number;
	// Where to start, so a list longer than one page can be read by scrolling
	// rather than only by typing. The order is the field ascending, which is
	// stable, so page two is the rows after page one rather than a fresh
	// arbitrary slice.
	offset?: number;
}

export interface ValuesResult {
	values: string[];
	// True when more rows exist past the ones returned, so the caller knows
	// there is another page to ask for.
	truncated: boolean;
	source: "cache" | "warehouse";
}

const maxLimit = 500;
const defaultLimit = 100;
// How far a reader may scroll before the list asks them to type instead. Far
// enough that no ordinary column runs out, short enough that a runaway scroll
// stops.
const maxOffset = 10000;

interface CacheEntry {
	value: ValuesResult;
	computedAt: number;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ValuesResult>>();
// Each policy class holds its own list for every field, search and page it
// reads, and the ceiling leaves room for many classes using filters at once.
// A list is at most one page of short strings.
const maxCacheEntries = 2000;

// Everything that changes which values come back, as one string.
function requestIdentity(request: ValuesRequest): string {
	return JSON.stringify({
		s: request.sourceKey,
		f: request.field,
		q: request.search ?? "",
		l: request.limit ?? defaultLimit,
		o: request.offset ?? 0,
		// Filters change the result set, so they belong in the key.
		// Each condition as JSON, so a list of values cannot join to
		// the same text as a different list, and a negated condition
		// never shares a key with the plain one.
		fl: (request.filters ?? [])
			.map((x) =>
				JSON.stringify([
					x.field,
					x.op,
					x.values ?? x.value ?? "",
					x.negate === true,
				]),
			)
			.sort(),
	});
}

function cacheKey(
	request: ValuesRequest,
	policyId: string,
	scoped: boolean,
): string {
	const digest = createHash("sha256")
		.update(requestIdentity(request))
		.digest("hex")
		.slice(0, 32);
	// Policy scope is a literal prefix rather than hashed input, so no digest
	// collision can cross a policy boundary.
	return `${scoped ? policyId : "unfiltered"}:${digest}`;
}

function evictIfNeeded(): void {
	if (cache.size <= maxCacheEntries) return;
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (entry.expiresAt <= now) cache.delete(key);
	}
	if (cache.size > maxCacheEntries) {
		let excess = cache.size - maxCacheEntries;
		for (const key of cache.keys()) {
			cache.delete(key);
			if (--excess <= 0) break;
		}
	}
}

export async function getDistinctValues(
	identity: Identity,
	request: ValuesRequest,
): Promise<ValuesResult> {
	const source = getSource(request.sourceKey);
	if (!source) {
		throw new QuerySpecError(`Unknown source "${request.sourceKey}"`);
	}

	// Only dimensions have distinct values worth listing. A measure is an
	// aggregate, so its "values" would be an artefact of the grouping.
	const field = source.dimensions.find((f) => f.name === request.field);
	if (!field) {
		throw new QuerySpecError(
			`"${request.field}" is not a dimension on "${request.sourceKey}"`,
		);
	}

	await assertCanReadSource(identity, source.sourceKey);

	const policy = await resolvePolicyClass(identity);
	if (policy.degraded) {
		throw new QueryAccessError(
			"Access could not be verified. Group membership is temporarily unavailable.",
		);
	}

	// Whole, because it is written into the statement and a fractional limit
	// is refused by the warehouse.
	const limit = Math.min(
		Math.max(Math.trunc(request.limit ?? defaultLimit) || defaultLimit, 1),
		maxLimit,
	);
	// Bounded, because an offset is a number from a client and a scroll that
	// runs away should stop rather than walk the whole column.
	const offset = Math.min(
		Math.max(Math.trunc(request.offset ?? 0), 0),
		maxOffset,
	);

	// Which values exist is as filtered as the rows they came from, so this is
	// held to the same rule the result cache is: a filtered source may only be
	// shared within a policy class, and a policy class only means something once
	// the walk has read every filter. Until then the list is computed for the
	// caller and kept by nobody.
	const shareable = isShareable(source);

	const key = cacheKey(request, policy.id, source.hasRowFilter);
	const now = Date.now();
	// Not once the data behind it has changed, the same rule ranges follow.
	// See lib/freshness.
	const cached = shareable ? cache.get(key) : undefined;
	if (
		cached &&
		cached.expiresAt > now &&
		!changedSince(request.sourceKey, cached.computedAt)
	) {
		return { ...cached.value, source: "cache" };
	}

	const existing = shareable ? inflight.get(key) : undefined;
	if (existing) return existing;

	// The same question in the shared tier, so a list one replica read is
	// reused on every other. Keyed and guarded exactly as answers are.
	const sharedKey = buildSharedKey(
		source,
		policy,
		"values",
		requestIdentity(request),
	);

	// Finished in a callback rather than inside the body. The body can throw
	// before its first await, on a filter naming an unknown field, and a
	// finally there would run before the promise is registered below, leaving
	// a rejected promise in the map that every later caller with the same key
	// would be handed.
	const pending = (async (): Promise<ValuesResult> => {
		if (shareable) {
			const held = await sharedValueGet<ValuesResult>(sharedKey);
			if (held) {
				cache.set(key, {
					value: held.value,
					computedAt: held.computedAt,
					expiresAt: held.expiresAt,
				});
				evictIfNeeded();
				return { ...held.value, source: "cache" };
			}
		}

		// Reuse the compiler so the filter and identifier handling is the
		// same as any other read, with one place deciding how a value is bound.
		const filters = [...(request.filters ?? [])];
		if (request.search && request.search.trim() !== "") {
			filters.push({
				field: request.field,
				op: "contains",
				value: request.search.trim(),
			});
		}

		const compiled = compileQuery(source, {
			sourceKey: request.sourceKey,
			dimensions: [request.field],
			measures: [],
			filters,
			sort: [{ field: request.field, direction: "asc" }],
			// One extra row reveals whether another page exists.
			limit: limit + 1,
			offset,
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
								"A user token is required to read column values.",
							);
						})(),
		);

		const truncated = rows.length > limit;
		const values = (truncated ? rows.slice(0, limit) : rows)
			.map((row) => row[request.field])
			.filter((v) => v !== null && v !== undefined && v !== "")
			.map((v) => String(v));

		const result: ValuesResult = {
			values,
			truncated,
			source: "warehouse",
		};

		if (shareable) {
			// Dated from here rather than from the start of the request, so
			// a slow warehouse does not shorten the life of its own answer.
			const computedAt = Date.now();
			// Four times the result TTL, matching ranges. The set of values
			// a column takes changes when the data lands, not while somebody
			// is using a filter, so holding these as briefly as a query
			// answer refetched them constantly for no change.
			const expiresAt =
				computedAt + settings().resultTtlSeconds * 4 * 1000;
			cache.set(key, { value: result, computedAt, expiresAt });
			evictIfNeeded();
			sharedValueSet(
				sharedKey,
				policy,
				source,
				result,
				computedAt,
				expiresAt,
			);
		}
		return result;
	})().finally(() => {
		if (inflight.get(key) === pending) inflight.delete(key);
	});

	if (shareable) inflight.set(key, pending);
	return pending;
}
