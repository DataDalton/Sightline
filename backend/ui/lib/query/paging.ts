import { maxLimit, type QuerySpec } from "./spec";
import type { QueryTransform } from "./transform";

// Paging for a query whose derived figures depend on every row.
//
// Share of total, running total, rank and indexing to the first row are each
// worked out across the whole answer. Taken over one page they are wrong in a
// way that looks right, since rank starts again at 1 on the second page and
// shares add up to a hundred within each page. So a spec that carries one of
// them and asks for a window of the answer is run for the whole answer instead,
// the figures are worked out over that, and the window is cut out afterwards.
//
// The whole answer is what gets cached, under a key built from the widened
// spec, so every page of the same question is served from one warehouse query.
// A ratio reads only its own row and gives the same figure either way, so a
// spec carrying nothing else keeps paging in SQL.

// The rows a caller asked for, cut from a larger answer.
export interface RowWindow {
	offset: number;
	limit: number;
}

export interface PagedSpec {
	// What is run and cached.
	spec: QuerySpec;
	// What is cut from that answer before it is returned, or null when the
	// spec is run as asked.
	window: RowWindow | null;
}

// Whether any transform reads rows other than its own.
export function needsWholeResult(
	transforms: QueryTransform[] | undefined,
): boolean {
	return (transforms ?? []).some((t) => t.kind !== "ratio");
}

// The row count the whole answer is fetched to. The largest a single request may
// ask for, or the next multiple of it when the window reaches past that, so a
// window deep in a large answer still gets its rows and every window in the same
// span shares one cached answer.
export function wholeResultLimit(window: RowWindow): number {
	const end = window.offset + window.limit;
	return Math.max(1, Math.ceil(end / maxLimit)) * maxLimit;
}

// The spec to run for a request, and the window to cut from its answer.
//
// A distribution is summarised by the warehouse and never paged, so it is run as
// asked. So is a spec already asking for the whole answer from its first row.
export function pagedSpec(spec: QuerySpec): PagedSpec {
	if (spec.distribution || !needsWholeResult(spec.transforms)) {
		return { spec, window: null };
	}
	const window = { offset: spec.offset, limit: spec.limit };
	const limit = wholeResultLimit(window);
	if (spec.offset === 0 && spec.limit >= limit) {
		return { spec, window: null };
	}
	return { spec: { ...spec, offset: 0, limit }, window };
}

// The asked-for rows of a whole answer. The same array when there is no window.
export function sliceWindow<T>(rows: T[], window: RowWindow | null): T[] {
	if (!window) return rows;
	return rows.slice(window.offset, window.offset + window.limit);
}
