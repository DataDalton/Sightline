// Asking the same question about an earlier period.
//
// Almost every question a report exists to answer is a comparison. Nothing here
// could express one: a spec carries dimensions, measures and filters, and every
// name in it resolves to a field the semantic registry already defines, so a
// figure that does not exist upstream cannot be asked for. Modelling a "vs last
// year" measure for every measure would double the semantic layer and still
// only cover the comparisons somebody thought of in advance.
//
// So the comparison is a second question rather than a second column. The same
// spec with its date window moved back is an ordinary spec: the query layer
// already understands it, the batcher already sends it alongside everything
// else the page asks for, and the cache already keys it. Nothing on the server
// changes at all.
//
// The window is moved rather than recomputed, so whatever the reader has
// filtered to is what gets compared. A reader who narrows to one region is
// comparing that region to itself a year ago, which is the only comparison that
// means anything.

export interface DateClause {
	field: string;
	op: string;
	value?: string;
	values?: string[];
}

export type ComparePeriod = "previous" | "month" | "quarter" | "year";

export const comparePeriodLabels: Record<ComparePeriod, string> = {
	previous: "The period before",
	month: "The same window a month earlier",
	quarter: "The same window a quarter earlier",
	year: "The same window a year earlier",
};

// Days in a month, so a shift landing on the 31st of a 30 day month lands on
// the 30th rather than rolling into the next one.
function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function parseIso(value: string): { y: number; m: number; d: number } | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
	if (!match) return null;

	const y = Number(match[1]);
	const m = Number(match[2]) - 1;
	const d = Number(match[3]);
	if (m < 0 || m > 11 || d < 1 || d > 31) return null;

	// A date the calendar does not have, such as the 31st of April, is a
	// typo rather than a date to guess at.
	if (d > daysInMonth(y, m)) return null;
	return { y, m, d };
}

function toIso(y: number, m: number, d: number): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${y}-${pad(m + 1)}-${pad(d)}`;
}

// Moves a date back by whole months, keeping the day of the month where the
// target month has one.
//
// The 31st of March a month earlier is the 28th or 29th of February, not the
// 3rd of March. Rolling forward is what native date arithmetic does and it puts
// the comparison window in the wrong month entirely.
function subtractMonths(iso: string, months: number): string | null {
	const parsed = parseIso(iso);
	if (!parsed) return null;

	const total = parsed.y * 12 + parsed.m - months;
	const y = Math.floor(total / 12);
	const m = ((total % 12) + 12) % 12;
	return toIso(y, m, Math.min(parsed.d, daysInMonth(y, m)));
}

function subtractDays(iso: string, days: number): string | null {
	const parsed = parseIso(iso);
	if (!parsed) return null;

	const at = Date.UTC(parsed.y, parsed.m, parsed.d) - days * 86400000;
	const date = new Date(at);
	return toIso(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function daysBetween(from: string, to: string): number | null {
	const a = parseIso(from);
	const b = parseIso(to);
	if (!a || !b) return null;
	return Math.round(
		(Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / 86400000,
	);
}

// The filters for the same question asked about an earlier window.
//
// Returns null when there is nothing to shift, and null is the right answer to
// act on rather than a fallback to paper over: with no date window the
// comparison would run the identical query, report no change at all, and that
// zero would be read as a fact about the business rather than about the filter
// state.
export function shiftDateFilters(
	filters: DateClause[],
	dateField: string,
	period: ComparePeriod,
): DateClause[] | null {
	const from = filters.find(
		(f) => f.field === dateField && (f.op === "gte" || f.op === "gt"),
	);
	const to = filters.find(
		(f) => f.field === dateField && (f.op === "lte" || f.op === "lt"),
	);

	// One open end is still a window with a position, so a fixed shift can move
	// it. "The period before" cannot: an open window has no length to step back
	// by, and inventing one would compare against a span nobody chose.
	if (!from?.value && !to?.value) return null;

	let shift: (value: string) => string | null;

	if (period === "previous") {
		if (!from?.value || !to?.value) return null;
		const span = daysBetween(from.value, to.value);
		if (span === null || span < 0) return null;
		// The window immediately before this one, with no day counted twice
		// and none skipped between them.
		const back = span + 1;
		shift = (value) => subtractDays(value, back);
	} else {
		const months = period === "year" ? 12 : period === "quarter" ? 3 : 1;
		shift = (value) => subtractMonths(value, months);
	}

	const moved = new Map<DateClause, string>();
	for (const clause of [from, to]) {
		if (!clause?.value) continue;
		const next = shift(clause.value);
		// A value that will not parse is left where it is rather than dropped,
		// which would silently widen the comparison window to everything.
		if (next === null) return null;
		moved.set(clause, next);
	}
	if (moved.size === 0) return null;

	return filters.map((clause) => {
		const value = moved.get(clause);
		return value === undefined ? clause : { ...clause, value };
	});
}

// The change between two figures, as a fraction.
//
// Null rather than zero when the comparison cannot be made, and the cases are
// not the same: growth from nothing is not a percentage, and a missing figure
// is not a flat one. Both get reported as "no comparison" rather than as a
// number somebody will read off a tile.
export function relativeChange(
	current: number | null,
	previous: number | null,
): number | null {
	if (current === null || previous === null) return null;
	if (previous === 0) return null;
	return (current - previous) / Math.abs(previous);
}
