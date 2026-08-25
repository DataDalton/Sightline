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

		return { field, op: operator, value: asString(o.value, `filter ${i} value`) };
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
			String(o.direction ?? "asc").toLowerCase() === "desc" ? "desc" : "asc";
		return { field: asString(o.field, `sort ${i} field`), direction };
	});
}

function parseNameList(raw: unknown, label: string, max: number): string[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new QuerySpecError(`${label} must be an array`);
	if (raw.length > max) {
		throw new QuerySpecError(`at most ${max} ${label} are allowed`);
	}
	return raw.map((v, i) => asString(v, `${label} ${i}`));
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

	return {
		sourceKey: asString(o.sourceKey, "sourceKey"),
		dimensions: parseNameList(o.dimensions, "dimensions", maxDimensions),
		measures: parseNameList(o.measures, "measures", maxMeasures),
		filters: parseFilters(o.filters),
		sort: parseSort(o.sort),
		limit,
		offset,
	};
}

// Canonical string for cache keying. Field order matters to the SQL, so it is
// preserved rather than sorted; filters are sorted so that two logically
// identical requests share a cache entry.
export function canonicalizeSpec(spec: QuerySpec): string {
	const filters = spec.filters
		.map((f) =>
			[f.field, f.op, f.values ? f.values.join("") : (f.value ?? "")].join(
				"\u0000",
			),
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
	});
}
