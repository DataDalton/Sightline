import { visualByType } from "./catalog";

// Saying in words what a chart shows.
//
// Charts are drawn onto a canvas, which is one opaque element with no text in
// it at all. Every other part of this app is careful about this, to the point
// that a conditional rule pairs its colour with a marker so the table still
// reads in greyscale, which made the charts the conspicuous exception: a
// screen reader met a page of visuals and found nothing on it.
//
// Two things, because they answer different questions. The sentence is the
// glance: what kind of chart, of what, across what, and which way it went. The
// table underneath is the detail, for a reader who wants the numbers rather
// than the shape, and it is the same rows the chart drew rather than a second
// query that could disagree with it.

// A list said the way somebody would say it, so a two measure chart does not
// read as "Net Sales, Units".
function joinWords(items: string[]): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0];
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function numberOf(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : null;
}

// Which way the first measure went between the first and last row.
//
// Only for a chart along an axis where the order means something. On a ranked
// bar chart the first and last rows are the biggest and smallest, and calling
// that a rise would be describing the sort rather than the data.
function direction(
	rows: Record<string, unknown>[],
	measure: string,
): string | null {
	if (rows.length < 2) return null;

	const first = numberOf(rows[0][measure]);
	const last = numberOf(rows[rows.length - 1][measure]);
	if (first === null || last === null || first === 0) return null;

	const change = (last - first) / Math.abs(first);
	// Under a percent either way is noise rather than a movement, and calling
	// it one would be the summary inventing a story.
	if (Math.abs(change) < 0.01) return "roughly level across the range";

	const percent = Math.abs(change * 100);
	const size = percent >= 1000 ? "sharply" : "";
	const word = change > 0 ? "rising" : "falling";
	return `${word} ${size} ${percent.toFixed(0)} percent from first to last`
		.replace(/\s+/g, " ")
		.trim();
}

const trended = new Set(["lineChart", "areaChart", "comboChart"]);

export function describeChart(
	visualType: string,
	rows: Record<string, unknown>[],
	dimensions: string[],
	measures: string[],
	title?: string | null,
): string {
	const kind = visualByType[visualType]?.label ?? "Chart";
	const named = title?.trim() ? `${title.trim()}. ` : "";

	if (rows.length === 0) return `${named}${kind} with no data.`;

	const of = measures.length > 0 ? ` of ${joinWords(measures)}` : "";
	const by = dimensions.length > 0 ? ` by ${joinWords(dimensions)}` : "";
	const count = rows.length === 1 ? "1 point" : `${rows.length} points`;

	const parts = [`${named}${kind}${of}${by}`, count];

	if (trended.has(visualType) && measures[0]) {
		const way = direction(rows, measures[0]);
		if (way) parts.push(way);
	}

	return `${parts.join(", ")}.`;
}
