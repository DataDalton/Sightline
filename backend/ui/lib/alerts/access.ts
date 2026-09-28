// Checking an alert on a row-filtered dataset while its owner is away.
//
// A row filter is a function Unity Catalog calls for each row, with some of
// that row's columns as arguments, and it answers yes or no for whoever is
// running the query. So what a person may see is decided by the values of
// those columns and nothing else in the row. Recording which combinations of
// those values they can see, asked under their own token so their own filter
// decides it, gives a condition that reproduces their access: a check run as
// the app and restricted to exactly those combinations returns the rows the
// person would get.
//
// It holds as long as the recording is current, which is why it is refreshed
// whenever the owner is using the app and stops being used after a day. A
// value that appears later is left out until the next recording, which errs
// towards showing less.
//
// Everything here is pure. The walk that reads filters, the recording and the
// checks live elsewhere.

import type { ViewCalculations } from "../semantic/metricViewCalculations";

// Column names out of the argument list Unity Catalog reports for a filter,
// such as `"config", region, ORG_ID`. Quoted arguments are string literals the
// filter is called with rather than columns of the row, and a bare number or
// NULL is a literal too, so only plain identifiers are kept.
export function filterColumns(targetColumns: string): string[] {
	const out: string[] = [];
	let token = "";
	let quote: string | null = null;
	let quoted = false;

	const flush = () => {
		const t = token.trim();
		if (t && !quoted && !/^null$/i.test(t) && !/^[-+]?\d/.test(t)) {
			out.push(t.replace(/`/g, ""));
		}
		token = "";
		quoted = false;
	};

	for (const ch of targetColumns) {
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			quoted = true;
			continue;
		}
		if (ch === ",") {
			flush();
			continue;
		}
		token += ch;
	}
	flush();
	return out;
}

// One row filter as the walk found it: the table it sits on and the columns
// it reads.
export interface FoundFilter {
	table: string;
	columns: string[];
}

function bare(name: string): string {
	return name.replace(/`/g, "").trim().toLowerCase();
}

interface DimensionLike {
	name: string;
	sqlExpr: string | null;
}

// The dataset fields that hold the columns every filter reads, or null when
// any of them has no field that is exactly that column.
//
// Exactly the column, because the recorded values are compared with the field
// as the dataset exposes it: a field that trims, renames or combines the
// column would compare something other than what the filter decides on.
//
// For a metric view only filters on the table the view reads from are
// followed. A filter on a joined table hides the joined row rather than the
// row of the view, which leaves the view's row in place with nothing joined to
// it, and a restriction on the joined field would drop that row instead. That
// case keeps to checks while the owner is signed in.
export function accessFields(
	source: {
		kind: "metric_view" | "table";
		catalog: string;
		schema: string;
		object: string;
		dimensions: DimensionLike[];
	},
	filters: FoundFilter[],
	view: ViewCalculations | null,
): string[] | null {
	if (filters.length === 0) return null;

	const self = bare(`${source.catalog}.${source.schema}.${source.object}`);
	const base =
		source.kind === "metric_view" ? bare(view?.source ?? "") : self;
	if (!base) return null;

	const fields = new Set<string>();
	for (const filter of filters) {
		const table = bare(filter.table);
		// A filter on the view object itself decides on the view's own
		// fields, which are its dimensions by name.
		const onView = source.kind === "metric_view" && table === self;
		if (table !== base && !onView) return null;

		for (const column of filter.columns) {
			const wanted = bare(column);
			const match = source.dimensions.find((d) => {
				if (onView) return bare(d.name) === wanted;
				const expr =
					source.kind === "metric_view"
						? view?.fields.get(d.name)?.expr
						: d.sqlExpr;
				if (!expr) return false;
				const e = bare(expr);
				return e === wanted || e === `source.${wanted}`;
			});
			if (!match) return null;
			fields.add(match.name);
		}
	}
	return fields.size > 0 ? [...fields].sort() : null;
}

// The most combinations recorded for one person on one dataset. Past this the
// restriction is too long to send with every check, and the alert keeps to
// checks while its owner is signed in.
export const maxAccessTuples = 500;

// A recorded value, as text so it compares the same way whatever the column's
// type. Null is kept as null, because a row with nothing in the column is
// allowed or refused like any other.
export type AccessValue = string | null;

export function toAccessValue(value: unknown): AccessValue {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString();
	return String(value);
}
