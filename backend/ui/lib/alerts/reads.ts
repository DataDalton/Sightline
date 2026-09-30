import type { PolicyClass } from "../auth/policy";
import type { Row } from "../data/types";
import { plainDates } from "../format";
import { compileQuery, type RowRestriction } from "../query/builder";
import {
	buildCacheKey,
	cacheGetMany,
	cacheSet,
	isShareable,
} from "../query/cache";
import type { QuerySpec } from "../query/spec";
import type { SemanticSource } from "../semantic/types";
import {
	groupByQuery,
	QueryMemo,
	queryScope,
	sharedQueryKey,
	type RunIdentity,
	type SharedRunQuery,
} from "./shared";

// The warehouse reads of one batch of alert checks or scheduled pages. The
// sharing rules are in lib/alerts/shared.
//
// A read that shows everybody the same rows also goes through the result
// cache the pages use, under the same key a page would use for the same
// question, so a check can take an answer a page already fetched and a page
// can take one a check fetched.

// Stands in for a policy class when keying an answer from a dataset without
// row filters. Neither the key nor the stored scope of such an answer reads
// the class.
const unfilteredPolicy: PolicyClass = {
	id: "unfiltered",
	grants: [],
	degraded: false,
	stale: false,
	resolvedAt: 0,
};

interface Planned {
	source: SemanticSource;
	spec: QuerySpec;
}

export class BatchReads {
	private readonly memo = new QueryMemo();
	// Cache keys already looked up for this batch and found missing, so the
	// read that follows goes straight to the warehouse.
	private readonly missed = new Set<string>();

	constructor(
		private readonly identity: RunIdentity,
		private readonly run: SharedRunQuery,
	) {}

	// Whether an answer may come from, and go to, the shared result cache.
	// Only for a dataset without row filters read without a restriction, and
	// only for a question with no derived figures, since the pages store
	// those worked out and a read here returns the warehouse rows alone.
	private cacheable(
		source: SemanticSource,
		spec: QuerySpec,
		restriction: RowRestriction | undefined,
	): boolean {
		return (
			restriction === undefined &&
			!source.hasRowFilter &&
			isShareable(source) &&
			spec.transforms.length === 0
		);
	}

	private keyFor(
		source: SemanticSource,
		spec: QuerySpec,
		restriction: RowRestriction | undefined,
	) {
		const compiled = compileQuery(source, spec, { restriction });
		const scope = queryScope(this.identity, restriction);
		return {
			compiled,
			key: sharedQueryKey(scope, compiled.sql, compiled.params),
		};
	}

	// Looks up, in one round trip, the cached answers to questions the batch
	// is about to ask. Anything that cannot be compiled is left for the check
	// itself to report.
	async prefetch(planned: Planned[]): Promise<void> {
		const usable: {
			cacheKey: string;
			key: string;
		}[] = [];
		for (const { source, spec } of planned) {
			if (!this.cacheable(source, spec, undefined)) continue;
			try {
				const { key } = this.keyFor(source, spec, undefined);
				if (this.memo.has(key)) continue;
				usable.push({
					cacheKey: buildCacheKey(source, spec, unfilteredPolicy),
					key,
				});
			} catch {
				continue;
			}
		}
		const groups = groupByQuery(usable, (u) => u.cacheKey);
		if (groups.size === 0) return;
		const found = await cacheGetMany([...groups.keys()]);
		for (const [cacheKey, members] of groups) {
			const hit = found.get(cacheKey);
			if (hit?.entry && !hit.stale) {
				for (const member of members) {
					this.memo.seed(member.key, hit.entry.rows);
				}
			} else {
				this.missed.add(cacheKey);
			}
		}
	}

	// The rows for one question, read once per batch whoever asks.
	read(
		source: SemanticSource,
		spec: QuerySpec,
		restriction?: RowRestriction,
	): Promise<Row[]> {
		const { compiled, key } = this.keyFor(source, spec, restriction);
		return this.memo.read(key, async () => {
			if (!this.cacheable(source, spec, restriction)) {
				return this.run(compiled.sql, compiled.params);
			}
			const cacheKey = buildCacheKey(source, spec, unfilteredPolicy);
			if (!this.missed.has(cacheKey)) {
				const hit = (await cacheGetMany([cacheKey])).get(cacheKey);
				if (hit?.entry && !hit.stale) return hit.entry.rows;
			}
			// Dates as text, as the pages store them, so an answer written
			// here reads the same to a page as one the page wrote itself.
			const rows = plainDates(
				await this.run(compiled.sql, compiled.params),
			);
			await cacheSet(
				cacheKey,
				unfilteredPolicy,
				source,
				rows,
				compiled.columns,
			);
			return rows;
		});
	}

	// How many reads went to the warehouse or the cache rather than being
	// shared with another check in the batch.
	get reads(): number {
		return this.memo.reads;
	}
}
