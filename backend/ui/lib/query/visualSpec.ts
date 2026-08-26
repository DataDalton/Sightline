import { isFilterVisual } from "../visuals/catalog";

// The query a visual makes, decided in one place.
//
// Each visual type asks for a different shape: a chart sorts by its first
// dimension and takes five hundred rows, a scorecard takes one, a record panel
// takes two so it can tell "the record" from "one of several", a grid takes its
// first page. That knowledge used to live only inside each component, which was
// fine while the only thing building a query was the component itself.
//
// Warming needs the same question asked from the server, before any component
// exists. Writing it a second time there would be two implementations of a
// cache key, and the failure when they drift is silent: the warm entry is keyed
// off a spec nobody asks for, so it costs a warehouse query and saves nothing.
// So the renderer and the components call this too, and the type sets that
// decide which component renders what live here rather than beside them.

// Chart types the ECharts renderer handles.
export const chartTypes = new Set([
	"lineChart",
	"barChart",
	"areaChart",
	"scatterChart",
	"horizontalBarChart",
	"stackedBarChart",
	"comboChart",
	"pieChart",
	"donutChart",
	"treemapChart",
	"funnelChart",
	"gauge",
	"waterfallChart",
	"heatmapChart",
	"radarChart",
	// Kept so reports authored before the real heatmap landed still render.
	"heatmap",
]);

export const gridTypes = new Set(["table"]);

// One record, not a table of many. Both were grids until it became obvious a
// search box and an export button were the wrong furniture for a page about a
// single customer.
export const recordTypes = new Set(["definitionList", "entityHeader"]);

export interface VisualQueryShape {
	sourceKey: string;
	dimensions?: string[];
	measures?: string[];
	filters?: unknown[];
	sort?: { field: string; direction: "asc" | "desc" }[];
	limit?: number;
	offset?: number;
}

export interface VisualInputs {
	sourceKey: string;
	dimensions: string[];
	measures: string[];
	// Optional so a caller with nothing applied can leave it out. Absent and
	// empty have to mean the same thing, or they would be two cache keys.
	filters?: unknown[];
	// Only a chart takes one, and only when its author set it.
	limit?: number;
}

// Rows a full-width grid asks for in its first page. Only the first page is
// worth warming: the rest arrive as the reader scrolls.
export const gridPageSize = 200;

// Rows a matrix asks for at its top level.
export const matrixLevelRows = 2000;

// The chart default, when the author has not set one.
export const chartRows = 500;

// Returns null for a visual that asks the warehouse nothing: a text panel, a
// filter widget, a switch, a notice, or a type this build does not render.
export function queryForVisual(
	visualType: string,
	inputs: VisualInputs,
): VisualQueryShape | null {
	const { sourceKey, dimensions, measures } = inputs;
	const filters = inputs.filters ?? [];
	if (!sourceKey) return null;
	if (isFilterVisual(visualType)) return null;

	if (visualType === "kpiRow") {
		// A scorecard is one aggregate with no grouping.
		if (measures.length === 0) return null;
		return { sourceKey, measures, filters, limit: 1 };
	}

	if (visualType === "matrixTable") {
		// The top level groups by the first row dimension only. Deeper levels
		// are asked for when a reader expands one, and cannot be known before
		// they do.
		const first = dimensions[0];
		if (!first) return null;
		return {
			sourceKey,
			dimensions: dimensions.slice(0, 1),
			measures,
			filters,
			sort: [{ field: first, direction: "asc" }],
			limit: matrixLevelRows,
		};
	}

	if (chartTypes.has(visualType)) {
		if (dimensions.length === 0 && measures.length === 0) return null;
		return {
			sourceKey,
			dimensions,
			measures,
			filters,
			sort:
				dimensions.length > 0
					? [{ field: dimensions[0], direction: "asc" }]
					: [],
			limit: inputs.limit ?? chartRows,
		};
	}

	if (recordTypes.has(visualType)) {
		if (dimensions.length === 0 && measures.length === 0) return null;
		return { sourceKey, dimensions, measures, filters, limit: 2 };
	}

	if (gridTypes.has(visualType)) {
		return {
			sourceKey,
			dimensions,
			measures,
			filters,
			sort: [],
			limit: gridPageSize,
			offset: 0,
		};
	}

	// Text, switches, notices, and anything this build does not render.
	return null;
}

// Placeholders a page resolves from its own controls.
//
// A page opens with no breakdown and no grain chosen, and an unresolved
// placeholder is dropped rather than sent to the warehouse. So in the state a
// page opens in, these simply are not there.
const placeholders = new Set(["<selected>", "<grain>"]);

interface SourceFields {
	dimensions: { name: string }[];
	measures: { name: string }[];
}

interface VisualDefinition {
	visualType: string;
	config: {
		dimensions?: string[];
		measures?: string[];
		filters?: unknown[];
		options?: Record<string, unknown>;
	};
}

// The dimensions and measures a visual reads, as a page opens.
//
// Names the source no longer defines are dropped here exactly as the renderer
// drops them, because a report and the semantic layer drift and a stale name
// must not reach the warehouse from either path.
export function fieldsForVisual(
	config: { dimensions?: string[]; measures?: string[] },
	source: SourceFields,
): { dimensions: string[]; measures: string[] } {
	const knownDimensions = new Set(source.dimensions.map((f) => f.name));
	const knownMeasures = new Set(source.measures.map((f) => f.name));

	return {
		dimensions: (config.dimensions ?? [])
			.filter((d) => !placeholders.has(d))
			.filter((d) => knownDimensions.has(d)),
		measures: (config.measures ?? []).filter((m) => knownMeasures.has(m)),
	};
}

// The query a stored visual makes when its page is opened and nothing has been
// touched. This is the server's view, with no component and no page state.
//
// A chart with a drill hierarchy shows the top of that hierarchy rather than
// the dimension its author encoded, so the field it groups by on arrival is the
// first drill field. Getting this wrong would key the warm entry on a grouping
// the page never asks for.
export function initialQueryForVisual(
	visual: VisualDefinition,
	sourceKey: string,
	source: SourceFields,
): VisualQueryShape | null {
	const { dimensions, measures } = fieldsForVisual(visual.config, source);

	const drillFields = Array.isArray(visual.config.options?.drillFields)
		? (visual.config.options.drillFields as string[])
		: [];
	const canDrill = drillFields.length > 1;

	const active =
		canDrill && chartTypes.has(visual.visualType)
			? [drillFields[0]].filter(Boolean)
			: dimensions;

	const authorLimit =
		typeof visual.config.options?.limit === "number"
			? (visual.config.options.limit as number)
			: undefined;

	return queryForVisual(visual.visualType, {
		sourceKey,
		dimensions: active,
		measures,
		filters: (visual.config.filters ?? []) as unknown[],
		limit: authorLimit,
	});
}
