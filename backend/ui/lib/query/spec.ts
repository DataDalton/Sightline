import { transformKinds, type QueryTransform } from "./transform";
import {
	isValidOperator,
	operatorLabels,
	valuelessOperators,
	type SearchOperator,
} from "../search/types";

// What a client asks for. Every element is a name resolved against the
// semantic registry, never a SQL fragment. A request that names a field the
// source does not define is rejected rather than passed through.

export interface QueryFilter {
	field: string;
	op: SearchOperator;
	// Absent for is_empty / is_not_empty.
	value?: string;
	// Present for operators that take a set, such as an "in" style filter
	// expressed by the UI as multiple accepted values.
	values?: string[];
}

export interface QuerySort {
	field: string;
	direction: "asc" | "desc";
}

export interface QuerySpec {
	sourceKey: string;
	// Grouping fields. Empty means no aggregation, which is how detail and
	// lookup tables read raw rows.
	dimensions: string[];
	measures: string[];
	filters: QueryFilter[];
	sort: QuerySort[];
	limit: number;
	offset: number;
	// Figures worked out from the answer rather than asked of the warehouse.
	// Applied after the rows come back and before they are cached, so a hit
	// serves them too. Part of the cache key, since two specs differing only
	// in these are two different answers.
	transforms: QueryTransform[];
}

// Upper bounds on the shape of a single request.
//
// These are a backstop against a malformed or runaway request, not a cost
// control and not a design rule:
//
//   Cost is bounded by maxLimit and by the warehouse timeout. Adding a column
//   to a listing does not multiply the work the way another million rows does,
//   so a low field count buys very little and costs real functionality: a
//   roster or an export is legitimately dozens of columns wide, and that is
//   exactly the kind of page this replaces.
//
//   What a given visual should use is the catalogue's business. A bar chart
//   with nine dimensions is a bad chart, and the catalogue says so per type,
//   where the reason can be explained to the author.
//
// So these sit far above anything the catalogue permits, and only refuse a
// request that is obviously not a real one. A test pins the relationship, since
// the dimension bound once sat below the table's own limit and a fourteen
// column roster was authored happily in the editor and then refused at query
// time, with nothing in the editor to suggest why.
export const maxDimensions = 100;
export const maxMeasures = 100;
export const maxFilters = 40;
// Each one is a pass over rows the warehouse has already returned, so the cost
// is small and bounded. This is a backstop against a malformed request rather
// than a design rule.
export const maxTransforms = 12;
export const maxLimit = 50000;
export const defaultLimit = 1000;

export class QuerySpecError extends Error {}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new QuerySpecError(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function parseFilters(raw: unknown): QueryFilter[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new QuerySpecError("filters must be an array");
	}
	if (raw.length > maxFilters) {
		throw new QuerySpecError(`at most ${maxFilters} filters are allowed`);
	}

	return raw.map((item, i) => {
		if (!item || typeof item !== "object") {
			throw new QuerySpecError(`filter ${i} must be an object`);
		}
		const o = item as Record<string, unknown>;
		const field = asString(o.field, `filter ${i} field`);
		const op = asString(o.op, `filter ${i} op`);
		if (!isValidOperator(op)) {
			throw new QuerySpecError(
				`filter ${i} operator must be one of ${Object.keys(operatorLabels).join(", ")}`,
			);
		}

		const operator = op as SearchOperator;
		if (valuelessOperators.has(operator)) {
			return { field, op: operator };
		}

		if (Array.isArray(o.values)) {
			const values = o.values.map((v, j) =>
				asString(v, `filter ${i} value ${j}`),
			);
			if (values.length === 0) {
				throw new QuerySpecError(`filter ${i} has no values`);
			}
			return { field, op: operator, values };
		}

		return {
			field,
			op: operator,
			value: asString(o.value, `filter ${i} value`),
		};
	});
}

function parseSort(raw: unknown): QuerySort[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new QuerySpecError("sort must be an array");

	return raw.map((item, i) => {
		if (!item || typeof item !== "object") {
			throw new QuerySpecError(`sort ${i} must be an object`);
		}
		const o = item as Record<string, unknown>;
		const direction =
			String(o.direction ?? "asc").toLowerCase() === "desc"
				? "desc"
				: "asc";
		return { field: asString(o.field, `sort ${i} field`), direction };
	});
}

function parseNameList(raw: unknown, label: string, max: number): string[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw))
		throw new QuerySpecError(`${label} must be an array`);
	if (raw.length > max) {
		throw new QuerySpecError(`at most ${max} ${label} are allowed`);
	}
	return raw.map((v, i) => asString(v, `${label} ${i}`));
}

// Derived figures, checked against what the query will actually return.
//
// Two rules, and both matter. Every column a transform reads has to be one the
// answer carries, which is the request's own fields plus anything an earlier
// transform produced, so the chain is validated in the order it runs. And a new
// name may not shadow a field the source defines, or a visual asking for that
// field would silently get the derived column instead.
function parseTransforms(
	raw: unknown,
	dimensions: string[],
	measures: string[],
): QueryTransform[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new QuerySpecError("transforms must be an array");
	}
	if (raw.length > maxTransforms) {
		throw new QuerySpecError(
			`at most ${maxTransforms} transforms are allowed`,
		);
	}

	const known = new Set([...dimensions, ...measures]);
	const original = new Set(known);
	const out: QueryTransform[] = [];

	raw.forEach((item, i) => {
		if (!item || typeof item !== "object") {
			throw new QuerySpecError(`transform ${i} must be an object`);
		}
		const o = item as Record<string, unknown>;
		const kind = asString(o.kind, `transform ${i} kind`);
		if (!transformKinds.has(kind)) {
			throw new QuerySpecError(
				`transform ${i} kind must be one of ${[...transformKinds].join(", ")}`,
			);
		}

		const measure = asString(o.measure, `transform ${i} measure`);
		if (!known.has(measure)) {
			throw new QuerySpecError(
				`transform ${i} reads "${measure}", which this query does not return`,
			);
		}

		const as = asString(o.as, `transform ${i} name`);
		if (original.has(as)) {
			throw new QuerySpecError(
				`transform ${i} would name a column "${as}", which the source already defines`,
			);
		}

		if (kind === "ratio") {
			const denominator = asString(
				o.denominator,
				`transform ${i} denominator`,
			);
			if (!known.has(denominator)) {
				throw new QuerySpecError(
					`transform ${i} divides by "${denominator}", which this query does not return`,
				);
			}
			const scaleRaw = Number(o.scale ?? 1);
			const scale = Number.isFinite(scaleRaw) ? scaleRaw : 1;
			out.push({ kind, measure, denominator, as, scale });
		} else if (kind === "rank") {
			const direction =
				String(o.direction ?? "desc").toLowerCase() === "asc"
					? "asc"
					: "desc";
			out.push({ kind, measure, as, direction });
		} else {
			out.push({
				kind: kind as "percentOfTotal" | "runningTotal" | "indexTo",
				measure,
				as,
			});
		}

		known.add(as);
	});

	return out;
}

// Validates the shape of a client request. Field names are checked against the
// registry later, when the source is known.
export function parseQuerySpec(raw: unknown): QuerySpec {
	if (!raw || typeof raw !== "object") {
		throw new QuerySpecError("request body must be an object");
	}
	const o = raw as Record<string, unknown>;

	const limitRaw = Number(o.limit ?? defaultLimit);
	const limit = Number.isFinite(limitRaw)
		? Math.min(Math.max(Math.trunc(limitRaw), 1), maxLimit)
		: defaultLimit;

	const offsetRaw = Number(o.offset ?? 0);
	const offset = Number.isFinite(offsetRaw)
		? Math.max(Math.trunc(offsetRaw), 0)
		: 0;

	const dimensions = parseNameList(o.dimensions, "dimensions", maxDimensions);
	const measures = parseNameList(o.measures, "measures", maxMeasures);

	return {
		sourceKey: asString(o.sourceKey, "sourceKey"),
		dimensions,
		measures,
		filters: parseFilters(o.filters),
		sort: parseSort(o.sort),
		limit,
		offset,
		transforms: parseTransforms(o.transforms, dimensions, measures),
	};
}

// Canonical string for cache keying. Field order matters to the SQL, so it is
// preserved rather than sorted; filters are sorted so that two logically
// identical requests share a cache entry.
export function canonicalizeSpec(spec: QuerySpec): string {
	const filters = spec.filters
		.map((f) =>
			[
				f.field,
				f.op,
				f.values ? f.values.join("") : (f.value ?? ""),
			].join("\u0000"),
		)
		.sort();

	return JSON.stringify({
		s: spec.sourceKey,
		d: spec.dimensions,
		m: spec.measures,
		f: filters,
		o: spec.sort.map((s) => `${s.field}:${s.direction}`),
		l: spec.limit,
		x: spec.offset,
		// Two specs differing only in what is derived from the answer are two
		// different answers, so the cache has to tell them apart.
		t: spec.transforms.map((t) =>
			[
				t.kind,
				t.measure,
				t.as,
				"denominator" in t ? t.denominator : "",
				"direction" in t ? t.direction : "",
				"scale" in t ? String(t.scale ?? "") : "",
			].join(" "),
		),
	});
}
