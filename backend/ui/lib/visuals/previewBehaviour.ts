import { visualCatalog } from "./catalog";

// What a reader does with each visual, for the preview in the picker.
//
// The picker can draw what a thing looks like. What an author actually needs to
// know is what happens when somebody uses it, and that is not visible in a
// still picture: a bar chart and a pie chart both cross-filter the page, a line
// chart is brushed rather than clicked, and a KPI row does nothing at all
// because it is the thing that reacts.
//
// Grouped by the gesture rather than one per type, because that is where the
// real difference is. Eleven charts all narrow the page when a mark is clicked,
// and drawing that eleven times would be eleven chances for them to drift.
//
// Kept out of the catalogue so the catalogue stays a description of what
// exists, and kept in lib so the mapping can be checked by a test rather than
// only by opening the picker and looking.

export type PreviewBehaviour =
	// Clicking a mark narrows everything else on the page to it.
	| "crossFilter"
	// Dragging across selects a range, and the page narrows to it. For the
	// marks that sit on a continuous axis, where one point is rarely the
	// question and a stretch of them usually is.
	| "brush"
	// Clicking opens the level underneath rather than filtering.
	| "drill"
	// Reads the page's filters rather than driving them. It is the thing that
	// changes when somebody uses something else.
	| "respond"
	// Pick values, and the rest go.
	| "narrow"
	// Keep what falls inside a range the reader moves.
	| "band"
	// One condition, on or off.
	| "split"
	// The rows with nothing in the field.
	| "blanks"
	// Repoints every visual reading the placeholder.
	| "repoint"
	// Holds other visuals.
	| "gather"
	// Says something. Nothing happens when it is clicked, which is worth
	// knowing before an author reaches for one expecting otherwise.
	| "static";

const behaviours: Record<string, PreviewBehaviour> = {
	// Clicking one mark is a sensible question for all of these: a category, a
	// slice, a stage, a cell.
	barChart: "crossFilter",
	horizontalBarChart: "crossFilter",
	comboChart: "crossFilter",
	pieChart: "crossFilter",
	donutChart: "crossFilter",
	treemapChart: "crossFilter",
	funnelChart: "crossFilter",
	stackedBarChart: "crossFilter",
	heatmapChart: "crossFilter",
	radarChart: "crossFilter",
	waterfallChart: "crossFilter",
	table: "crossFilter",

	// A continuous axis, where the question is usually a stretch rather than a
	// point.
	lineChart: "brush",
	areaChart: "brush",
	scatterChart: "brush",

	matrixTable: "drill",

	// Summaries and detail panels answer rather than ask.
	kpiRow: "respond",
	gauge: "respond",
	definitionList: "respond",
	entityHeader: "respond",

	dropdownFilter: "narrow",
	bulkFilter: "narrow",
	searchFilter: "narrow",
	filterBar: "narrow",

	numericRangeFilter: "band",
	dateRangeFilter: "band",
	thresholdControl: "band",

	toggleFilter: "split",
	presenceFilter: "blanks",

	dimensionSwitch: "repoint",
	periodSwitch: "repoint",

	group: "gather",

	textPanel: "static",
	sectionHeader: "static",
	blockedNotice: "static",
};

export function behaviourFor(type: string): PreviewBehaviour {
	// Falls back to reacting rather than driving. A type nobody has classified
	// is more likely to be something that shows a figure than something that
	// filters a page, and the test below means the fallback should never be
	// reached for anything in the catalogue.
	return behaviours[type] ?? "respond";
}

// Types in the catalogue with no behaviour recorded. Empty is the only correct
// answer; the test reports the names so adding one says which.
export function unclassifiedTypes(): string[] {
	return visualCatalog
		.map((definition) => definition.type)
		.filter((type) => !(type in behaviours));
}

// What the preview says underneath the demonstration.
export const behaviourCaptions: Record<PreviewBehaviour, string> = {
	crossFilter:
		"Clicking a mark narrows the rest of the page to it. Clicking it again clears that.",
	brush: "Dragging across the axis selects a stretch, and the page narrows to it.",
	drill: "Clicking opens the level underneath instead of filtering, so a total becomes its parts.",
	respond:
		"Reads the page rather than driving it. This is what changes when a reader uses something else.",
	narrow: "The reader picks values. Everything else drops out of the page.",
	band: "The reader moves the ends. Rows outside the range drop out.",
	split: "One condition, on or off. Rows that fail it drop out.",
	blanks: "Finds the rows with nothing in the field, which a value list cannot offer.",
	repoint:
		"Every visual reading the placeholder redraws against the new choice.",
	gather: "Holds other visuals. They move with it, or open together from a button.",
	static: "Says something. Nothing on the page changes when a reader clicks it.",
};
