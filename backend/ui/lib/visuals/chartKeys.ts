import type { MarkClick } from "./selection";

// Moving between a chart's marks from the keyboard.
//
// A canvas has no elements to tab through, so the marks a reader can step
// across are read off the built option. Each one carries the same event shape
// a click on it would, so choosing a mark with a key goes down the path a click
// does and selects, toggles and explains the same way.

export interface KeyMark {
	seriesIndex: number;
	// Absent where the library finds the mark by name instead, which is the
	// treemap, whose data indices count every node of the tree.
	dataIndex?: number;
	// Set alongside or instead of the index for the same reason.
	name?: string;
	click: MarkClick;
	// What the mark is called, as the row's own value, and its figure.
	label: string;
	value: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function list(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	return value === undefined || value === null ? [] : [value];
}

// The category names along the first category axis, in drawn order.
function categoryNames(option: Record<string, unknown>): unknown[] {
	for (const axis of [...list(option.xAxis), ...list(option.yAxis)]) {
		const entry = record(axis);
		if (entry?.type === "category" && Array.isArray(entry.data)) {
			return entry.data.map((item) => record(item)?.value ?? item);
		}
	}
	return [];
}

// The figure a data item carries. A pair or a triple, such as a heatmap
// cell, holds its figure last.
function figureOf(item: unknown): unknown {
	const own = record(item);
	const value = own ? own.value : item;
	return Array.isArray(value) ? value[value.length - 1] : value;
}

function text(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

// What a mark is called to a reader. A mark built from a row keeps that row's
// own value beside the drawn name, which for a sankey node is a prefixed id
// and for a map region is the boundary's spelling.
function labelOf(item: Record<string, unknown> | null, name: string): string {
	if (item && Array.isArray(item.raws) && item.raws.length > 0) {
		return item.raws.map(text).join(" and ");
	}
	if (item && item.raw !== undefined) return text(item.raw);
	return name;
}

// Every mark a reader can step to, in drawn order.
export function keyboardMarks(visualType: string, option: unknown): KeyMark[] {
	const built = record(option);
	if (!built) return [];
	const series = list(built.series).map(record);

	// One line per category, so a step is a line rather than a point.
	if (visualType === "slopeChart") {
		const out: KeyMark[] = [];
		series.forEach((entry, seriesIndex) => {
			if (!entry || entry.silent === true) return;
			const name = text(entry.name);
			if (!name) return;
			const points = list(entry.data);
			out.push({
				seriesIndex,
				dataIndex: Math.max(points.length - 1, 0),
				click: { seriesName: name, name },
				label: name,
				value: figureOf(points[points.length - 1]),
			});
		});
		return out;
	}

	// The first series a reader can see and point at. A floating bar is
	// drawn on an invisible run-up series, which is silent.
	const seriesIndex = series.findIndex(
		(entry) =>
			entry !== null &&
			entry.silent !== true &&
			Array.isArray(entry.data) &&
			entry.data.length > 0,
	);
	if (seriesIndex < 0) return [];
	const chosen = series[seriesIndex] as Record<string, unknown>;
	const seriesName =
		chosen.name === undefined ? undefined : text(chosen.name);
	const byName = visualType === "treemapChart";
	const categories = categoryNames(built);

	return (chosen.data as unknown[]).map((item, dataIndex) => {
		const own = record(item);
		const name =
			own && typeof own.name === "string"
				? own.name
				: text(categories[dataIndex]);
		const click: MarkClick = {
			name,
			seriesName,
			dataIndex,
			data: item,
			value: own ? own.value : item,
		};
		if (visualType === "sankeyChart") click.dataType = "node";
		return {
			seriesIndex,
			dataIndex: byName ? undefined : dataIndex,
			name: byName ? name : undefined,
			click,
			label: labelOf(own, name),
			value: figureOf(item),
		};
	});
}

// The mark a key moves to from the current one, or null when the key is not a
// step. Nothing focused yet starts at whichever end the key points away from.
// The ends hold rather than wrap, so holding a key stops at the last mark.
export function stepMark(
	current: number,
	count: number,
	key: string,
): number | null {
	if (count <= 0) return null;
	switch (key) {
		case "ArrowRight":
		case "ArrowDown":
			return current < 0 ? 0 : Math.min(current + 1, count - 1);
		case "ArrowLeft":
		case "ArrowUp":
			return current < 0 ? count - 1 : Math.max(current - 1, 0);
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
}
