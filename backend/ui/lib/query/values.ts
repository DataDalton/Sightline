import { createHash } from "node:crypto";
import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { queryAsUser } from "../data/userSession";
import { isDatabricksApp } from "../runtime";
import { getSource } from "../semantic/registry";
import { settings } from "../settings";
import { QuerySpecError } from "./spec";
import { QueryAccessError } from "./execute";
import { isShareable } from "./cache";
import type { QueryFilter } from "./spec";
import { compileQuery } from "./builder";

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
}

export interface ValuesResult {
	values: string[];
	// True when the list was cut short, so the UI can say "keep typing".
	truncated: boolean;
	source: "cache" | "warehouse";
}

const maxLimit = 500;
const defaultLimit = 100;

interface CacheEntry {
	value: ValuesResult;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ValuesResult>>();
const maxCacheEntries = 500;

function cacheKey(
	request: ValuesRequest,
	policyId: string,
	scoped: boolean,
): string {
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				s: request.sourceKey,
				f: request.field,
				q: request.search ?? "",
				l: request.limit ?? defaultLimit,
				// Filters change the result set, so they belong in the key.
				fl: (request.filters ?? [])
					.map((x) =>
						[
							x.field,
							x.op,
							x.values?.join("") ?? x.value ?? "",
						].join(" "),
					)
					.sort(),
			}),
		)
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

	const policy = await resolvePolicyClass(identity);
	if (policy.degraded) {
		throw new QueryAccessError(
			"Access could not be verified. Group membership is temporarily unavailable.",
		);
	}

	const limit = Math.min(
		Math.max(request.limit ?? defaultLimit, 1),
		maxLimit,
	);

	// Which values exist is as filtered as the rows they came from, so this is
	// held to the same rule the result cache is: a filtered source may only be
	// shared within a policy class, and a policy class only means something once
	// the walk has read every filter. Until then the list is computed for the
	// caller and kept by nobody.
	const shareable = isShareable(source);

	const key = cacheKey(request, policy.id, source.hasRowFilter);
	const now = Date.now();
	const cached = shareable ? cache.get(key) : undefined;
	if (cached && cached.expiresAt > now) {
		return { ...cached.value, source: "cache" };
	}

	const existing = shareable ? inflight.get(key) : undefined;
	if (existing) return existing;

	const pending = (async (): Promise<ValuesResult> => {
		try {
			// Reuse the compiler so the filter and identifier handling is the
			// same as any other read: one place decides how a value is bound.
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
				// One extra row reveals whether the list was cut short.
				limit: limit + 1,
				offset: 0,
			});

			const rows = identity.userToken
				? await queryAsUser(
						identity.userToken,
						compiled.sql,
						compiled.params,
					)
				: !isDatabricksApp
					? await (
							await import("../data/localSession")
						).queryLocally(compiled.sql, compiled.params)
					: (() => {
							throw new QueryAccessError(
								"A user token is required to read column values.",
							);
						})();

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
				cache.set(key, {
					value: result,
					expiresAt: Date.now() + settings().resultTtlSeconds * 1000,
				});
				evictIfNeeded();
			}
			return result;
		} finally {
			inflight.delete(key);
		}
	})();

	if (shareable) inflight.set(key, pending);
	return pending;
}
