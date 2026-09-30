import { blankLabel, formatDate } from "../format";

// What a click on a visual selects, and how that selection becomes a page
// filter and a label.
//
// Every chart type draws its marks differently. A bar is named by its axis
// category, a slope line by its series, a sankey node by a prefixed id, a
// heatmap cell by two axis positions, a map region by the boundary's own name
// rather than by the value in the data. Reading the dimension value back out
// of a click is therefore a per-type question, and answering it in one place
// is what keeps the answer the same across the chart, the page filter, the
// chip that shows it and the dimming that marks it.

// One field and the values a selection holds for it. A value is the row's own
// value as text, with an empty string standing for a blank.
export interface SelectionPart {
	field: string;
	values: string[];
}

// The fields a click event carries that any of the types read.
export interface MarkClick {
	name?: string;
	seriesName?: string;
	dataIndex?: number;
	dataType?: string;
	value?: unknown;
	data?: unknown;
	treePathInfo?: { name?: string }[];
}

// The page filter clause shape, repeated here so this module stays free of
// the React context that owns the page state.
export interface SelectionClause {
	field: string;
	op: string;
	value?: string;
	values?: string[];
}

// A timestamp at midnight is a date, so it is sent as the plain date the query
// rows carry. Anything else is passed through as text, unchanged.
const midnight = /^(\d{4}-\d{2}-\d{2})[T ]00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?$/;
const plainDate = /^\d{4}-\d{2}-\d{2}$/;

export function selectionValue(raw: unknown): string {
	if (raw === null || raw === undefined) return "";
	const text = String(raw);
	const match = midnight.exec(text);
	return match ? match[1] : text;
}

// Types whose marks are values of a dimension, given the fields the visual is
// drawn from. A gauge is one figure and a histogram's bars are ranges of a
// measure, so neither has a value to select. A box plot draws one box per
// group only when it has a grouping field, and a single box is the whole set.
export function canSelect(visualType: string, dimensions: string[]): boolean {
	if (dimensions.length === 0) return false;
	switch (visualType) {
		case "gauge":
		case "histogramChart":
		case "kpiRow":
			return false;
		case "boxPlot":
			return dimensions.length > 1;
		default:
			return true;
	}
}

function part(field: string | undefined, raw: unknown): SelectionPart[] | null {
	if (!field || raw === undefined) return null;
	return [{ field, values: [selectionValue(raw)] }];
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

// The dimension values a click on a mark stands for, outermost first, or null
// when the mark is not a value of any dimension.
export function selectionFromClick(
	visualType: string,
	dimensions: string[],
	measures: string[],
	click: MarkClick,
): SelectionPart[] | null {
	if (!canSelect(visualType, dimensions)) return null;
	const data = record(click.data);

	switch (visualType) {
		// One line per category, and the point clicked is named by the
		// position along the axis rather than by the category.
		case "slopeChart":
			return part(dimensions[0], click.seriesName);

		// The path runs from the root, so a group is one step below it and a
		// tile inside a group is two.
		case "treemapChart": {
			const path = (click.treePathInfo ?? [])
				.slice(1)
				.map((step) => step.name ?? "");
			if (path.length === 0) return part(dimensions[0], click.name);
			return path.slice(0, dimensions.length).map((name, depth) => ({
				field: dimensions[depth],
				values: [selectionValue(name)],
			}));
		}

		// A node is one value on its own side. A link is one value from each
		// side, which is the flow between them.
		case "sankeyChart": {
			if (click.dataType === "edge") {
				const raws = data.raws;
				if (!Array.isArray(raws) || raws.length < 2) return null;
				return [
					{ field: dimensions[0], values: [selectionValue(raws[0])] },
					{ field: dimensions[1], values: [selectionValue(raws[1])] },
				].filter((entry) => Boolean(entry.field));
			}
			const side = data.side === 1 ? 1 : 0;
			return part(dimensions[side], data.raw);
		}

		// A cell is a row value and a column value together.
		case "heatmapChart": {
			const raws = data.raws;
			if (!Array.isArray(raws) || raws.length < 2) return null;
			return [
				{ field: dimensions[0], values: [selectionValue(raws[0])] },
				{ field: dimensions[1], values: [selectionValue(raws[1])] },
			].filter((entry) => Boolean(entry.field));
		}

		case "calendarChart": {
			const value = Array.isArray(click.value)
				? click.value
				: Array.isArray(data.value)
					? (data.value as unknown[])
					: null;
			return value ? part(dimensions[0], value[0]) : null;
		}

		// A region is named by the boundary data, which spells several
		// countries differently from the data. Every value in the data that
		// landed on the region is selected, so the filter matches what the
		// region drew.
		case "choroplethChart": {
			const raws = data.raws;
			if (!Array.isArray(raws) || raws.length === 0) return null;
			return [
				{
					field: dimensions[0],
					values: raws.map((raw) => selectionValue(raw)),
				},
			];
		}

		// The gathered tail is a sum of several values rather than one.
		case "pieChart":
		case "donutChart":
			if (data.tail === true) return null;
			return part(dimensions[0], click.name);

		// A segment of a stack split by a second dimension is one value of
		// each, the category along the axis and the series it belongs to.
		case "stackedBarChart":
			if (
				dimensions.length > 1 &&
				measures.length === 1 &&
				click.seriesName !== undefined
			) {
				return [
					{
						field: dimensions[0],
						values: [selectionValue(click.name)],
					},
					{
						field: dimensions[1],
						values: [selectionValue(click.seriesName)],
					},
				];
			}
			return part(dimensions[0], click.name);

		default:
			return part(dimensions[0], click.name);
	}
}

// The page filter a selection applies. A blank is matched as a missing value,
// because an equality against an empty string cannot match a null date or
// number.
export function selectionClauses(parts: SelectionPart[]): SelectionClause[] {
	return parts.map((entry) =>
		entry.values.length === 1 && entry.values[0] === ""
			? { field: entry.field, op: "is_empty" }
			: { field: entry.field, op: "eq", values: entry.values },
	);
}

// A selection read back from the clauses it was applied as, so a visual can
// mark what it selected.
export function partsFromClauses(clauses: unknown[]): SelectionPart[] {
	const out: SelectionPart[] = [];
	for (const raw of clauses) {
		const clause = record(raw) as Partial<SelectionClause>;
		if (typeof clause.field !== "string") continue;
		if (clause.op === "is_empty") {
			out.push({ field: clause.field, values: [""] });
		} else if (clause.op === "eq" && Array.isArray(clause.values)) {
			out.push({
				field: clause.field,
				values: clause.values.map((value) => selectionValue(value)),
			});
		} else if (clause.op === "eq" && clause.value !== undefined) {
			out.push({
				field: clause.field,
				values: [selectionValue(clause.value)],
			});
		}
	}
	return out;
}

// One value as a reader expects to see it in the filter bar. A date is shown
// the way the rest of the app shows dates, and a blank by name.
export function describeValue(value: string): string {
	if (value === "") return blankLabel;
	if (plainDate.test(value)) return formatDate(value);
	return value;
}

// The chip text for a selection, such as "Region: North" or
// "Region: North, Channel: Online".
export function selectionLabel(
	parts: SelectionPart[],
	nameOf: (field: string) => string = (field) => field,
): string {
	return parts
		.map((entry) => {
			const shown =
				entry.values.length > 3
					? `${entry.values.length} selected`
					: entry.values.map(describeValue).join(" or ");
			return `${nameOf(entry.field)}: ${shown}`;
		})
		.join(", ");
}

// Whether a mark, described by the dimension values it stands for, is inside
// the selection. A field the mark does not carry is not held against it, so a
// group containing the selected tile counts as selected.
export function matchesSelection(
	parts: SelectionPart[],
	mark: Record<string, unknown>,
): boolean {
	for (const entry of parts) {
		if (!(entry.field in mark)) continue;
		if (!entry.values.includes(selectionValue(mark[entry.field]))) {
			return false;
		}
	}
	return true;
}

// Whether a selection touches any of the given fields. A selection on a field
// the visual no longer draws, such as after a breakdown switch, marks nothing.
export function selectionCovers(
	parts: SelectionPart[] | null | undefined,
	fields: string[],
): parts is SelectionPart[] {
	return Boolean(parts?.some((entry) => fields.includes(entry.field)));
}
