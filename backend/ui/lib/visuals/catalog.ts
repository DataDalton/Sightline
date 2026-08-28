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
	| "text"
	| "layout";

export interface EncodingRequirement {
	// How many dimensions the visual needs, and the most it can use.
	dimensions: { min: number; max: number; label?: string };
	measures: { min: number; max: number; label?: string };
}

// A setting that belongs to one kind of visual rather than to all of them.
//
// Declared here rather than written into the properties panel, for the same
// reason the query shape is declared in lib/query/visualSpec: a control the
// editor draws and a value the renderer reads are two halves of one thing, and
// when they are written in two places they drift. Several already had: the
// pivot column of a cross-tab, whether a dropdown takes more than one value,
// which way a threshold cuts. All of them worked, and none could be reached
// without hand-writing an import manifest.
//
// The default lives here too, so the control and the renderer cannot disagree
// about what happens when nobody has chosen.
export type VisualOption =
	| {
			key: string;
			label: string;
			kind: "select";
			choices: { value: string; label: string }[];
			fallback: string;
			help?: string;
	  }
	| {
			key: string;
			label: string;
			kind: "toggle";
			fallback: boolean;
			help?: string;
	  }
	| {
			key: string;
			label: string;
			kind: "number";
			fallback?: number;
			min?: number;
			max?: number;
			step?: number;
			help?: string;
	  }
	| {
			key: string;
			label: string;
			kind: "text";
			fallback?: string;
			placeholder?: string;
			help?: string;
	  }
	// Bands of measures, each with a label. Repeatable, so none of the scalar
	// kinds above can express it.
	| { key: string; label: string; kind: "measureGroups"; help?: string }
	// A field chosen from the source the visual reads. "none" is always
	// offered, because every field option here is one an author may not want.
	| {
			key: string;
			label: string;
			kind: "field";
			scope: "dimension" | "measure";
			// Where the choices come from.
			//
			// "encoded" is the default and is right for a setting about
			// something already on the visual, such as which measure a top ten
			// is ranked by. "source" is for a setting about the page rather
			// than the visual: the date a comparison window sits on is the one
			// the page's range filter applies to, and a scorecard has no
			// dimensions of its own to choose it from, so an encoded list would
			// be empty and the setting unreachable.
			from?: "encoded" | "source";
			// Narrows the choices to fields that look like dates, so a
			// comparison window is not offered Product Number.
			role?: "temporal";
			help?: string;
	  };

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
		// A target, a budget or the average drawn across the plot. Only for
		// types with a value scale to place one against.
		referenceLines?: boolean;
	};
	// Settings particular to this type, offered in the properties panel in the
	// order they are declared.
	options?: VisualOption[];
	// Default layout footprint on the page grid, in a 12 column space.
	defaultLayout: { w: number; h: number };
}

// What an option is set to, or what it falls back to when nobody has chosen.
//
// The renderer reads through this rather than reaching into config.options
// directly, so a default changed in the catalogue changes what renders as well
// as what the editor shows.
export function optionValue<T = unknown>(
	visualType: string,
	config: { options?: Record<string, unknown> } | undefined,
	key: string,
): T | undefined {
	const declared = visualByType[visualType]?.options?.find(
		(o) => o.key === key,
	);
	const set = config?.options?.[key];
	if (set !== undefined && set !== null && set !== "") return set as T;
	if (!declared) return undefined;
	return ("fallback" in declared ? declared.fallback : undefined) as
		| T
		| undefined;
}

export const visualCatalog: VisualTypeDefinition[] = [
	// --- Summary -----------------------------------------------------------
	{
		type: "kpiRow",
		label: "KPI tiles",
		category: "summary",
		guidance:
			"Headline figures with no breakdown. Use for the handful of numbers a reader should see first.",
		// Room for several bands. One row of tiles is four or so before they
		// stop being readable, and the point of grouping them is to have more
		// than one row.
		encoding: {
			dimensions: { min: 0, max: 0 },
			measures: { min: 1, max: 24 },
		},
		supports: { color: true, conditionalFormat: true },
		options: [
			{
				key: "compareTo",
				label: "Compare against",
				kind: "select",
				choices: [
					{ value: "", label: "Nothing" },
					{ value: "year", label: "The same window a year earlier" },
					{
						value: "quarter",
						label: "The same window a quarter earlier",
					},
					{
						value: "month",
						label: "The same window a month earlier",
					},
					{ value: "previous", label: "The period before" },
				],
				fallback: "",
				help: "Adds the change since then under each figure. Asks the same question again with the page's date window moved back, so whatever the reader has filtered to is what gets compared.",
			},
			{
				key: "compareField",
				label: "Date the window sits on",
				kind: "field",
				scope: "dimension",
				from: "source",
				role: "temporal",
				help: "Which date the page's range filter applies to. The comparison needs a range on the page to move, so with nothing filtered the figures show on their own.",
			},
			{
				key: "sparkline",
				label: "Trend each tile over",
				kind: "field",
				scope: "dimension",
				help: "Draws the shape of each figure across this dimension inside the tile. Usually the month or the week.",
			},
			{
				key: "groups",
				label: "Bands",
				kind: "measureGroups",
				help: "Splits the tiles into labelled rows. Each band takes the next few measures in order, and anything left over becomes a final unlabelled row.",
			},
		],
		defaultLayout: { w: 12, h: 2 },
	},
	{
		type: "gauge",
		label: "Gauge",
		category: "summary",
		guidance:
			"A single value against a target. Only worth it when the target is meaningful; otherwise a KPI tile says the same thing in less space.",
		encoding: {
			dimensions: { min: 0, max: 0 },
			measures: { min: 1, max: 2 },
		},
		supports: { color: true, tooltip: true },
		defaultLayout: { w: 3, h: 4 },
	},
	{
		type: "bulletChart",
		label: "Progress to target",
		category: "summary",
		guidance:
			"Actual against target, one row per category. Says whether something is on plan in a strip a quarter the height of a gauge, and shows several at once where a gauge shows one.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "One row each" },
			measures: {
				min: 2,
				max: 2,
				label: "What happened, then what was aimed for",
			},
		},
		supports: { color: true, tooltip: true, axes: true },
		options: [
			{
				key: "colourByTarget",
				label: "Colour by whether the target was met",
				kind: "toggle",
				fallback: true,
				help: "Off leaves every bar the series colour, which is right when clearing the target is not straightforwardly good.",
			},
			{
				key: "sortBy",
				label: "Order rows by",
				kind: "select",
				choices: [
					{ value: "source", label: "The order they arrive in" },
					{ value: "valueDesc", label: "Furthest ahead first" },
					{ value: "valueAsc", label: "Furthest behind first" },
				],
				fallback: "valueAsc",
				help: "Behind first by default, because the rows that need attention are the ones worth putting at the top.",
			},
		],
		defaultLayout: { w: 6, h: 4 },
	},

	// --- Comparison --------------------------------------------------------
	{
		type: "barChart",
		label: "Bar chart",
		category: "comparison",
		guidance:
			"Compare a measure across categories. The default choice for ranking.",
		encoding: {
			dimensions: {
				min: 1,
				max: 2,
				label: "Category, then optional series",
			},
			measures: { min: 1, max: 6 },
		},
		supports: {
			color: true,
			fill: true,
			stacking: true,
			secondAxis: true,
			axes: true,
			legend: true,
			tooltip: true,
			referenceLines: true,
		},
		options: [
			{
				key: "zoomSlider",
				label: "Let readers zoom the axis",
				kind: "toggle",
				fallback: false,
				help: "Adds a slider under the plot and lets the wheel narrow it. For a series long enough that the whole of it does not read at once.",
			},
			{
				key: "topN",
				label: "Keep only the top",
				kind: "number",
				min: 1,
				max: 500,
				help: "Ranks by the measure below and asks the warehouse for that many rows. Left empty it asks for everything and draws it, which for a few thousand categories is a chart nobody can read and a query nobody needed.",
			},
			{
				key: "topBy",
				label: "Ranked by",
				kind: "field",
				scope: "measure",
				help: "Defaults to the first measure.",
			},
			{
				key: "sortBy",
				label: "Order bars by",
				kind: "select",
				choices: [
					{ value: "category", label: "Category" },
					{ value: "valueDesc", label: "Value, largest first" },
					{ value: "valueAsc", label: "Value, smallest first" },
				],
				fallback: "category",
				help: "Sorted on the marks rather than in the query, so a grid reading the same fields still shares the cached answer.",
			},
			{
				key: "valueLabels",
				label: "Print values on bars",
				kind: "toggle",
				fallback: false,
				help: "Worth it for a handful of bars a reader will quote. Past that the axis says it more quietly.",
			},
		],
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
			color: true,
			fill: true,
			stacking: true,
			axes: true,
			legend: true,
			tooltip: true,
			referenceLines: true,
		},
		options: [
			{
				key: "zoomSlider",
				label: "Let readers zoom the axis",
				kind: "toggle",
				fallback: false,
				help: "Adds a slider under the plot and lets the wheel narrow it. For a series long enough that the whole of it does not read at once.",
			},
			{
				key: "topN",
				label: "Keep only the top",
				kind: "number",
				min: 1,
				max: 500,
				help: "Ranks by the measure below and asks the warehouse for that many rows. Left empty it asks for everything and draws it, which for a few thousand categories is a chart nobody can read and a query nobody needed.",
			},
			{
				key: "topBy",
				label: "Ranked by",
				kind: "field",
				scope: "measure",
				help: "Defaults to the first measure.",
			},
			{
				key: "sortBy",
				label: "Order bars by",
				kind: "select",
				choices: [
					{ value: "category", label: "Category" },
					{ value: "valueDesc", label: "Value, largest first" },
					{ value: "valueAsc", label: "Value, smallest first" },
				],
				fallback: "category",
			},
			{
				key: "valueLabels",
				label: "Print values on bars",
				kind: "toggle",
				fallback: false,
			},
		],
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
			color: true,
			fill: true,
			secondAxis: true,
			axes: true,
			legend: true,
			tooltip: true,
			referenceLines: true,
		},
		options: [
			{
				key: "zoomSlider",
				label: "Let readers zoom the axis",
				kind: "toggle",
				fallback: false,
				help: "Adds a slider under the plot and lets the wheel narrow it. For a series long enough that the whole of it does not read at once.",
			},
			// The query layer already ranks any chart carrying these, so a
			// combo drawn over categories was the one comparison chart whose
			// author could not say "the largest twelve" without hand-writing
			// the config.
			{
				key: "topN",
				label: "Keep only the top",
				kind: "number",
				min: 1,
				max: 500,
				help: "Ranks by the measure below and asks the warehouse for that many rows. Left empty it asks for everything and draws it, which for a few thousand categories is a chart nobody can read and a query nobody needed.",
			},
			{
				key: "topBy",
				label: "Ranked by",
				kind: "field",
				scope: "measure",
				help: "Defaults to the first measure.",
			},
		],
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
			color: true,
			fill: true,
			secondAxis: true,
			axes: true,
			legend: true,
			tooltip: true,
			referenceLines: true,
		},
		options: [
			{
				key: "zoomSlider",
				label: "Let readers zoom the axis",
				kind: "toggle",
				fallback: false,
				help: "Adds a slider under the plot and lets the wheel narrow it. For a series long enough that the whole of it does not read at once.",
			},
			{
				key: "nulls",
				label: "Where data is missing",
				kind: "select",
				choices: [
					{ value: "gap", label: "Leave a gap" },
					{ value: "connect", label: "Join across it" },
				],
				fallback: "gap",
				help: "Joining across a gap draws a line through data nobody has, which reads as a trend that was never measured.",
			},
		],
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
			color: true,
			fill: true,
			stacking: true,
			axes: true,
			legend: true,
			tooltip: true,
			referenceLines: true,
		},
		options: [
			{
				key: "zoomSlider",
				label: "Let readers zoom the axis",
				kind: "toggle",
				fallback: false,
				help: "Adds a slider under the plot and lets the wheel narrow it. For a series long enough that the whole of it does not read at once.",
			},
			{
				key: "nulls",
				label: "Where data is missing",
				kind: "select",
				choices: [
					{ value: "gap", label: "Leave a gap" },
					{ value: "connect", label: "Join across it" },
				],
				fallback: "gap",
			},
		],
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "smallMultiples",
		label: "Small multiples",
		category: "trend",
		guidance:
			"One small chart per category, all on the same scale. Twelve regions read at a glance here and are unreadable overlaid on a single line chart. The shared scale is the point: shape and level are both comparable.",
		encoding: {
			dimensions: {
				min: 2,
				max: 2,
				label: "A panel each, then along the bottom of each",
			},
			measures: { min: 1, max: 1 },
		},
		supports: { color: true, tooltip: false },
		options: [
			{
				key: "columns",
				label: "Panels across",
				kind: "number",
				fallback: 3,
				min: 1,
				max: 6,
				step: 1,
			},
		],
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
		supports: {
			color: true,
			axes: true,
			tooltip: true,
			referenceLines: true,
		},
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
		options: [
			{
				key: "groupTail",
				label: "Slices to keep",
				kind: "number",
				min: 2,
				max: 50,
				help: "Keeps the largest slices and gathers the rest into one named Other. Left empty every value gets a slice, which past a dozen is a colour key with a circle attached.",
			},
			{
				key: "sliceLabels",
				label: "Slice labels",
				kind: "select",
				choices: [
					{ value: "percent", label: "Percentage" },
					{ value: "value", label: "Value" },
					{ value: "both", label: "Value and percentage" },
					{ value: "none", label: "None" },
				],
				fallback: "percent",
				help: "A pie is read as a share, so the share is the default. Labels are dropped past a dozen slices whatever this says, because they stop fitting.",
			},
		],
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
		options: [
			{
				key: "groupTail",
				label: "Slices to keep",
				kind: "number",
				min: 2,
				max: 50,
				help: "Keeps the largest slices and gathers the rest into one named Other. Left empty every value gets a slice, which past a dozen is a colour key with a circle attached.",
			},
			{
				key: "sliceLabels",
				label: "Slice labels",
				kind: "select",
				choices: [
					{ value: "percent", label: "Percentage" },
					{ value: "value", label: "Value" },
					{ value: "both", label: "Value and percentage" },
					{ value: "none", label: "None" },
				],
				fallback: "percent",
			},
		],
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
		options: [
			{
				key: "topN",
				label: "Keep only the top",
				kind: "number",
				min: 1,
				max: 500,
				help: "Ranks by the measure below and asks the warehouse for that many rows. Left empty it asks for everything and draws it, which for a few thousand categories is a chart nobody can read and a query nobody needed.",
			},
			{
				key: "topBy",
				label: "Ranked by",
				kind: "field",
				scope: "measure",
				help: "Defaults to the first measure.",
			},
		],
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
		options: [
			{
				key: "topN",
				label: "Keep only the top",
				kind: "number",
				min: 1,
				max: 500,
				help: "Ranks by the measure below and asks the warehouse for that many rows. Left empty it asks for everything and draws it, which for a few thousand categories is a chart nobody can read and a query nobody needed.",
			},
			{
				key: "topBy",
				label: "Ranked by",
				kind: "field",
				scope: "measure",
				help: "Defaults to the first measure.",
			},
		],
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
		type: "timelineChart",
		label: "Timeline",
		category: "trend",
		guidance:
			"A bar spanning a start and an end, one row per thing. For anything with a lifecycle: campaigns, contracts, projects, outages. A row missing either date is left off rather than drawn open ended.",
		encoding: {
			dimensions: {
				min: 3,
				max: 3,
				label: "What it is, then the start, then the end",
			},
			measures: { min: 0, max: 1, label: "Shown in the tooltip" },
		},
		supports: { color: true, axes: true, tooltip: true },
		defaultLayout: { w: 8, h: 5 },
	},
	{
		type: "calendarChart",
		label: "Calendar heatmap",
		category: "distribution",
		guidance:
			"A year of daily figures laid out as a calendar. The clearest answer to when something is busy: weekday patterns, month ends and holidays all show without anybody modelling them.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "A date, one cell each" },
			measures: { min: 1, max: 1 },
		},
		supports: { colorScale: true, tooltip: true },
		defaultLayout: { w: 12, h: 4 },
	},
	{
		type: "choroplethChart",
		label: "Map",
		category: "distribution",
		guidance:
			"A figure by country, coloured on a world map. The dimension has to hold country names or two letter codes; anything it cannot place is named under the map rather than quietly left off.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "A country each" },
			measures: { min: 1, max: 1 },
		},
		supports: { colorScale: true, tooltip: true },
		defaultLayout: { w: 8, h: 6 },
	},
	{
		type: "sankeyChart",
		label: "Flow",
		category: "composition",
		guidance:
			"How much moves from each thing on the left to each thing on the right: channel to region, status to next status. The funnel covers a fixed sequence, this covers a branching one.",
		encoding: {
			dimensions: { min: 2, max: 2, label: "From, then to" },
			measures: { min: 1, max: 1, label: "How much flows" },
		},
		supports: { color: true, tooltip: true },
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "histogramChart",
		label: "Histogram",
		category: "distribution",
		guidance:
			"How a figure is spread across the things it is measured on, such as order value across customers. An average hides a long tail or two clusters, and this is what shows either.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "Measured across" },
			measures: { min: 1, max: 1, label: "The figure being spread" },
		},
		supports: { color: true, axes: true, tooltip: true },
		options: [
			{
				key: "bins",
				label: "Number of bars",
				kind: "number",
				min: 2,
				max: 50,
				step: 1,
				help: "Left empty this is chosen from how many things there are, which keeps the same chart from redrawing with a different number of bars every time the page is filtered.",
			},
		],
		defaultLayout: { w: 5, h: 5 },
	},
	{
		type: "boxPlot",
		label: "Box plot",
		category: "distribution",
		guidance:
			"The middle half of a figure, its median and its outliers, one box per category. Two dimensions draws a box for each value of the first; one draws a single box.",
		encoding: {
			dimensions: {
				min: 1,
				max: 2,
				label: "A box each, then what it is spread across",
			},
			measures: { min: 1, max: 1 },
		},
		supports: { color: true, axes: true, tooltip: true },
		defaultLayout: { w: 5, h: 5 },
	},
	{
		type: "paretoChart",
		label: "Pareto",
		category: "comparison",
		guidance:
			"Ranked bars with the running share drawn over them. Answers which few categories account for most of the total, and shows where the rest stops being worth chasing.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "Ranked by" },
			measures: { min: 1, max: 1 },
		},
		supports: { color: true, axes: true, legend: true, tooltip: true },
		options: [
			{
				key: "cutoff",
				label: "Line drawn at",
				kind: "number",
				fallback: 80,
				min: 1,
				max: 100,
				step: 1,
				help: "Where the running share crosses this is the set worth acting on. Eighty is the convention and is rarely worth changing.",
			},
			{
				key: "topN",
				label: "Keep only the top",
				kind: "number",
				min: 1,
				max: 500,
				step: 1,
				help: "A long tail is the point of a Pareto, so leave this empty unless the tail is thousands of rows rather than dozens.",
			},
		],
		defaultLayout: { w: 6, h: 5 },
	},
	{
		type: "slopeChart",
		label: "Slope chart",
		category: "comparison",
		guidance:
			"Every category's before and after, joined by a line. The clearest way to show a set of changes at once, and far easier to read than paired bars. Needs a date range on the page to compare against.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "One line each" },
			measures: { min: 1, max: 1 },
		},
		supports: { axes: true, tooltip: true },
		options: [
			{
				key: "compareTo",
				label: "Compare against",
				kind: "select",
				choices: [
					{ value: "", label: "Nothing" },
					{ value: "year", label: "The same window a year earlier" },
					{
						value: "quarter",
						label: "The same window a quarter earlier",
					},
					{
						value: "month",
						label: "The same window a month earlier",
					},
					{ value: "previous", label: "The period before" },
				],
				fallback: "",
				help: "Asks the same question again with the page's date window moved back, so whatever the reader has filtered to is what gets compared.",
			},
			{
				key: "compareField",
				label: "Date the window sits on",
				kind: "field",
				scope: "dimension",
				from: "source",
				role: "temporal",
				help: "Which date the page's range filter applies to. The comparison needs a range on the page to move.",
			},
		],
		defaultLayout: { w: 5, h: 5 },
	},
	{
		type: "scatterChart",
		label: "Scatter plot",
		category: "relationship",
		guidance:
			"Whether two measures move together. The first is across, the second is up, and a third sizes each point.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "Names each point" },
			measures: {
				min: 1,
				max: 3,
				label: "Across, then up, then an optional size",
			},
		},
		supports: {
			color: true,
			axes: true,
			legend: true,
			tooltip: true,
			referenceLines: true,
		},
		options: [
			{
				key: "zoomSlider",
				label: "Let readers zoom the axis",
				kind: "toggle",
				fallback: false,
				help: "Adds a slider under the plot and lets the wheel narrow it. For a series long enough that the whole of it does not read at once.",
			},
		],
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
			conditionalFormat: true,
			colorScale: true,
			tooltip: true,
			fillHeight: true,
		},
		options: [
			{
				key: "fillHeight",
				label: "Grow to fill the screen",
				kind: "toggle",
				fallback: true,
				help: "On, this takes the room left below it when it is the last thing on the page. Turn it off where the table is deliberately a preview rather than the thing being worked in.",
			},
			{
				key: "density",
				label: "Row height",
				kind: "select",
				choices: [
					{ value: "comfortable", label: "Comfortable" },
					{ value: "compact", label: "Compact" },
				],
				fallback: "comfortable",
				help: "Compact fits about a third more rows on a screen. Worth it for short codes and dates, not for long names.",
			},
			{
				key: "compareTo",
				label: "Compare against",
				kind: "select",
				choices: [
					{ value: "", label: "Nothing" },
					{ value: "year", label: "The same window a year earlier" },
					{
						value: "quarter",
						label: "The same window a quarter earlier",
					},
					{
						value: "month",
						label: "The same window a month earlier",
					},
					{ value: "previous", label: "The period before" },
				],
				fallback: "",
				help: "Puts the change since then under each figure. Compares the first page, which is what a reader is looking at.",
			},
			{
				key: "compareField",
				label: "Date the window sits on",
				kind: "field",
				scope: "dimension",
				from: "source",
				role: "temporal",
				help: "Which date the page's range filter applies to. The comparison needs a range on the page to move.",
			},
			{
				key: "showTotals",
				label: "Total row",
				kind: "toggle",
				fallback: false,
				help: "A row pinned to the foot holding the total of every measure across the whole result, not only the rows loaded so far. Asked as its own query, so it is right for a table of two million rows showing the first two hundred.",
			},
		],
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
			conditionalFormat: true,
			colorScale: true,
			tooltip: true,
			fillHeight: true,
		},
		options: [
			{
				key: "fillHeight",
				label: "Grow to fill the screen",
				kind: "toggle",
				fallback: true,
				help: "On, this takes the room left below it when it is the last thing on the page. Turn it off where the table is deliberately a preview rather than the thing being worked in.",
			},
			{
				key: "columnDimension",
				label: "Pivot across",
				kind: "field",
				scope: "dimension",
				help: "Turns the row hierarchy into a cross-tab: this field becomes the columns and the measures are spread across them.",
			},
		],
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
		options: [],
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
		options: [],
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
		options: [],
		defaultLayout: { w: 12, h: 1 },
	},
	{
		type: "thresholdControl",
		label: "Threshold",
		category: "filter",
		guidance:
			'Keeps rows where a measure clears a cutoff the reader sets. For "orders above" and "anything under" questions.',
		encoding: {
			dimensions: { min: 0, max: 1 },
			measures: { min: 1, max: 1, label: "Measure to test" },
		},
		supports: {},
		options: [
			{
				key: "direction",
				label: "Keeps rows",
				kind: "select",
				choices: [
					{ value: "above", label: "Above the cutoff" },
					{ value: "below", label: "Below the cutoff" },
				],
				fallback: "above",
			},
			{
				key: "defaultValue",
				label: "Starting cutoff",
				kind: "number",
				help: "Where the control sits when the page opens. Left empty it starts unset and filters nothing.",
			},
		],
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
		options: [
			{
				key: "match",
				label: "Chosen values are",
				kind: "select",
				choices: [
					{ value: "include", label: "Kept" },
					{ value: "exclude", label: "Dropped" },
				],
				fallback: "include",
				help: 'Dropping is the shorter way to say "everything except these two" on a field with forty values, and it stays right as values are added: a new one is kept, where an include list would silently leave it out.',
			},
			{
				key: "presentation",
				label: "Shown as",
				kind: "select",
				choices: [
					{ value: "dropdown", label: "Dropdown" },
					{ value: "segmented", label: "Buttons" },
				],
				fallback: "dropdown",
				help: "Buttons suit a field with a handful of values, where opening a list to see two options is more work than reading them.",
			},
			{
				key: "multiple",
				label: "Allow several values",
				kind: "toggle",
				fallback: true,
				help: "Off makes it a single choice, which suits a field where two values together mean nothing.",
			},
			{
				key: "defaultValues",
				label: "Selected on open",
				kind: "text",
				placeholder: "North, South",
				help: "Comma separated. A page that opens already narrowed asks the warehouse for less.",
			},
		],
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
		options: [
			{
				key: "placeholder",
				label: "Placeholder",
				kind: "text",
				placeholder: "Search orders",
			},
		],
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
		options: [],
		defaultLayout: { w: 3, h: 2 },
	},
	{
		type: "dateRangeFilter",
		label: "Date range",
		category: "filter",
		guidance: "Restrict to a period, with the usual relative presets.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "Date field" },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		options: [
			{
				key: "rangeMode",
				label: "Presentation",
				kind: "select",
				choices: [
					{ value: "combined", label: "Presets and calendar" },
					{ value: "presets", label: "Presets only" },
					{ value: "calendar", label: "Calendar only" },
					{ value: "slider", label: "Timeline slider" },
				],
				fallback: "combined",
				help: "The slider reads the real extent of the column, so it spans the dates that exist rather than an assumed range.",
			},
			{
				key: "defaultPreset",
				label: "Applied on open",
				kind: "select",
				choices: [
					{ value: "", label: "Everything" },
					{ value: "7d", label: "Last 7 days" },
					{ value: "30d", label: "Last 30 days" },
					{ value: "90d", label: "Last 90 days" },
					{ value: "12m", label: "Last 12 months" },
					{ value: "MTD", label: "Month to date" },
					{ value: "QTD", label: "Quarter to date" },
					{ value: "YTD", label: "Year to date" },
				],
				fallback: "",
				help: "A page that opens on everything runs its widest query every time somebody arrives. A default is usually both faster and closer to what the reader wanted.",
			},
		],
		defaultLayout: { w: 4, h: 1 },
	},
	{
		type: "numericRangeFilter",
		label: "Numeric range",
		category: "filter",
		guidance: "Restrict a measure or numeric dimension to a band.",
		encoding: {
			dimensions: { min: 1, max: 1 },
			measures: { min: 0, max: 1 },
		},
		supports: {},
		options: [
			{
				key: "rangeMode",
				label: "Presentation",
				kind: "select",
				choices: [
					{ value: "combined", label: "Slider and boxes" },
					{ value: "slider", label: "Slider only" },
					{ value: "inputs", label: "Boxes only" },
				],
				fallback: "combined",
			},
		],
		defaultLayout: { w: 3, h: 1 },
	},

	{
		type: "toggleFilter",
		label: "Flag toggle",
		category: "filter",
		guidance:
			"One condition, on or off. For a field a reader thinks of as yes or no: open orders, active contracts, anything flagged.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "Field to test" },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		options: [
			{
				key: "onValue",
				label: "Value that means yes",
				kind: "text",
				fallback: "true",
				placeholder: "true",
				help: "A flag is spelled differently in every warehouse: true, Y, 1, Active. This is the one that turns the filter on.",
			},
			{
				key: "defaultOn",
				label: "On when the page opens",
				kind: "toggle",
				fallback: false,
				help: "A page whose whole subject is open orders should open on open orders, and ask the warehouse for less while it does.",
			},
		],
		defaultLayout: { w: 3, h: 1 },
	},
	{
		type: "presenceFilter",
		label: "Blank filter",
		category: "filter",
		guidance:
			"Whether a field has anything in it. For finding the rows nobody filled in, which a value list can never offer because a missing value is not one of the values.",
		encoding: {
			dimensions: { min: 1, max: 1, label: "Field to test" },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		options: [],
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
		type: "sectionHeader",
		label: "Section heading",
		category: "text",
		guidance:
			"Breaks a long page into parts. A heading and a rule, with nothing behind it: use it where a reader would otherwise have to work out where one subject ends and the next begins.",
		encoding: {
			dimensions: { min: 0, max: 0 },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		options: [
			{
				key: "level",
				label: "Weight",
				kind: "select",
				choices: [
					{ value: "major", label: "Major" },
					{ value: "minor", label: "Minor" },
				],
				fallback: "major",
			},
			{
				key: "rule",
				label: "Draw a rule under it",
				kind: "toggle",
				fallback: true,
			},
		],
		defaultLayout: { w: 12, h: 1 },
	},
	// --- Layout ------------------------------------------------------------
	{
		type: "group",
		label: "Group",
		category: "layout",
		guidance:
			"Holds other visuals. Drag anything onto it to put it inside, and the group carries them: move it and they move, and it can open from a button instead of sitting on the page.",
		encoding: {
			dimensions: { min: 0, max: 0 },
			measures: { min: 0, max: 0 },
		},
		supports: {},
		options: [
			{
				key: "presentation",
				label: "Shown as",
				kind: "select",
				choices: [
					{ value: "frame", label: "A box on the page" },
					{ value: "popup", label: "A button that opens" },
				],
				fallback: "frame",
				help: "A button suits a set of controls a reader changes now and then. Ten toggles laid out on the page is ten things to read past; behind a button it is one, and the button says how many are set.",
			},
			{
				key: "openLabel",
				label: "Button label",
				kind: "text",
				placeholder: "Uses the title",
				help: "Only used when it opens from a button.",
			},
			{
				key: "frame",
				label: "Draw a border",
				kind: "toggle",
				fallback: true,
				help: "Off makes it an invisible container, for grouping things that move together without a box around them.",
			},
		],
		defaultLayout: { w: 6, h: 6 },
	},
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
	return (
		isFilterVisual(type) ||
		type === "dimensionSwitch" ||
		type === "periodSwitch"
	);
}

// The order the picker groups its cards in.
//
// Kept here rather than in the picker because it is a fact about the
// categories, and because the picker's own copy silently omitted whichever one
// was added last: a category missing from that list is a category nothing can
// be added from, and nothing said so. The check below makes it a compile
// error instead.
export const categoryOrder = [
	"summary",
	"comparison",
	"trend",
	"composition",
	"distribution",
	"relationship",
	"detail",
	"filter",
	"layout",
	"text",
] as const satisfies readonly VisualCategory[];

type MissingCategory = Exclude<VisualCategory, (typeof categoryOrder)[number]>;
// Reads "every category is in the list above". Adding one to VisualCategory
// without adding it here makes this line fail to compile.
const _everyCategoryIsOrdered: MissingCategory extends never ? true : never =
	true;
void _everyCategoryIsOrdered;

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
	layout: "Layout",
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
