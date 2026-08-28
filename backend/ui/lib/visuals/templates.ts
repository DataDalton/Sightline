import { visualByType } from "./catalog";

// Arrangements a page can start from.
//
// A new page used to be an empty grid, which is the point at which most of the
// authoring effort happens: choosing a visual type, sizing it, choosing a second
// one that agrees with the first, and getting the encoding right for each. Most
// pages are one of a handful of shapes, and every author rebuilds those shapes
// by hand.
//
// A template declares the shape once, with slots where the field names go. It
// says "this needs a date and a figure" rather than naming a column, so the same
// template fits any source that has both. Filling two slots produces a laid-out
// page with the options already set.
//
// Pure, so the choices can be tested and so the server can build a page from one
// without a browser. report_pages.template records which was used, which has
// been a column with nothing writing to it since the schema shipped.

export interface TemplateSlot {
	key: string;
	label: string;
	scope: "dimension" | "measure";
	// Narrows what is offered. A trend wants a date on its axis, and offering
	// every dimension for that slot is how a page ends up grouped by Product
	// Number with a line drawn between the points.
	role?: "temporal";
	// A visual whose required slot is empty is left out rather than added
	// broken. An optional slot that is empty simply narrows the page.
	required: boolean;
	help?: string;
}

// A visual in a template, with slot references where field names go.
export interface TemplateVisual {
	type: string;
	title?: string;
	// Written as {slotKey}. A reference to an unfilled slot drops the name, and
	// dropping a required one drops the visual.
	dimensions?: string[];
	measures?: string[];
	options?: Record<string, unknown>;
	layout: { x: number; y: number; w: number; h: number };
}

export interface PageTemplate {
	key: string;
	label: string;
	blurb: string;
	slots: TemplateSlot[];
	visuals: TemplateVisual[];
}

// The grid is twelve columns wide. Heights are in the same units the catalogue
// uses for its default footprints, so a template and a hand-placed visual sit on
// the same scale.
export const pageTemplates: PageTemplate[] = [
	{
		key: "trend",
		label: "Trend over time",
		blurb: "How a figure has moved, with the totals above it and the numbers underneath.",
		slots: [
			{
				key: "date",
				label: "Date",
				scope: "dimension",
				role: "temporal",
				required: true,
				help: "What the line is drawn against.",
			},
			{
				key: "measure",
				label: "Figure",
				scope: "measure",
				required: true,
				help: "What is being tracked.",
			},
			{
				key: "split",
				label: "Split by",
				scope: "dimension",
				required: false,
				help: "Optional. Draws one line per value instead of one line in total.",
			},
		],
		visuals: [
			{
				type: "dateRangeFilter",
				dimensions: ["{date}"],
				layout: { x: 0, y: 0, w: 4, h: 1 },
			},
			{
				type: "kpiRow",
				measures: ["{measure}"],
				layout: { x: 0, y: 1, w: 12, h: 2 },
			},
			{
				type: "lineChart",
				title: "Over time",
				dimensions: ["{date}", "{split}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 3, w: 12, h: 5 },
			},
			{
				type: "table",
				title: "The numbers",
				dimensions: ["{date}", "{split}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 8, w: 12, h: 6 },
			},
		],
	},

	{
		key: "breakdown",
		label: "Breakdown",
		blurb: "Where a figure comes from, ranked, with the long tail kept off the chart.",
		slots: [
			{
				key: "by",
				label: "Broken down by",
				scope: "dimension",
				required: true,
				help: "One bar per value of this.",
			},
			{
				key: "measure",
				label: "Figure",
				scope: "measure",
				required: true,
			},
		],
		visuals: [
			{
				type: "dropdownFilter",
				dimensions: ["{by}"],
				layout: { x: 0, y: 0, w: 4, h: 1 },
			},
			{
				type: "kpiRow",
				measures: ["{measure}"],
				layout: { x: 0, y: 1, w: 12, h: 2 },
			},
			{
				type: "horizontalBarChart",
				title: "Ranked",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				// Twenty bars is a chart somebody can read. Applied to the
				// query rather than to the marks, so the long tail is not
				// fetched and then thrown away.
				options: { topN: 20 },
				layout: { x: 0, y: 3, w: 7, h: 6 },
			},
			{
				type: "donutChart",
				title: "Share",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				options: { topN: 8 },
				layout: { x: 7, y: 3, w: 5, h: 6 },
			},
			{
				type: "table",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 9, w: 12, h: 6 },
			},
		],
	},

	{
		key: "comparison",
		label: "Cross-tab",
		blurb: "One figure across two dimensions at once, as a table you can expand.",
		slots: [
			{
				key: "rows",
				label: "Down the side",
				scope: "dimension",
				required: true,
			},
			{
				key: "columns",
				label: "Across the top",
				scope: "dimension",
				required: true,
			},
			{
				key: "measure",
				label: "Figure",
				scope: "measure",
				required: true,
			},
		],
		visuals: [
			{
				type: "kpiRow",
				measures: ["{measure}"],
				layout: { x: 0, y: 0, w: 12, h: 2 },
			},
			{
				type: "matrixTable",
				dimensions: ["{rows}", "{columns}"],
				measures: ["{measure}"],
				options: { columnDimension: "{columns}" },
				layout: { x: 0, y: 2, w: 12, h: 10 },
			},
		],
	},

	{
		key: "detail",
		label: "Detail table",
		blurb: "The rows themselves, with the filters to narrow them.",
		slots: [
			{
				key: "primary",
				label: "Main column",
				scope: "dimension",
				required: true,
			},
			{
				key: "filter",
				label: "Filter on",
				scope: "dimension",
				required: false,
				help: "Optional. Adds a dropdown above the table.",
			},
			{
				key: "measure",
				label: "Figure",
				scope: "measure",
				required: true,
			},
		],
		visuals: [
			{
				type: "dropdownFilter",
				dimensions: ["{filter}"],
				layout: { x: 0, y: 0, w: 4, h: 1 },
			},
			{
				type: "table",
				dimensions: ["{primary}", "{filter}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 1, w: 12, h: 12 },
			},
		],
	},

	{
		key: "overview",
		label: "Overview",
		blurb: "The totals, the trend and the breakdown on one page.",
		slots: [
			{
				key: "date",
				label: "Date",
				scope: "dimension",
				role: "temporal",
				required: true,
			},
			{
				key: "by",
				label: "Broken down by",
				scope: "dimension",
				required: true,
			},
			{
				key: "measure",
				label: "Figure",
				scope: "measure",
				required: true,
			},
			{
				key: "second",
				label: "Second figure",
				scope: "measure",
				required: false,
				help: "Optional. Sits beside the first in the totals.",
			},
		],
		visuals: [
			{
				type: "dateRangeFilter",
				dimensions: ["{date}"],
				layout: { x: 0, y: 0, w: 4, h: 1 },
			},
			{
				type: "kpiRow",
				measures: ["{measure}", "{second}"],
				layout: { x: 0, y: 1, w: 12, h: 2 },
			},
			{
				type: "lineChart",
				title: "Over time",
				dimensions: ["{date}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 3, w: 7, h: 5 },
			},
			{
				type: "horizontalBarChart",
				title: "Ranked",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				options: { topN: 10 },
				layout: { x: 7, y: 3, w: 5, h: 5 },
			},
		],
	},

	{
		key: "target",
		label: "Against target",
		blurb: "Whether each part of the business is on plan, worst first, with the gap spelled out underneath.",
		slots: [
			{
				key: "by",
				label: "One row each",
				scope: "dimension",
				required: true,
				help: "What is being held to the target: a region, a team, a product line.",
			},
			{
				key: "actual",
				label: "What happened",
				scope: "measure",
				required: true,
			},
			{
				key: "target",
				label: "What was aimed for",
				scope: "measure",
				required: true,
				help: "The plan, the budget or the quota, as a measure the source already carries.",
			},
		],
		visuals: [
			{
				type: "kpiRow",
				measures: ["{actual}", "{target}"],
				layout: { x: 0, y: 0, w: 12, h: 2 },
			},
			{
				type: "bulletChart",
				title: "Against target",
				dimensions: ["{by}"],
				measures: ["{actual}", "{target}"],
				options: { sortBy: "valueAsc", colourByTarget: true },
				layout: { x: 0, y: 2, w: 12, h: 5 },
			},
			{
				type: "table",
				title: "The numbers",
				dimensions: ["{by}"],
				measures: ["{actual}", "{target}"],
				options: { showTotals: true },
				layout: { x: 0, y: 7, w: 12, h: 5 },
			},
		],
	},

	{
		key: "comparison-period",
		label: "This period against last",
		blurb: "Every figure with its change since the same window a year ago, and the movers picked out.",
		slots: [
			{
				key: "date",
				label: "Date",
				scope: "dimension",
				role: "temporal",
				required: true,
				help: "The date the range filter applies to. The comparison moves this window back.",
			},
			{
				key: "by",
				label: "Compared across",
				scope: "dimension",
				required: true,
			},
			{
				key: "measure",
				label: "Figure",
				scope: "measure",
				required: true,
			},
		],
		visuals: [
			{
				type: "dateRangeFilter",
				dimensions: ["{date}"],
				options: { defaultPreset: "12m" },
				layout: { x: 0, y: 0, w: 4, h: 1 },
			},
			{
				type: "kpiRow",
				measures: ["{measure}"],
				options: {
					compareTo: "year",
					compareField: "{date}",
					sparkline: "{date}",
				},
				layout: { x: 0, y: 1, w: 12, h: 2 },
			},
			{
				type: "slopeChart",
				title: "What moved",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				options: { compareTo: "year", compareField: "{date}" },
				layout: { x: 0, y: 3, w: 5, h: 6 },
			},
			{
				type: "table",
				title: "The numbers, with the change",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				options: {
					compareTo: "year",
					compareField: "{date}",
					showTotals: true,
				},
				layout: { x: 5, y: 3, w: 7, h: 6 },
			},
		],
	},

	{
		key: "ranking",
		label: "The vital few",
		blurb: "Which categories account for most of the total, and where the rest stops being worth chasing.",
		slots: [
			{
				key: "by",
				label: "Ranked",
				scope: "dimension",
				required: true,
			},
			{
				key: "measure",
				label: "Figure",
				scope: "measure",
				required: true,
			},
		],
		visuals: [
			{
				type: "kpiRow",
				measures: ["{measure}"],
				layout: { x: 0, y: 0, w: 12, h: 2 },
			},
			{
				type: "paretoChart",
				title: "Where it comes from",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				options: { cutoff: 80 },
				layout: { x: 0, y: 2, w: 7, h: 6 },
			},
			{
				type: "horizontalBarChart",
				title: "Top twenty",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				options: { topN: 20, sortBy: "valueDesc", valueLabels: true },
				layout: { x: 7, y: 2, w: 5, h: 6 },
			},
			{
				type: "table",
				title: "All of it",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				options: { showTotals: true },
				layout: { x: 0, y: 8, w: 12, h: 5 },
			},
		],
	},

	{
		key: "distribution",
		label: "How it is spread",
		blurb: "The shape of a figure rather than its total, which is what an average hides.",
		slots: [
			{
				key: "across",
				label: "Measured across",
				scope: "dimension",
				required: true,
				help: "The things the figure is spread over: customers, orders, products.",
			},
			{
				key: "measure",
				label: "Figure",
				scope: "measure",
				required: true,
			},
			{
				key: "group",
				label: "Split by",
				scope: "dimension",
				required: false,
				help: "Optional. Draws a box for each value so the spreads can be compared.",
			},
		],
		visuals: [
			{
				type: "kpiRow",
				measures: ["{measure}"],
				layout: { x: 0, y: 0, w: 12, h: 2 },
			},
			{
				type: "histogramChart",
				title: "The spread",
				dimensions: ["{across}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 2, w: 6, h: 5 },
			},
			{
				type: "boxPlot",
				title: "Middle half and outliers",
				dimensions: ["{group}", "{across}"],
				measures: ["{measure}"],
				layout: { x: 6, y: 2, w: 6, h: 5 },
			},
		],
	},

	{
		key: "activity",
		label: "When it happens",
		blurb: "A year of daily figures as a calendar, so weekday patterns and quiet spells are visible without anybody modelling them.",
		slots: [
			{
				key: "date",
				label: "Date",
				scope: "dimension",
				role: "temporal",
				required: true,
				help: "A daily date. A month or a quarter has too few cells to read as a calendar.",
			},
			{
				key: "measure",
				label: "Figure",
				scope: "measure",
				required: true,
			},
			{
				key: "by",
				label: "Split by",
				scope: "dimension",
				required: false,
			},
		],
		visuals: [
			{
				type: "kpiRow",
				measures: ["{measure}"],
				layout: { x: 0, y: 0, w: 12, h: 2 },
			},
			{
				type: "calendarChart",
				title: "By day",
				dimensions: ["{date}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 2, w: 12, h: 4 },
			},
			{
				type: "smallMultiples",
				title: "Each one over time",
				dimensions: ["{by}", "{date}"],
				measures: ["{measure}"],
				options: { columns: 3 },
				layout: { x: 0, y: 6, w: 12, h: 5 },
			},
		],
	},

	{
		key: "exception",
		label: "Exceptions",
		blurb: "Only the rows that clear a cutoff the reader sets, with the total of what is left.",
		slots: [
			{
				key: "by",
				label: "One row each",
				scope: "dimension",
				required: true,
			},
			{
				key: "measure",
				label: "Tested against the cutoff",
				scope: "measure",
				required: true,
			},
			{
				key: "detail",
				label: "Also shown",
				scope: "measure",
				required: false,
			},
		],
		visuals: [
			{
				type: "thresholdControl",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				options: { direction: "above" },
				layout: { x: 0, y: 0, w: 3, h: 1 },
			},
			{
				type: "kpiRow",
				measures: ["{measure}", "{detail}"],
				layout: { x: 3, y: 0, w: 9, h: 2 },
			},
			{
				type: "horizontalBarChart",
				title: "What cleared it",
				dimensions: ["{by}"],
				measures: ["{measure}"],
				options: { sortBy: "valueDesc", valueLabels: true, topN: 25 },
				layout: { x: 0, y: 2, w: 6, h: 6 },
			},
			{
				type: "table",
				title: "The rows",
				dimensions: ["{by}"],
				measures: ["{measure}", "{detail}"],
				options: { showTotals: true },
				layout: { x: 6, y: 2, w: 6, h: 6 },
			},
		],
	},

	{
		key: "flow",
		label: "Flow between two things",
		blurb: "How much moves from each thing on the left to each thing on the right.",
		slots: [
			{
				key: "from",
				label: "From",
				scope: "dimension",
				required: true,
			},
			{
				key: "to",
				label: "To",
				scope: "dimension",
				required: true,
			},
			{
				key: "measure",
				label: "How much flows",
				scope: "measure",
				required: true,
			},
		],
		visuals: [
			{
				type: "kpiRow",
				measures: ["{measure}"],
				layout: { x: 0, y: 0, w: 12, h: 2 },
			},
			{
				type: "sankeyChart",
				title: "Where it goes",
				dimensions: ["{from}", "{to}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 2, w: 7, h: 6 },
			},
			{
				type: "matrixTable",
				title: "Crossed over",
				dimensions: ["{from}", "{to}"],
				measures: ["{measure}"],
				options: { columnDimension: true },
				layout: { x: 7, y: 2, w: 5, h: 6 },
			},
		],
	},

	{
		key: "relationship",
		label: "Whether two figures move together",
		blurb: "One point per thing, with a third figure sizing it. For finding what is unusual rather than what is large.",
		slots: [
			{
				key: "by",
				label: "One point each",
				scope: "dimension",
				required: true,
			},
			{
				key: "across",
				label: "Across the bottom",
				scope: "measure",
				required: true,
			},
			{
				key: "up",
				label: "Up the side",
				scope: "measure",
				required: true,
			},
			{
				key: "size",
				label: "Point size",
				scope: "measure",
				required: false,
			},
		],
		visuals: [
			{
				type: "scatterChart",
				title: "Against each other",
				dimensions: ["{by}"],
				measures: ["{across}", "{up}", "{size}"],
				layout: { x: 0, y: 0, w: 7, h: 6 },
			},
			{
				type: "table",
				title: "The numbers",
				dimensions: ["{by}"],
				measures: ["{across}", "{up}", "{size}"],
				options: { showTotals: true },
				layout: { x: 7, y: 0, w: 5, h: 6 },
			},
		],
	},

	{
		key: "profile",
		label: "One record",
		blurb: "Everything about a single thing, found by searching for it. Uses the header and detail panels that a page about one customer needs and a table cannot give.",
		slots: [
			{
				key: "identifier",
				label: "Found by",
				scope: "dimension",
				required: true,
				help: "What the reader searches for: an account number, a name, an order reference.",
			},
			{
				key: "measure",
				label: "Headline figure",
				scope: "measure",
				required: true,
			},
			{
				key: "detail",
				label: "Also shown",
				scope: "dimension",
				required: false,
			},
		],
		visuals: [
			{
				type: "searchFilter",
				dimensions: ["{identifier}"],
				options: { placeholder: "Search" },
				layout: { x: 0, y: 0, w: 4, h: 1 },
			},
			{
				type: "entityHeader",
				dimensions: ["{identifier}", "{detail}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 1, w: 12, h: 2 },
			},
			{
				type: "definitionList",
				title: "Details",
				dimensions: ["{identifier}", "{detail}"],
				measures: ["{measure}"],
				layout: { x: 0, y: 3, w: 5, h: 5 },
			},
			{
				type: "table",
				title: "Everything",
				dimensions: ["{identifier}", "{detail}"],
				measures: ["{measure}"],
				layout: { x: 5, y: 3, w: 7, h: 5 },
			},
		],
	},
];

export const templateByKey: Record<string, PageTemplate> = Object.fromEntries(
	pageTemplates.map((t) => [t.key, t]),
);

// --- Filling the slots ------------------------------------------------------

// A field, as much of it as choosing needs.
export interface CandidateField {
	name: string;
	displayName?: string | null;
	formatHint?: string | null;
	dataType?: string | null;
}

export interface CandidateSource {
	dimensions: CandidateField[];
	measures: CandidateField[];
	defaultTimeField?: string | null;
}

function looksTemporal(field: CandidateField): boolean {
	if (field.formatHint === "date") return true;
	const type = (field.dataType ?? "").toLowerCase();
	return type.includes("date") || type.includes("timestamp");
}

// Which fields can fill a slot, best first.
//
// A temporal slot offers only the fields that are dates, with the source's own
// default time field at the top. Offering everything and hoping the author picks
// a date is how a line chart ends up drawn against Product Number.
export function slotCandidates(
	slot: TemplateSlot,
	source: CandidateSource,
): CandidateField[] {
	const pool = slot.scope === "measure" ? source.measures : source.dimensions;

	if (slot.role !== "temporal") return pool;

	const temporal = pool.filter(looksTemporal);
	const preferred = source.defaultTimeField;
	if (!preferred) return temporal;

	return [
		...temporal.filter((f) => f.name === preferred),
		...temporal.filter((f) => f.name !== preferred),
	];
}

// What a template suggests before the author touches anything.
//
// Only the required slots, and only where the choice is not a guess. A temporal
// slot has a defensible default because a source names its own time field; a
// "broken down by" slot does not, and picking the first dimension in the list
// would be arbitrary in a way that reads as considered.
export function suggestedSlots(
	template: PageTemplate,
	source: CandidateSource,
): Record<string, string> {
	const filled: Record<string, string> = {};

	for (const slot of template.slots) {
		if (slot.role === "temporal") {
			const candidate = slotCandidates(slot, source)[0];
			if (candidate) filled[slot.key] = candidate.name;
			continue;
		}
		// One measure and nothing to choose between.
		if (slot.scope === "measure" && source.measures.length === 1) {
			filled[slot.key] = source.measures[0].name;
		}
	}

	return filled;
}

const slotPattern = /^\{(.+)\}$/;

function resolveNames(
	names: string[] | undefined,
	filled: Record<string, string>,
): { resolved: string[]; missingRequired: string[] } {
	const resolved: string[] = [];
	const missing: string[] = [];

	for (const name of names ?? []) {
		const match = slotPattern.exec(name);
		if (!match) {
			// A literal field name, which a template may carry where the field
			// is not the author's choice.
			resolved.push(name);
			continue;
		}
		const value = filled[match[1]];
		if (value) resolved.push(value);
		else missing.push(match[1]);
	}

	return { resolved, missingRequired: missing };
}

export interface BuiltVisual {
	visualType: string;
	title: string | null;
	dimensions: string[];
	measures: string[];
	options: Record<string, unknown>;
	// Filters the visual carries in its own right. No template sets one, but a
	// visual built from a question somebody asked does: narrowing to one region
	// and then keeping the answer has to keep the narrowing too.
	filters?: unknown[];
	layout: { x: number; y: number; w: number; h: number };
}

export interface BuiltPage {
	templateKey: string;
	visuals: BuiltVisual[];
	// Slots the template needs and the author has not filled. A page is not
	// built while any of these stand.
	unfilled: string[];
}

// Turns a template and a set of chosen fields into the visuals to store.
//
// A visual referring to an unfilled optional slot keeps the names it can resolve
// and drops the rest, so leaving "Split by" empty yields one line rather than a
// broken chart. A visual referring to an unfilled required slot is left out
// entirely, and the slot is reported.
export function buildPage(
	template: PageTemplate,
	filled: Record<string, string>,
): BuiltPage {
	const required = template.slots.filter((s) => s.required);
	const unfilled = required.filter((s) => !filled[s.key]).map((s) => s.key);

	const requiredKeys = new Set(required.map((s) => s.key));
	const visuals: BuiltVisual[] = [];

	for (const visual of template.visuals) {
		const dimensions = resolveNames(visual.dimensions, filled);
		const measures = resolveNames(visual.measures, filled);

		// A visual that lost a required slot cannot be drawn. One that lost
		// only optional slots is narrower, which is what optional means.
		const lostRequired = [
			...dimensions.missingRequired,
			...measures.missingRequired,
		].some((key) => requiredKeys.has(key));
		if (lostRequired) continue;

		// A visual with nothing left to read is not worth placing. A filter
		// widget reads nothing by design, so it is judged on its own fields.
		if (
			dimensions.resolved.length === 0 &&
			measures.resolved.length === 0
		) {
			continue;
		}

		// Option values can name a slot too, so a cross-tab pivots on the
		// column the author chose rather than on a name written here.
		const options: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(visual.options ?? {})) {
			if (typeof value === "string") {
				const match = slotPattern.exec(value);
				if (match) {
					const resolved = filled[match[1]];
					if (resolved) options[key] = resolved;
					continue;
				}
			}
			options[key] = value;
		}

		visuals.push({
			visualType: visual.type,
			title: visual.title ?? null,
			dimensions: dimensions.resolved,
			measures: measures.resolved,
			options,
			layout: visual.layout,
		});
	}

	return { templateKey: template.key, visuals, unfilled };
}

// Whether a source can fill every required slot at all.
//
// Offering a template that cannot be completed wastes the choice: the author
// picks it, works out that there is no date on this source, and starts again.
export function templateFits(
	template: PageTemplate,
	source: CandidateSource,
): boolean {
	return template.slots
		.filter((s) => s.required)
		.every((s) => slotCandidates(s, source).length > 0);
}

// Templates worth offering for a source, and every template referring only to
// visual types this build renders.
export function templatesFor(source: CandidateSource): PageTemplate[] {
	return pageTemplates.filter(
		(t) =>
			templateFits(t, source) &&
			t.visuals.every((v) => Boolean(visualByType[v.type])),
	);
}
