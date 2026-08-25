// The catalogue of things an editor can place on a page.
//
// This is the single source of truth for what exists: the editor's picker
// reads it, the renderer switches on it, and validation checks an encoding
// against it. Adding a type here and a case in the renderer is the whole job,
// because a visual's definition is data rather than code.
//
// Each entry declares what it needs rather than what it looks like. A visual
// that has not been given enough fields renders a specific message saying what
// is missing, instead of an empty frame the author has to guess about.

export type VisualCategory =
	| "summary"
	| "comparison"
	| "trend"
	| "distribution"
	| "composition"
	| "relationship"
	| "detail"
	| "filter"
	| "text";

export interface EncodingRequirement {
	// How many dimensions the visual needs, and the most it can use.
	dimensions: { min: number; max: number; label?: string };
	measures: { min: number; max: number; label?: string };
}

export interface VisualTypeDefinition {
	type: string;
	label: string;
	category: VisualCategory;
	// One line explaining when to reach for it, shown in the picker. Chart
	// choice is where most reporting goes wrong, so the guidance sits next to
	// the choice rather than in documentation nobody opens.
	guidance: string;
	encoding: EncodingRequirement;
	// Style controls worth offering for this type. The editor hides the rest,
	// so a pie chart is not offered an axis label.
	supports: {
		color?: boolean;
		fill?: boolean;
		stacking?: boolean;
		secondAxis?: boolean;
		conditionalFormat?: boolean;
		colorScale?: boolean;
		// Can grow to the foot of the screen when it is the last thing on the
		// page. Worth offering where a reader works inside the visual rather
		// than glancing at it.
		fillHeight?: boolean;
		axes?: boolean;
		legend?: boolean;
		tooltip?: boolean;
	};
	// Default layout footprint on the page grid, in a 12 column space.
	defaultLayout: { w: number; h: number };
}

export const visualCatalog: VisualTypeDefinition[] = [
	// --- Summary -----------------------------------------------------------
	{
		type: "kpiRow",
		label: "KPI tiles",
		category: "summary",
		guidance:
			"Headline figures with no breakdown. Use for the handful of numbers a reader should see first.",
		encoding: { dimensions: { min: 0, max: 0 }, measures: { min: 1, max: 8 } },
		supports: { color: true, conditionalFormat: true },
		defaultLayout: { w: 12, h: 2 },
	},
	{
		type: "gauge",
		label: "Gauge",
		category: "summary",
		guidance:
			"A single value against a target. Only worth it when the target is meaningful; otherwise a KPI tile says the same thing in less space.",
		encoding: { dimensions: { min: 0, max: 0 }, measures: { min: 1, max: 2 } },
		supports: { color: true, tooltip: true },
		defaultLayout: { w: 3, h: 4 },
	},

	// --- Comparison --------------------------------------------------------
	{
		type: "barChart",
		label: "Bar chart",
		category: "comparison",
		guidance:
			"Compare a measure across categories. The default choice for ranking.",
		encoding: {
			dimensions: { min: 1, max: 2, label: "Category, then optional series" },
			measures: { min: 1, max: 6 },
		},
		supports: {
			color: true, fill: true, stacking: true, secondAxis: true,
			axes: true, legend: true, tooltip: true,
		},
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "horizontalBarChart",
		label: "Horizontal bar",
		category: "comparison",
		guidance:
			"Same as a bar chart but with room for long category names, which is most of the time in practice.",
		encoding: {
			dimensions: { min: 1, max: 2 },
			measures: { min: 1, max: 6 },
		},
		supports: {
			color: true, fill: true, stacking: true, axes: true,
			legend: true, tooltip: true,
		},
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "comboChart",
		label: "Combo (bar and line)",
		category: "comparison",
		guidance:
			"Two measures on different scales, such as revenue as bars with a percentage as a line. Set the line series to the right axis.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 2, max: 6 },
		},
		supports: {
			color: true, fill: true, secondAxis: true, axes: true,
			legend: true, tooltip: true,
		},
		defaultLayout: { w: 6, h: 5 },
	},

	// --- Trend -------------------------------------------------------------
	{
		type: "lineChart",
		label: "Line chart",
		category: "trend",
		guidance:
			"A measure over time. Put the date dimension first; the view already carries prior-period measures if you need a comparison.",
		encoding: {
			dimensions: { min: 1, max: 2, label: "Time, then optional series" },
			measures: { min: 1, max: 6 },
		},
		supports: {
			color: true, fill: true, secondAxis: true, axes: true,
			legend: true, tooltip: true,
		},
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "areaChart",
		label: "Area chart",
		category: "trend",
		guidance:
			"A trend where the volume matters as much as the direction. Stack it only when the total is meaningful.",
		encoding: {
			dimensions: { min: 1, max: 2 },
			measures: { min: 1, max: 6 },
		},
		supports: {
			color: true, fill: true, stacking: true, axes: true,
			legend: true, tooltip: true,
		},
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "waterfallChart",
		label: "Waterfall",
		category: "trend",
		guidance:
			"How a total was built up or eroded, step by step. Reads well for bridges between two periods.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 1, max: 1 },
		},
		supports: { color: true, axes: true, tooltip: true },
		defaultLayout: { w: 6, h: 5 },
	},

	// --- Composition -------------------------------------------------------
	{
		type: "pieChart",
		label: "Pie chart",
		category: "composition",
		guidance:
			"Parts of a whole, at most five or six slices. People compare angles poorly, so a bar chart is usually the better answer.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 1, max: 1 },
		},
		supports: { color: true, legend: true, tooltip: true },
		defaultLayout: { w: 4, h: 5 },
	},
	{
		type: "donutChart",
		label: "Donut chart",
		category: "composition",
		guidance:
			"A pie with the total in the middle. Same caution about slice counts applies.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 1, max: 1 },
		},
		supports: { color: true, legend: true, tooltip: true },
		defaultLayout: { w: 4, h: 5 },
	},
	{
		type: "treemapChart",
		label: "Treemap",
		category: "composition",
		guidance:
			"Composition with many categories, where a pie would be unreadable. Area encodes the measure.",
		encoding: {
			dimensions: { min: 1, max: 2 },
			measures: { min: 1, max: 1 },
		},
		supports: { color: true, colorScale: true, tooltip: true },
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "funnelChart",
		label: "Funnel",
		category: "composition",
		guidance:
			"Stages that narrow, such as a pipeline. The order of the dimension is the order of the stages.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 1, max: 1 },
		},
		supports: { color: true, legend: true, tooltip: true },
		defaultLayout: { w: 4, h: 5 },
	},
	{
		type: "stackedBarChart",
		label: "100% stacked bar",
		category: "composition",
		guidance:
			"Share of total across categories, where the mix matters more than the size.",
		encoding: {
			dimensions: { min: 1, max: 2 },
			measures: { min: 1, max: 8 },
		},
		supports: { color: true, axes: true, legend: true, tooltip: true },
		defaultLayout: { w: 6, h: 5 },
	},

	// --- Distribution and relationship -------------------------------------
	{
		type: "scatterChart",
		label: "Scatter plot",
		category: "relationship",
		guidance:
			"Whether two measures move together. Add a second measure for the second axis.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 1, max: 3 },
		},
		supports: { color: true, axes: true, legend: true, tooltip: true },
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "heatmapChart",
		label: "Heatmap",
		category: "distribution",
		guidance:
			"One measure across two dimensions, such as month by product. Colour encodes the value.",
		encoding: {
			dimensions: { min: 2, max: 2, label: "Rows and columns" },
			measures: { min: 1, max: 1 },
		},
		supports: { colorScale: true, tooltip: true },
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "radarChart",
		label: "Radar",
		category: "distribution",
		guidance:
			"Several measures compared across a few categories. Hard to read past three or four series.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 3, max: 8 },
		},
		supports: { color: true, fill: true, legend: true, tooltip: true },
		defaultLayout: { w: 4, h: 5 },
	},

	// --- Detail ------------------------------------------------------------
	{
		type: "table",
		label: "Table",
		category: "detail",
		guidance:
			"The exact figures, with sorting, per-column filters and export. Use when a reader needs to look something up rather than see a shape.",
		// Deliberately wide. A detail table is what someone reaches for when
		// they want the row itself, and a roster or an export is routinely
		// dozens of columns. Capping it low only pushes people back to the
		// spreadsheet this is meant to replace.
		encoding: {
			dimensions: { min: 0, max: 60 },
			measures: { min: 0, max: 60 },
		},
		supports: {
			conditionalFormat: true, colorScale: true, tooltip: true,
			fillHeight: true,
		},
		defaultLayout: { w: 12, h: 6 },
	},
	{
		type: "matrixTable",
		label: "Matrix (expandable)",
		category: "detail",
		guidance:
			"A hierarchy down the left that expands level by level, with an optional dimension pivoted across the top. Order the row fields outermost first, such as Year then Division then Business Unit.",
		encoding: {
			dimensions: {
				min: 1,
				max: 5,
				label: "Row hierarchy, outermost first, then an optional pivot",
			},
			measures: { min: 1, max: 8 },
		},
		supports: {
			conditionalFormat: true, colorScale: true, tooltip: true,
			fillHeight: true,
		},
		defaultLayout: { w: 12, h: 6 },
	},
	{
		type: "definitionList",
		label: "Detail panel",
		category: "detail",
		guidance:
			"Everything known about a single record, laid out as label and value.",
		// "Everything known" is the point of it, so the bound is generous.
		encoding: {
			dimensions: { min: 1, max: 60 },
			measures: { min: 0, max: 60 },
		},
		supports: { conditionalFormat: true },
		defaultLayout: { w: 4, h: 4 },
	},

	// --- Filters -----------------------------------------------------------
	{
		type: "dimensionSwitch",
		label: "Breakdown switcher",
		category: "filter",
		guidance:
			"Repoints every visual on the page that uses the breakdown placeholder. One chart plus this control replaces a page per breakdown.",
		encoding: {
			dimensions: { min: 2, max: 12, label: "Breakdowns to offer" },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		defaultLayout: { w: 4, h: 1 },
	},
	{
		type: "periodSwitch",
		label: "Time grain switcher",
		category: "filter",
		guidance:
			"Offers month, quarter and year as a choice rather than as three pages. Repoints the same visuals the breakdown switcher does.",
		encoding: {
			dimensions: { min: 2, max: 8, label: "Grains to offer" },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		defaultLayout: { w: 4, h: 1 },
	},
	{
		type: "filterBar",
		label: "Filter group",
		category: "filter",
		guidance:
			"One dropdown per field, kept together. For a page where readers narrow by several things at once.",
		encoding: {
			dimensions: { min: 1, max: 12, label: "Fields to offer" },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		defaultLayout: { w: 12, h: 1 },
	},
	{
		type: "thresholdControl",
		label: "Threshold",
		category: "filter",
		guidance:
			"Keeps rows where a measure clears a cutoff the reader sets. For \"orders above\" and \"anything under\" questions.",
		encoding: {
			dimensions: { min: 0, max: 1 },
			measures: { min: 1, max: 1, label: "Measure to test" },
		},
		supports: {},
		defaultLayout: { w: 3, h: 1 },
	},
	{
		type: "dropdownFilter",
		label: "Dropdown filter",
		category: "filter",
		guidance:
			"Pick one or several values for a field. Values are read from the data and narrow as other filters are applied.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "Field to filter" },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		defaultLayout: { w: 3, h: 1 },
	},
	{
		type: "searchFilter",
		label: "Search box",
		category: "filter",
		guidance:
			"Free text matched across the fields you choose. Case-insensitive contains.",
		encoding: {
			dimensions: { min: 1, max: 10, label: "Fields to search" },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		defaultLayout: { w: 4, h: 1 },
	},
	{
		type: "bulkFilter",
		label: "Bulk value filter",
		category: "filter",
		guidance:
			"Paste a list of ids or codes and match any of them. For the case where someone arrives with a spreadsheet column.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		defaultLayout: { w: 3, h: 2 },
	},
	{
		type: "dateRangeFilter",
		label: "Date range",
		category: "filter",
		guidance:
			"Restrict to a period, with the usual relative presets.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "Date field" },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		defaultLayout: { w: 4, h: 1 },
	},
	{
		type: "numericRangeFilter",
		label: "Numeric range",
		category: "filter",
		guidance:
			"Restrict a measure or numeric dimension to a band.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 0, max: 1 },
		},
		supports: {},
		defaultLayout: { w: 3, h: 1 },
	},

	{
		type: "entityHeader",
		label: "Entity header",
		category: "detail",
		guidance:
			"The identifying attributes of the one thing a detail page is about, laid out as a header rather than a table.",
		encoding: {
			dimensions: { min: 1, max: 12, label: "Attributes to show" },
			measures: { min: 0, max: 4 },
		},
		supports: { conditionalFormat: true },
		// Three rows rather than two: the attributes wrap onto a second line as
		// soon as there are more than a few, and a header that scrolls is not a
		// header.
		defaultLayout: { w: 12, h: 3 },
	},

	// --- Text --------------------------------------------------------------
	{
		type: "textPanel",
		label: "Text panel",
		category: "text",
		guidance:
			"A note, caveat or definition. Worth adding wherever a number needs explaining.",
		encoding: {
			dimensions: { min: 0, max: 0 },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		defaultLayout: { w: 4, h: 2 },
	},
	{
		type: "blockedNotice",
		label: "Blocked notice",
		category: "text",
		guidance:
			"States what a page is waiting on. Better than an empty page, which reads as broken rather than as not built yet.",
		encoding: {
			dimensions: { min: 0, max: 0 },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		defaultLayout: { w: 12, h: 2 },
	},
];

export const visualByType: Record<string, VisualTypeDefinition> =
	Object.fromEntries(visualCatalog.map((v) => [v.type, v]));

export function isFilterVisual(type: string): boolean {
	return visualByType[type]?.category === "filter";
}

// Controls that act on the whole page rather than showing data of their own.
//
// These never sit in the page grid. A reader sees them lifted into a strip
// above the content, so the editor has to place them the same way: a control
// given a grid box would be clipped to a size that has nothing to do with how
// it will actually render, which is what happened when the two lists of
// control types were maintained separately.
export function isPageControl(type: string): boolean {
	return isFilterVisual(type) || type === "dimensionSwitch" || type === "periodSwitch";
}

export const categoryLabels: Record<VisualCategory, string> = {
	summary: "Summary",
	comparison: "Comparison",
	trend: "Trend over time",
	distribution: "Distribution",
	composition: "Composition",
	relationship: "Relationship",
	detail: "Detail",
	filter: "Filters",
	text: "Text",
};

export interface EncodingProblem {
	kind: "missing" | "excess";
	field: "dimensions" | "measures";
	message: string;
}

// Checks an encoding against what the type needs, so a visual can say what it
// is waiting for rather than rendering an unexplained empty frame.
export function checkEncoding(
	type: string,
	dimensions: string[],
	measures: string[],
): EncodingProblem | null {
	const definition = visualByType[type];
	if (!definition) return null;

	const { dimensions: d, measures: m } = definition.encoding;

	if (dimensions.length < d.min) {
		const need = d.min - dimensions.length;
		return {
			kind: "missing",
			field: "dimensions",
			message: `Add ${need} more ${need === 1 ? "dimension" : "dimensions"}${
				d.label ? ` (${d.label})` : ""
			}`,
		};
	}
	if (measures.length < m.min) {
		const need = m.min - measures.length;
		return {
			kind: "missing",
			field: "measures",
			message: `Add ${need} more ${need === 1 ? "measure" : "measures"}`,
		};
	}
	if (dimensions.length > d.max) {
		return {
			kind: "excess",
			field: "dimensions",
			message: `This visual uses at most ${d.max} ${
				d.max === 1 ? "dimension" : "dimensions"
			}`,
		};
	}
	if (measures.length > m.max) {
		return {
			kind: "excess",
			field: "measures",
			message: `This visual uses at most ${m.max} ${
				m.max === 1 ? "measure" : "measures"
			}`,
		};
	}
	return null;
}

// Whether a visual should grow to the foot of the screen when it is the last
// thing on the page.
//
// On by default for the types that offer it: a detail table is where a reader
// spends their time, and a short box inside a tall screen makes them scroll
// through a window when the room was already there. An author turns it off
// where the table is deliberately a preview.
export function fillsHeight(
	type: string,
	options: Record<string, unknown> | undefined,
): boolean {
	if (!visualByType[type]?.supports.fillHeight) return false;
	return options?.fillHeight !== false;
}
