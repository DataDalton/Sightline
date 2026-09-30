import {
	formatCompact,
	formatValue,
	toNumber,
	type FormatHint,
} from "../../lib/format";
import {
	evaluateConditions,
	referenceValue,
	styleForMeasure,
	type VisualStyle,
} from "../../lib/visuals/style";
import { contrastingText, mix, withAlpha, type ThemeColors } from "./colors";
import {
	distributionColumns,
	paretoCumulative,
} from "../../lib/query/visualSpec";
import { matchCountry } from "../../lib/visuals/countryNames";
import {
	matchesSelection,
	selectionCovers,
	selectionValue,
	type SelectionPart,
} from "../../lib/visuals/selection";
import {
	placeForecast,
	unitWords,
	type ForecastResult,
} from "../../lib/visuals/forecast";
import { worldMapName } from "./worldMap";

// Builds the ECharts option for each visual type.
//
// Kept out of the component so the mapping from data to marks is testable and
// so adding a chart type does not mean touching React. Every builder receives
// the same inputs and returns a plain option object.

export interface ChartContext {
	rows: Record<string, unknown>[];
	// The same rows for an earlier window, for the types that draw a change
	// rather than a level. Null means no comparison was asked for, which is a
	// different thing from one that was asked for and came back empty.
	comparisonRows?: Record<string, unknown>[] | null;
	dimensions: string[];
	measures: string[];
	colors: ThemeColors;
	style?: VisualStyle;
	hintFor: (field: string) => FormatHint;
	// Set when this chart produced the page selection. Marks that are not in it
	// are dimmed rather than removed, so the selection is read in context.
	//
	// A set of values per field rather than a single value. A reader who drags
	// across five bars has selected five, and a click on a heatmap cell or a
	// stacked segment selects one value of each of two fields.
	selection?: SelectionPart[] | null;
	// The dimension a stacked chart split into series, so a selected segment
	// can be matched by its series as well as by its category.
	seriesField?: string;
	// What the author set on this particular visual, as declared in the visual
	// catalogue. Read through option(), which applies the catalogue fallback so
	// a chart and the properties panel cannot disagree about what unset means.
	options?: Record<string, unknown>;
	// Forecasts for the measures of a chart drawn across dates, worked out by
	// the component from the same rows. Drawn past the last period by the
	// cartesian builder and ignored everywhere else.
	forecast?: ForecastResult | null;
}

// Text from the data, made safe to place inside a tooltip's HTML.
//
// Tooltip formatters return markup, and a category name, a series name or a
// row value is whatever the warehouse holds. Escaped so a value containing
// markup is shown as text rather than rendered.
function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// A formatted figure for tooltip markup. A measure with a text or date hint, or
// a value that does not parse as a number, formats to the raw string, so it is
// escaped like any other text from the data.
function tipValue(value: unknown, hint: FormatHint): string {
	return escapeHtml(formatValue(value, hint));
}

// Sorting a chart by its own values.
//
// Done on the marks rather than in the query, because the query is shared: a
// grid and a chart reading the same fields resolve to one cache entry, and
// ordering in SQL would split that in two for a difference only one of them
// renders.
function sortedRows(
	ctx: ChartContext,
	measure: string,
): Record<string, unknown>[] {
	const by = ctx.options?.sortBy;
	if (by !== "valueDesc" && by !== "valueAsc") return ctx.rows;

	const direction = by === "valueDesc" ? -1 : 1;
	return [...ctx.rows].sort(
		(a, b) =>
			direction *
			((toNumber(a[measure]) ?? 0) - (toNumber(b[measure]) ?? 0)),
	);
}

// How faint a mark outside the selection is drawn, the same on every type so
// a selection reads the same wherever it was made.
const dimmedOpacity = 0.25;

// The selection when it applies to this chart's fields, or null. Everything on
// screen being selected also counts as nothing to mark, which happens once a
// chart has narrowed to what was drawn on it. There is nothing to contrast
// against then, so dimming would only make the whole chart look faded.
function activeSelection(
	ctx: ChartContext,
	markCount: number = ctx.rows.length,
): SelectionPart[] | null {
	const fields = ctx.seriesField
		? [...ctx.dimensions, ctx.seriesField]
		: ctx.dimensions;
	if (!selectionCovers(ctx.selection, fields)) return null;
	const primary = ctx.selection.find(
		(entry) => entry.field === ctx.dimensions[0],
	);
	if (
		ctx.selection.length === 1 &&
		primary &&
		primary.values.length >= markCount
	) {
		return null;
	}
	return ctx.selection;
}

// Opacity for one mark given the dimension values it stands for. Undefined
// when nothing is selected, so the normal path allocates no per-point styling.
function markOpacity(
	selection: SelectionPart[] | null,
	mark: Record<string, unknown>,
): number | undefined {
	if (!selection) return undefined;
	return matchesSelection(selection, mark) ? 1 : dimmedOpacity;
}

// Opacity per data row, dimming everything that is not the selection. The
// series a value belongs to is matched too when the series are values of a
// dimension.
function highlightOpacity(
	ctx: ChartContext,
	row: Record<string, unknown> | undefined,
	seriesName?: string,
): number | undefined {
	const selection = activeSelection(ctx);
	if (!selection) return undefined;
	const mark: Record<string, unknown> = { ...(row ?? {}) };
	if (ctx.seriesField && seriesName !== undefined) {
		mark[ctx.seriesField] = seriesName;
	}
	return markOpacity(selection, mark);
}

// The colour a threshold rule puts on one bar.
//
// The same rules a grid and a scorecard read, so a page says the same thing
// about the same figure wherever it appears. Only a background is honoured: a
// bar has no text of its own, and a text colour applied to a filled shape is
// the rule saying something the shape cannot carry.
//
// Returns undefined when nothing matches, which keeps the fast path: an
// unstyled chart allocates no per-point objects at all.
function conditionColor(
	ctx: ChartContext,
	measure: string,
	rowIndex: number,
): string | undefined {
	const rules = ctx.style?.conditions ?? [];
	if (rules.length === 0) return undefined;

	const row = ctx.rows[rowIndex];
	if (!row) return undefined;

	const match = evaluateConditions(rules, row, measure, {
		position: rowIndex,
		total: ctx.rows.length,
	});
	if (!match?.background) return undefined;
	return ctx.colors.resolve(match.background, ctx.colors.series[0]);
}

function seriesColor(
	ctx: ChartContext,
	measure: string,
	index: number,
): string {
	const s = styleForMeasure(ctx.style, measure, index);
	return ctx.colors.resolve(
		s.color,
		ctx.colors.series[index % ctx.colors.series.length],
	);
}

// Shared tooltip that formats values the same way the tables do, so a figure
// does not change shape depending on where it is read.
function tooltip(ctx: ChartContext, trigger: "item" | "axis" = "axis") {
	return {
		show: ctx.style?.tooltip?.enabled !== false,
		trigger: ctx.style?.tooltip?.mode === "single" ? "item" : trigger,
		// Out of the visual and onto the page.
		//
		// A chart sits in a scrolling panel, so a tooltip drawn inside it is
		// clipped by the panel: hovering anything near the top edge showed
		// half a box. On the body it is positioned against the viewport and
		// has the whole page to open into.
		appendTo: "body",
		backgroundColor: ctx.colors.tooltipBg,
		borderWidth: 0,
		textStyle: { color: ctx.colors.tooltipText, fontSize: 12 },
	};
}

function legend(ctx: ChartContext, show: boolean) {
	return {
		show: ctx.style?.legend?.show !== false && show,
		top: ctx.style?.legend?.position === "bottom" ? undefined : 0,
		bottom: ctx.style?.legend?.position === "bottom" ? 0 : undefined,
		icon: "roundRect",
		itemWidth: 10,
		itemHeight: 10,
		textStyle: { color: ctx.colors.text },
	};
}

// How far above the plot an axis name sits, and how much room the grid has to
// leave for it.
//
// ECharts draws the name outside the grid rect and containLabel does not
// measure it, so a grid top of 16 with the default gap of 15 put "Count" at
// y = 1 and the canvas cut the text in half. Every builder that can name a
// vertical axis reserves axisNameTop rather than choosing its own.
const axisNameGap = 10;
const axisNameTop = 28;

// The name of a vertical axis, at the top of it. Returns nothing when there is
// no name, so a chart without one keeps whatever grid it chose.
function verticalAxisName(ctx: ChartContext, text: string | null | undefined) {
	if (!text) return {};
	return {
		name: text,
		nameLocation: "end" as const,
		nameGap: axisNameGap,
		nameTextStyle: { color: ctx.colors.textMuted, align: "left" as const },
	};
}

function valueAxis(ctx: ChartContext, hint: FormatHint) {
	return {
		type: "value" as const,
		...verticalAxisName(ctx, ctx.style?.yAxis?.label),
		// A truncated axis exaggerates differences, so zero is included unless
		// the author explicitly opts out.
		scale: ctx.style?.yAxis?.beginAtZero === false,
		min: ctx.style?.yAxis?.min,
		max: ctx.style?.yAxis?.max,
		axisLabel: {
			color: ctx.colors.axis,
			fontSize: axisFontSize(ctx),
			formatter: (v: number) => formatCompact(v, hint),
		},
		splitLine: {
			show: ctx.style?.yAxis?.showGrid !== false,
			lineStyle: { color: ctx.colors.grid },
		},
	};
}

// Larger axis text for a visual opened full size, where there is room for it
// and the reader is looking closely. The library's own size otherwise.
function axisFontSize(ctx: ChartContext): number | undefined {
	return ctx.options?.largeText === true ? 14 : undefined;
}

function categoryAxis(ctx: ChartContext, categories: string[]) {
	return {
		type: "category" as const,
		data: categories,
		name: ctx.style?.xAxis?.label,
		axisLabel: {
			hideOverlap: true,
			color: ctx.colors.axis,
			fontSize: axisFontSize(ctx),
			rotate: ctx.style?.xAxis?.labelRotation ?? 0,
		},
		axisLine: { lineStyle: { color: ctx.colors.grid } },
		axisTick: { alignWithLabel: true },
		splitLine: { show: ctx.style?.xAxis?.showGrid ?? false },
	};
}

const baseGrid = { left: 8, right: 16, top: 30, bottom: 8, containLabel: true };

// A window onto a long series, when the author has asked for one.
//
// Off unless asked for. A slider under every chart is furniture on the ninety
// percent of them that plot twelve months, and it costs vertical space on a
// tile that has none to give.
//
// Two controls rather than one, because they suit different hands: the slider
// is the discoverable one and the wheel is the fast one, and both drive the
// same window so they cannot disagree.
//
// This is a view of the same rows rather than a new query. Nothing is fetched,
// so the window moves at the speed of a repaint and narrowing it never costs a
// warehouse round trip.
// Points shown when a long series is opened full size. The rest are one drag
// of the slider away.
const openedWindow = 180;

function zoomWindow(ctx: ChartContext, axisIndex: 0 | 1) {
	if (ctx.options?.zoomSlider !== true) return undefined;

	const on = axisIndex === 0 ? { xAxisIndex: 0 } : { yAxisIndex: 0 };
	// Opened full size, a long series starts on its most recent stretch, so
	// the points are far enough apart to read.
	const points = ctx.rows.length;
	const start =
		ctx.options?.largeText === true && points > openedWindow
			? Math.round((1 - openedWindow / points) * 100)
			: 0;
	return [
		{
			type: "slider" as const,
			...on,
			start,
			end: 100,
			height: 18,
			bottom: 4,
			borderColor: ctx.colors.grid,
			fillerColor: withAlpha(ctx.colors.series[0], 0.12),
			handleStyle: { color: ctx.colors.axis },
			textStyle: { color: ctx.colors.textMuted, fontSize: 10 },
		},
		{ type: "inside" as const, ...on, start, end: 100 },
	];
}

// The lines an author asked to be drawn across the plot.
//
// Attached to one series rather than to each, because a reference is a property
// of the chart and drawing it per series would stack four identical lines on
// top of each other and label the plot four times.
//
// A line that cannot be placed is left out rather than drawn at zero. The whole
// value of a target line is that its position is a fact, and one at a position
// nobody chose is read as a fact too.
function referenceMarkLine(
	ctx: ChartContext,
	orientation: "vertical" | "horizontal" = "vertical",
) {
	const lines = ctx.style?.referenceLines ?? [];
	if (lines.length === 0) return undefined;

	const dashes: Record<string, string> = {
		solid: "solid",
		dashed: "dashed",
		dotted: "dotted",
	};

	const data = lines
		.map((reference) => {
			const measure = reference.measure ?? ctx.measures[0];
			if (!measure) return null;

			const at = referenceValue(reference, ctx.rows, measure);
			if (at === null) return null;

			const color = reference.color
				? ctx.colors.resolve(reference.color, ctx.colors.axis)
				: ctx.colors.axis;

			// A horizontal bar chart puts the values along the bottom, so
			// the line that reads as a threshold there is a vertical one.
			const position =
				orientation === "horizontal" ? { xAxis: at } : { yAxis: at };

			return {
				...position,
				// The right scale when the measure it belongs to is plotted
				// there, so a target for a percentage does not land against a
				// currency axis.
				yAxisIndex: reference.axis === "right" ? 1 : 0,
				label: {
					show: true,
					position: "insideEndTop" as const,
					color,
					fontSize: 11,
					formatter: () =>
						reference.label?.trim() ||
						formatCompact(at, ctx.hintFor(measure)),
				},
				lineStyle: {
					color,
					width: 1.5,
					type: dashes[reference.line ?? "dashed"] ?? "dashed",
				},
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

	if (data.length === 0) return undefined;

	return {
		silent: true,
		symbol: "none" as const,
		animation: false,
		data,
	};
}

// A vertical rule at each selected category, added to whatever reference lines
// the author drew. Left off when every category is selected or when the rules
// would crowd the plot, since a line per category marks nothing.
function withSelectionLines(
	ctx: ChartContext,
	reference: ReturnType<typeof referenceMarkLine>,
	categories: string[],
) {
	if (categories.length === 0 || categories.length > 12) return reference;
	const rules = categories.map((category) => ({
		xAxis: category,
		label: { show: false },
		lineStyle: {
			color: ctx.colors.text,
			width: 1,
			type: "solid" as const,
			opacity: 0.55,
		},
	}));
	return {
		silent: true,
		symbol: "none" as const,
		animation: false,
		data: [...(reference?.data ?? []), ...rules],
	};
}

// Bounds for an axis that a handful of values would otherwise ruin.
//
// A scatter of the largest few hundred orders is a readable cloud until one of
// them carries a discount of minus five billion percent, at which point every
// other point is a line along the axis. Trimming to the first and ninety ninth
// percentile gives the cloud the plot back.
//
// Only applied when it changes the picture: if the trimmed span is most of the
// full span there are no extremes to exclude, and moving the bounds would be
// cropping the data for no reason. Whatever falls outside is counted and said
// under the chart rather than quietly dropped.
export function trimmedBounds(
	values: number[],
): { min: number; max: number } | null {
	const usable = values
		.filter((v) => Number.isFinite(v))
		.sort((a, b) => a - b);
	if (usable.length < 20) return null;

	const at = (fraction: number) =>
		usable[
			Math.min(
				usable.length - 1,
				Math.max(0, Math.round((usable.length - 1) * fraction)),
			)
		];

	const low = at(0.01);
	const high = at(0.99);
	const fullSpan = usable[usable.length - 1] - usable[0];
	const trimmedSpan = high - low;
	if (fullSpan <= 0 || trimmedSpan <= 0) return null;
	if (trimmedSpan > fullSpan * 0.4) return null;

	// A little air, so a point sitting exactly at the percentile is drawn
	// inside the plot rather than half on the frame.
	const pad = trimmedSpan * 0.05;
	return { min: low - pad, max: high + pad };
}

// --- Cartesian: bar, line, area, scatter, combo, stacked -------------------

// A second dimension turned into one series per value.
//
// A stacked chart splits a total, and the split is usually a field rather than
// a list of measures: contract count by status within each expiry bucket is one
// measure and two dimensions. Without this the second dimension was dropped and
// every row became its own bar, which on a hundred percent stack drew a full
// column for each of eleven rows and said nothing at all.
//
// Returns the context unchanged unless there is exactly one measure to split
// and a dimension to split it by, because with several measures the measures
// are already the series.
function pivotSecondDimension(ctx: ChartContext): ChartContext {
	if (ctx.dimensions.length < 2 || ctx.measures.length !== 1) return ctx;

	const [axisField, seriesField] = ctx.dimensions;
	const measure = ctx.measures[0];

	// Both in first-seen order, so the axis keeps whatever order the query
	// asked for and the stack is built the same way every render.
	const categories: string[] = [];
	const series: string[] = [];
	// Looked up once per row, so held as a set beside the ordered list.
	const seriesSeen = new Set<string>();
	const byCategory = new Map<string, Record<string, unknown>>();

	for (const row of ctx.rows) {
		const category = String(row[axisField] ?? "");
		const name = String(row[seriesField] ?? "");

		let entry = byCategory.get(category);
		if (!entry) {
			entry = { [axisField]: row[axisField] };
			byCategory.set(category, entry);
			categories.push(category);
		}
		if (!seriesSeen.has(name)) {
			seriesSeen.add(name);
			series.push(name);
		}

		// Summed rather than assigned, because the same pair can arrive twice
		// once a third field is filtered rather than grouped.
		entry[name] =
			(toNumber(entry[name]) ?? 0) + (toNumber(row[measure]) ?? 0);
	}

	// A missing pair is zero of that series, not a gap. Left absent it would
	// break the stack and shift every series above it.
	for (const entry of byCategory.values()) {
		for (const name of series) {
			if (entry[name] === undefined) entry[name] = 0;
		}
	}

	return {
		...ctx,
		rows: categories.map(
			(c) => byCategory.get(c) as Record<string, unknown>,
		),
		dimensions: [axisField],
		measures: series,
		// The series are values of a dimension now, so they carry no format
		// hint of their own. They hold the measure, so they read like it.
		hintFor: (field) =>
			seriesSeen.has(field) ? ctx.hintFor(measure) : ctx.hintFor(field),
		// Each pivoted row still carries its category, and each series is a
		// value of this field, so a selected segment can be found by both.
		seriesField,
	};
}

// One forecast value on the axis, as the tooltip reads it.
interface ForecastPoint {
	measure: string;
	color: string;
	value: number;
	lower: number;
	upper: number;
	// What the period holds so far, for a period already on the chart but
	// not yet finished. Null past the chart's end.
	soFar: number | null;
	// The typical miss on a single period, as words for the tooltip.
	note: string | null;
}

// The fields of a drawn measure series the forecast marks copy.
interface DrawnSeries {
	name: string;
	type: string;
	yAxisIndex: number;
	stack?: string;
	itemStyle: { color: string; borderRadius?: unknown };
	lineStyle?: { width?: number };
	data: unknown[];
}

// Prefix on the id of every forecast series, which is how the tooltip and the
// chart component tell a forecast mark from a measured one.
export const forecastSeriesPrefix = "forecast";

// How strongly a forecast bar and the band behind a forecast are filled,
// against the solid series colour of the measure they continue, and how
// strongly the dashed edges of the band are drawn.
const forecastBarOpacity = 0.35;
const forecastBandOpacity = 0.2;
const forecastEdgeOpacity = 0.45;

// The legend entry every forecast mark sits under, kept clear of a measure
// that happens to be called Forecast so toggling one does not hide the other.
function forecastLegendName(measures: string[]): string {
	return measures.includes("Forecast") ? "Projected" : "Forecast";
}

// The marks that continue each measure past its last finished period.
//
// A dashed line from the last finished point for a line, and faded bars with
// a dashed outline for bars. Behind either sits a shaded range drawn as two
// stacked lines, a line at the lower bound and a filled one the height of the
// range on top of it, both edges dashed. Every forecast series is silent, so
// a click on one selects nothing and the keyboard steps over it, and all of
// them share one legend entry.
//
// A period on the chart that has not finished yet is forecast like the ones
// after it. On a line its partial figure is cut from the solid line and drawn
// as a hollow point, so the solid line ends at the last finished period and
// the dashed one carries on from there without a kink. On a bar chart the
// partial bar stays and a faded bar on top of it shows what the rest of the
// period is expected to add.
//
// A stacked measure draws its forecast stacked the same way but without a
// range, since a range around one layer of a stack reads as a range around
// the total. Null when the chart is not an increasing run of dates the
// forecast lines up with.
function forecastLayer(
	ctx: ChartContext,
	kind: string,
	orientation: "vertical" | "horizontal",
	categories: string[],
	drawn: DrawnSeries[],
): {
	appended: string[];
	series: Record<string, unknown>[];
	points: Map<number, ForecastPoint[]>;
} | null {
	const result = ctx.forecast;
	if (!result || orientation !== "vertical") return null;
	if (kind === "stacked100" || kind === "scatter") return null;
	if (ctx.dimensions.length !== 1) return null;
	const by = ctx.options?.sortBy;
	if (by === "valueDesc" || by === "valueAsc") return null;
	const placed = placeForecast(categories, result);
	if (!placed) return null;

	const total = categories.length + placed.appended.length;
	const legendName = forecastLegendName(ctx.measures);
	const unitWord = unitWords[result.spacing.unit][0];
	const lines: Record<string, unknown>[] = [];
	const bands: Record<string, unknown>[] = [];
	const partials: Record<string, unknown>[] = [];
	const points = new Map<number, ForecastPoint[]>();

	for (const forecast of result.series) {
		const index = drawn.findIndex((d) => d.name === forecast.measure);
		if (index < 0) continue;
		const measured = drawn[index];
		if (measured.type !== "line" && measured.type !== "bar") continue;
		const color = measured.itemStyle.color;
		const isBar = measured.type === "bar";
		const stacked = measured.stack !== undefined;
		const note =
			forecast.typicalError === null
				? null
				: `Typically within ±${Math.max(1, Math.round(forecast.typicalError * 100))}% per ${unitWord}`;

		const marks: (number | null)[] = new Array(total).fill(null);
		const soFar: (number | null)[] = new Array(total).fill(null);
		// A line starts at the last finished point so it reads as a
		// continuation. A bar has no line to continue.
		if (!isBar) marks[placed.anchorIndex] = forecast.anchor;
		placed.indices.forEach((at, i) => {
			const onChart = at < categories.length;
			const partial = onChart
				? toNumber(ctx.rows[at]?.[forecast.measure])
				: null;
			if (!onChart) {
				marks[at] = forecast.values[i];
			} else if (!isBar) {
				// The partial figure leaves the solid line, which then ends
				// where the dashed one starts.
				marks[at] = forecast.values[i];
				if (!stacked) {
					measured.data[at] = null;
					soFar[at] = partial;
				}
			} else if (!stacked) {
				// On top of the partial bar, up to the forecast for the whole
				// period.
				marks[at] = Math.max(0, forecast.values[i] - (partial ?? 0));
			}
			const list = points.get(at) ?? [];
			list.push({
				measure: forecast.measure,
				color,
				value: forecast.values[i],
				lower: forecast.lower[i],
				upper: forecast.upper[i],
				soFar: partial,
				note,
			});
			points.set(at, list);
		});

		// Bars that do not stack take a slot of their own beside the other
		// measures. Putting the forecast in a stack with its measure keeps
		// it in that measure's slot, and on the one period both hold a value
		// the forecast bar is the remainder above the partial one.
		let stack: string | undefined;
		if (isBar) {
			stack = measured.stack ?? `${forecastSeriesPrefix}-slot:${index}`;
			measured.stack = stack;
		} else if (stacked) {
			stack = `${forecastSeriesPrefix}:${measured.stack}`;
		}

		lines.push({
			id: `${forecastSeriesPrefix}:${forecast.measure}`,
			name: legendName,
			type: measured.type,
			yAxisIndex: measured.yAxisIndex,
			stack,
			silent: true,
			animation: false,
			showSymbol: false,
			symbol: "none",
			barMaxWidth: 36,
			itemStyle: isBar
				? {
						color: withAlpha(color, forecastBarOpacity),
						borderColor: color,
						borderWidth: 1,
						borderType: "dashed",
						borderRadius: measured.itemStyle.borderRadius,
					}
				: { color },
			lineStyle: isBar
				? undefined
				: {
						color,
						width: measured.lineStyle?.width ?? 2,
						type: "dashed",
					},
			data: marks,
		});

		// The partial figures as hollow points under the measure's own
		// legend entry, so hiding the measure hides them too.
		if (soFar.some((v) => v !== null)) {
			partials.push({
				id: `${forecastSeriesPrefix}-sofar:${forecast.measure}`,
				name: measured.name,
				type: "line",
				yAxisIndex: measured.yAxisIndex,
				silent: true,
				animation: false,
				showSymbol: true,
				symbol: "circle",
				symbolSize: 7,
				z: 3,
				itemStyle: {
					color: withAlpha(color, 0),
					borderColor: color,
					borderWidth: 1.5,
				},
				lineStyle: { opacity: 0 },
				data: soFar,
			});
		}

		if (stacked) continue;
		const lower: (number | null)[] = new Array(total).fill(null);
		const height: (number | null)[] = new Array(total).fill(null);
		lower[placed.anchorIndex] = forecast.anchor;
		height[placed.anchorIndex] = 0;
		placed.indices.forEach((at, i) => {
			lower[at] = forecast.lower[i];
			height[at] = forecast.upper[i] - forecast.lower[i];
		});
		const band = {
			name: legendName,
			type: "line",
			yAxisIndex: measured.yAxisIndex,
			stack: `${forecastSeriesPrefix}-band:${index}`,
			// Stacked as plain sums, so a lower bound below zero still has
			// the range drawn on top of it rather than on a separate stack.
			stackStrategy: "all",
			silent: true,
			animation: false,
			showSymbol: false,
			symbol: "none",
			z: 1,
			itemStyle: { color },
			// Each stacked line is drawn at its running sum, which puts one
			// on each edge of the range.
			lineStyle: {
				color: withAlpha(color, forecastEdgeOpacity),
				width: 1,
				type: "dashed",
			},
		};
		bands.push(
			{
				...band,
				id: `${forecastSeriesPrefix}-low:${forecast.measure}`,
				data: lower,
			},
			{
				...band,
				id: `${forecastSeriesPrefix}-band:${forecast.measure}`,
				areaStyle: { color: withAlpha(color, forecastBandOpacity) },
				data: height,
			},
		);
	}

	if (lines.length === 0) return null;
	// The lines first, so the legend entry takes its swatch from a line
	// rather than from the lower bound of the range.
	return {
		appended: placed.appended,
		series: [...lines, ...bands, ...partials],
		points,
	};
}

export function buildCartesian(
	input: ChartContext,
	kind: "bar" | "line" | "area" | "scatter" | "combo" | "stacked100",
	orientation: "vertical" | "horizontal" = "vertical",
) {
	// Only where the chart stacks. Everywhere else a second dimension is the
	// author asking for something the type does not draw, and quietly turning
	// it into eleven series would be a different chart from the one they built.
	const shaped = kind === "stacked100" ? pivotSecondDimension(input) : input;
	// Ordered once, before anything reads a row, and carried on the context,
	// so the categories, every series, the tooltip, the selection dimming and
	// the threshold colours all index into the same sequence.
	const ctx: ChartContext = {
		...shaped,
		rows: sortedRows(shaped, shaped.measures[0]),
	};
	const { dimensions, measures, colors, style } = ctx;
	const axisField = dimensions[0];
	const rows = ctx.rows;
	const categories = rows.map((r) => String(r[axisField] ?? ""));
	const primaryHint = ctx.hintFor(measures[0]);

	const usesRightAxis = measures.some(
		(m, i) => styleForMeasure(style, m, i).axis === "right",
	);

	// A 100% stacked chart normalises each category to its own total, which is
	// what makes it a composition rather than a comparison.
	const totals =
		kind === "stacked100"
			? rows.map((r) =>
					measures.reduce((sum, m) => sum + (toNumber(r[m]) ?? 0), 0),
				)
			: null;

	// A line has no bar to dim, and its points are hidden on a long series, so
	// a selected period is marked with a rule across the plot instead.
	const lineSelection =
		(kind === "line" || kind === "area") && orientation === "vertical"
			? activeSelection(ctx)
			: null;
	const selectedCategories = lineSelection
		? rows
				.filter((r) => matchesSelection(lineSelection, r))
				.map((r) => String(r[axisField] ?? ""))
		: [];

	const series = measures.map((measure, index) => {
		const s = styleForMeasure(style, measure, index);
		const color = seriesColor(ctx, measure, index);

		// In a combo chart the first measure is bars and the rest are lines
		// unless the author overrode the type per series.
		const resolvedKind =
			s.type ??
			(kind === "combo"
				? index === 0
					? "bar"
					: "line"
				: kind === "stacked100"
					? "bar"
					: kind);

		const echartsType =
			resolvedKind === "scatter"
				? "scatter"
				: resolvedKind === "bar"
					? "bar"
					: "line";

		const isArea = resolvedKind === "area" || s.fill !== "none";
		const fillOpacity = s.fillOpacity ?? 0.25;

		let areaStyle: Record<string, unknown> | undefined;
		if (isArea && echartsType === "line") {
			if (s.fill === "gradient") {
				const to =
					s.gradientTo === "transparent" || s.gradientTo === undefined
						? withAlpha(color, 0)
						: withAlpha(
								colors.resolve(s.gradientTo, color),
								fillOpacity,
							);
				areaStyle = {
					color: {
						type: "linear",
						x: 0,
						y: 0,
						x2: 0,
						y2: 1,
						colorStops: [
							{ offset: 0, color: withAlpha(color, fillOpacity) },
							{ offset: 1, color: to },
						],
					},
				};
			} else {
				areaStyle = { color: withAlpha(color, fillOpacity) };
			}
		}

		const data = rows.map((r, rowIndex) => {
			const raw = totals
				? totals[rowIndex] === 0
					? 0
					: ((toNumber(r[measure]) ?? 0) / totals[rowIndex]) * 100
				: toNumber(r[measure]);

			const opacity = highlightOpacity(ctx, r, measure);
			// A threshold colour only reads on a filled mark, so it is left to
			// the bars. A line changing colour partway along says the series
			// changed, which is not what a rule about one value means.
			const ruled =
				echartsType === "bar"
					? conditionColor(ctx, measure, rowIndex)
					: undefined;

			// A plain value where nothing is selected and no rule matches
			// keeps the fast path; only a styled chart pays for per-point
			// objects.
			if (opacity === undefined && ruled === undefined) return raw;
			return {
				value: raw,
				itemStyle: {
					...(opacity === undefined ? {} : { opacity }),
					...(ruled === undefined ? {} : { color: ruled }),
				},
			};
		});

		return {
			name: measure,
			type: echartsType,
			yAxisIndex:
				orientation === "horizontal"
					? 0
					: s.axis === "right" && usesRightAxis
						? 1
						: 0,
			smooth: s.smooth ?? false,
			showSymbol: s.showPoints ?? rows.length <= 60,
			symbolSize: echartsType === "scatter" ? 9 : 4,
			stack:
				kind === "stacked100"
					? "total"
					: (s.stack ??
						(kind === "area" && measures.length > 1
							? undefined
							: s.stack)),
			barMaxWidth: 36,
			itemStyle: {
				color,
				borderRadius:
					echartsType === "bar"
						? orientation === "horizontal"
							? [
									0,
									style?.cornerRadius ?? 2,
									style?.cornerRadius ?? 2,
									0,
								]
							: [
									style?.cornerRadius ?? 2,
									style?.cornerRadius ?? 2,
									0,
									0,
								]
						: undefined,
				opacity:
					echartsType === "bar" && s.fill === "solid"
						? fillOpacity
						: 1,
			},
			// A gap is a period nobody measured. Joining across it draws a
			// straight line through data that does not exist, which reads as a
			// trend rather than as an absence, so it is off unless asked for.
			connectNulls: ctx.options?.nulls === "connect",
			label:
				ctx.options?.valueLabels === true && echartsType === "bar"
					? {
							show: true,
							position:
								orientation === "horizontal" ? "right" : "top",
							color: colors.textMuted,
							fontSize: 11,
							formatter: (p: unknown) =>
								formatCompact(
									(p as { value: number }).value,
									ctx.hintFor(measure),
								),
						}
					: undefined,
			lineStyle:
				echartsType === "line"
					? { width: s.lineWidth ?? 2, color }
					: undefined,
			areaStyle,
			// Only on the first series, so one reference draws one line.
			markLine:
				index === 0
					? withSelectionLines(
							ctx,
							referenceMarkLine(ctx, orientation),
							selectedCategories,
						)
					: undefined,
			data,
		};
	});

	const projected = forecastLayer(
		ctx,
		kind,
		orientation,
		categories,
		series as DrawnSeries[],
	);

	const category = categoryAxis(
		ctx,
		projected ? [...categories, ...projected.appended] : categories,
	);
	const value = valueAxis(
		ctx,
		kind === "stacked100" ? "percent" : primaryHint,
	);

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: colors.font },
		grid: {
			...baseGrid,
			top: Math.max(
				style?.legend?.show === false ? 12 : 30,
				style?.yAxis?.label ? axisNameTop : 0,
			),
			// The slider sits under the plot, so the plot has to stop above
			// it rather than being drawn behind it.
			bottom: ctx.options?.zoomSlider === true ? 34 : baseGrid.bottom,
		},
		dataZoom: zoomWindow(ctx, orientation === "horizontal" ? 1 : 0),
		legend: legend(ctx, measures.length > 1),
		tooltip: {
			...tooltip(ctx),
			axisPointer: { type: kind === "bar" ? "shadow" : "line" },
			formatter: cartesianTooltip(
				ctx,
				axisField,
				Boolean(totals),
				projected?.points,
			),
		},
		// Swapping which axis is categorical is the whole difference between a
		// vertical and a horizontal bar chart.
		xAxis: orientation === "horizontal" ? value : category,
		yAxis:
			orientation === "horizontal"
				? category
				: usesRightAxis
					? [
							value,
							{
								type: "value" as const,
								name: style?.rightAxis?.label,
								axisLabel: {
									color: colors.axis,
									formatter: (v: number) =>
										formatCompact(
											v,
											(style?.rightAxis
												?.format as FormatHint) ??
												"decimal",
										),
								},
								splitLine: { show: false },
							},
						]
					: value,
		series: projected ? [...series, ...projected.series] : series,
	};
}

function cartesianTooltip(
	ctx: ChartContext,
	axisField: string,
	normalised: boolean,
	forecastPoints?: Map<number, ForecastPoint[]>,
) {
	return (params: unknown) => {
		const all = Array.isArray(params) ? params : [params];
		if (all.length === 0) return "";
		const first = all[0] as { dataIndex: number; axisValue?: string };
		// Forecast marks are listed from their own values below, so the
		// series behind them are left out here.
		const list = all.filter(
			(entry) =>
				!String(
					(entry as { seriesId?: string }).seriesId ?? "",
				).startsWith(forecastSeriesPrefix),
		);
		const forecasts = forecastPoints?.get(first.dataIndex) ?? [];
		// A period not finished yet lists its measured figure as so far
		// beside the forecast, rather than as a figure of its own.
		const partial = new Set(
			forecasts.filter((p) => p.soFar !== null).map((p) => p.measure),
		);
		const measuredList = list.filter(
			(entry) =>
				!partial.has((entry as { seriesName: string }).seriesName),
		);
		const row = ctx.rows[first.dataIndex] ?? {};

		const total = ctx.style?.tooltip?.showShare
			? ctx.measures.reduce((sum, m) => sum + (toNumber(row[m]) ?? 0), 0)
			: 0;

		const header = `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(
			first.axisValue ?? String(row[axisField] ?? ""),
		)}</div>`;

		const lines = measuredList.map((entry) => {
			const e = entry as { seriesName: string; marker: string };
			const raw = row[e.seriesName];
			// A normalised chart still shows the real figure in the tooltip,
			// because the percentage alone rarely answers the question.
			const value = formatValue(raw, ctx.hintFor(e.seriesName));
			const share =
				normalised || (ctx.style?.tooltip?.showShare && total !== 0)
					? ` <span style="opacity:.7">(${(
							((toNumber(raw) ?? 0) /
								(normalised
									? ctx.measures.reduce(
											(s2, m) =>
												s2 + (toNumber(row[m]) ?? 0),
											0,
										)
									: total)) *
							100
						).toFixed(1)}%)</span>`
					: "";
			return `<div>${e.marker} ${escapeHtml(e.seriesName)}: <b>${escapeHtml(value)}</b>${share}</div>`;
		});

		const extras = (ctx.style?.tooltip?.extraFields ?? [])
			.filter((f) => row[f] !== undefined)
			.map(
				(f) =>
					`<div style="opacity:.75">${escapeHtml(f)}: ${escapeHtml(formatValue(row[f], ctx.hintFor(f)))}</div>`,
			);

		const projected = forecasts.map((point) => {
			const hint = ctx.hintFor(point.measure);
			const swatch = `<span style="display:inline-block;width:10px;margin-right:4px;vertical-align:middle;border-top:2px dashed ${escapeHtml(point.color)}"></span>`;
			const hollow = `<span style="display:inline-block;width:6px;height:6px;margin:0 6px 0 2px;vertical-align:middle;border-radius:50%;border:1.5px solid ${escapeHtml(point.color)}"></span>`;
			const soFar =
				point.soFar === null
					? ""
					: `<div>${hollow}${escapeHtml(point.measure)} <span style="opacity:.7">so far</span>: <b>${escapeHtml(formatValue(point.soFar, hint))}</b></div>`;
			const note = point.note
				? `<div style="opacity:.7;margin-left:14px">${escapeHtml(point.note)}</div>`
				: "";
			return `${soFar}<div>${swatch}${escapeHtml(point.measure)} <span style="opacity:.7">Forecast</span>: <b>${escapeHtml(formatValue(point.value, hint))}</b> <span style="opacity:.7">(${escapeHtml(formatValue(point.lower, hint))} to ${escapeHtml(formatValue(point.upper, hint))})</span></div>${note}`;
		});
		if (lines.length === 0 && projected.length === 0) return "";

		return header + lines.join("") + projected.join("") + extras.join("");
	};
}

// --- Pie and donut ---------------------------------------------------------

export function buildPie(ctx: ChartContext, donut: boolean) {
	const { dimensions, measures, colors } = ctx;
	const field = dimensions[0];
	const measure = measures[0];
	const hint = ctx.hintFor(measure);

	// Largest first, always. A pie is read by comparing angles, and an
	// arbitrary order makes that work the reader should not have to do.
	const ordered = [...ctx.rows].sort(
		(a, b) => (toNumber(b[measure]) ?? 0) - (toNumber(a[measure]) ?? 0),
	);

	// Past a dozen slices a pie is a colour key with a circle attached. Keeping
	// the largest and gathering the rest says the same thing and stays legible,
	// and the gathered slice is honest about being a sum rather than a value.
	//
	// This used to read topN, which the query layer also read as a row limit,
	// so the rows beyond it never arrived and the Other slice could never
	// appear. Worse, the shares that did appear were percentages of the
	// truncated set rather than of the whole. Its own key, and a query that
	// keeps the tail.
	const topN = Number(ctx.options?.groupTail);
	const grouped =
		Number.isFinite(topN) && topN > 0 && ordered.length > topN
			? [
					...ordered.slice(0, topN),
					{
						[field]: `Other (${ordered.length - topN})`,
						[measure]: ordered
							.slice(topN)
							.reduce(
								(sum, r) => sum + (toNumber(r[measure]) ?? 0),
								0,
							),
					} as Record<string, unknown>,
				]
			: ordered;

	// The slices a reader clicked stay solid and the rest are dimmed, as on a
	// bar chart. Matched by name rather than by row, because the slices are
	// sorted and grouped here and no longer line up with the rows. Nothing is
	// dimmed when every slice is selected, since there is nothing to contrast.
	const selected = activeSelection(ctx, grouped.length);
	const hasTail = grouped !== ordered;

	const data = grouped.map((r, i) => {
		const name = String(r[field] ?? "");
		const tail = hasTail && i === grouped.length - 1;
		const opacity = tail
			? selected
				? dimmedOpacity
				: undefined
			: markOpacity(selected, { [field]: r[field] });
		return {
			name,
			value: toNumber(r[measure]) ?? 0,
			// The gathered slice stands for several values, so a click on it
			// selects nothing.
			...(tail ? { tail: true } : {}),
			itemStyle: {
				color: colors.series[i % colors.series.length],
				...(opacity === undefined ? {} : { opacity }),
			},
		};
	});

	// What each slice says about itself. Percentage is the default because a
	// pie is a composition, and the figure a reader wants from one is the share.
	const labelMode = (ctx.options?.sliceLabels as string) ?? "percent";
	const sliceLabel = (p: {
		name: string;
		value: number;
		percent: number;
	}) => {
		if (labelMode === "value") return formatCompact(p.value, hint);
		if (labelMode === "both")
			return `${formatCompact(p.value, hint)} (${p.percent}%)`;
		return `${p.percent}%`;
	};
	// Labels are hung outside the ring, so they stop being legible long before
	// the slices do.
	const showLabels = labelMode !== "none" && grouped.length <= 12;

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: colors.font },
		legend: { ...legend(ctx, true), type: "scroll", orient: "horizontal" },
		tooltip: {
			...tooltip(ctx, "item"),
			formatter: (p: unknown) => {
				const e = p as {
					name: string;
					value: number;
					percent: number;
					marker: string;
				};
				return `${e.marker} ${escapeHtml(e.name)}<br/><b>${tipValue(e.value, hint)}</b> (${e.percent}%)`;
			},
		},
		series: [
			{
				type: "pie",
				// A donut leaves room for the total, which is the reason to
				// prefer it over a pie.
				radius: donut ? ["45%", "70%"] : "70%",
				center: ["50%", "55%"],
				avoidLabelOverlap: true,
				itemStyle: {
					borderRadius: 3,
					borderColor: colors.surface,
					borderWidth: 2,
				},
				label: {
					show: showLabels,
					color: colors.text,
					formatter: (p: unknown) =>
						`${(p as { name: string }).name}\n${sliceLabel(
							p as {
								name: string;
								value: number;
								percent: number;
							},
						)}`,
				},
				labelLine: { show: showLabels },
				data,
			},
		],
	};
}

// --- Treemap ---------------------------------------------------------------

export function buildTreemap(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	const measure = measures[0];
	const hint = ctx.hintFor(measure);

	// A treemap fills whole tiles, and the series palette is built for lines
	// and bars where colour covers a few pixels. At this size the dark theme
	// palette is glaring, so every fill is mixed toward the surface behind it:
	// lighter in light mode, darker in dark mode, same hue either way.
	const tone = (color: string, strength: number) =>
		mix(colors.surface, color, strength);

	// Colour says which group a tile is in, not how big it is. The area
	// already says how big it is, and a lightness ramp on top of that put the
	// two largest tiles side by side in almost the same colour, then the next
	// two in almost the same colour again: a treemap lays tiles out in size
	// order, so ranking the shades makes every neighbour a near match.
	//
	// Within a group the strength steps through three values so adjacent tiles
	// are still separable, and it cycles rather than ramps so nobody reads an
	// order into it.
	const steps = [0.78, 0.58, 0.68];
	const strengthAt = (rank: number) => steps[rank % steps.length];

	// White on a pale tile and near black on a dark one both disappear, and
	// which a tile is depends on the data. ECharts also outlines a label placed
	// inside a shape by default, which draws a halo around every word and is
	// what makes the small tiles unreadable.
	const labelStyle = (fill: string) => ({
		color: contrastingText(fill, "#ffffff", "#16181d"),
		textBorderWidth: 0,
	});

	// A tile outside the selection is mixed most of the way into the surface,
	// which dims it without a second colour scheme to keep in step.
	const selection = activeSelection(ctx);
	const dimmedStrength = 0.22;

	// A second dimension nests, which is what a treemap is actually for.
	const nested = dimensions.length > 1;
	let data: unknown[];

	// A selected group fills the chart, which is the treemap's zoom. Held in
	// the data rather than in the library's own view state, so it survives
	// the redraw a selection causes and a second click on the group's header
	// clears the selection and zooms back out.
	const zoomedGroups =
		nested && selection
			? (selection.find((entry) => entry.field === dimensions[0])
					?.values ?? null)
			: null;

	if (nested) {
		const groups = new Map<
			string,
			{ raw: unknown; children: { raw: unknown; value: number }[] }
		>();
		for (const row of rows) {
			const parent = String(row[dimensions[0]] ?? "");
			const group = groups.get(parent) ?? {
				raw: row[dimensions[0]],
				children: [],
			};
			group.children.push({
				raw: row[dimensions[1]],
				value: toNumber(row[measure]) ?? 0,
			});
			groups.set(parent, group);
		}

		const entries = Array.from(groups.entries()).map(
			([name, group], index) => ({ name, group, index }),
		);
		const zoomed = zoomedGroups
			? entries.filter((entry) =>
					zoomedGroups.includes(selectionValue(entry.group.raw)),
				)
			: [];
		const shown = zoomed.length > 0 ? zoomed : entries;

		data = shown.map(({ name, group, index }) => {
			// Coloured by its place among all the groups, so a group keeps
			// its colour when it is zoomed into.
			const hue = colors.series[index % colors.series.length];
			// Largest first, so the tiles inside a group are laid out and
			// stepped through in the same order.
			const ordered = [...group.children].sort(
				(a, b) => b.value - a.value,
			);
			const parentIn =
				markOpacity(selection, { [dimensions[0]]: group.raw }) !==
				dimmedOpacity;
			const parentFill = tone(hue, parentIn ? 0.5 : dimmedStrength);

			return {
				name,
				itemStyle: { color: parentFill },
				upperLabel: {
					...labelStyle(parentFill),
					// A zoomed group's header is the way back out, so it
					// says so.
					...(zoomed.length > 0 ? { formatter: "‹  {b}" } : {}),
				},
				children: ordered.map((child, rank) => {
					const inside =
						markOpacity(selection, {
							[dimensions[0]]: group.raw,
							[dimensions[1]]: child.raw,
						}) !== dimmedOpacity;
					const fill = tone(
						hue,
						inside ? strengthAt(rank) : dimmedStrength,
					);
					return {
						name: String(child.raw ?? ""),
						value: child.value,
						itemStyle: { color: fill },
						label: labelStyle(fill),
					};
				}),
			};
		});
	} else {
		// One dimension has no grouping, so each tile is its own category and
		// takes the next colour in the palette. Neighbours are always a
		// different hue, which is the whole job colour has here.
		const ordered = [...rows].sort(
			(a, b) => (toNumber(b[measure]) ?? 0) - (toNumber(a[measure]) ?? 0),
		);

		data = ordered.map((r, rank) => {
			const hue = colors.series[rank % colors.series.length];
			const inside =
				markOpacity(selection, {
					[dimensions[0]]: r[dimensions[0]],
				}) !== dimmedOpacity;
			const fill = tone(
				hue,
				inside
					? strengthAt(Math.floor(rank / colors.series.length))
					: dimmedStrength,
			);
			return {
				name: String(r[dimensions[0]] ?? ""),
				value: toNumber(r[measure]) ?? 0,
				itemStyle: { color: fill },
				label: labelStyle(fill),
			};
		});
	}

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: colors.font },
		tooltip: {
			...tooltip(ctx, "item"),
			formatter: (p: unknown) => {
				const e = p as { name: string; value: number };
				return `${escapeHtml(e.name)}<br/><b>${tipValue(e.value, hint)}</b>`;
			},
		},
		series: [
			{
				type: "treemap",
				roam: false,
				// Clicking a group selects it, and the selected group is
				// drawn filling the chart above. The library's own zoom is
				// off because it lives in view state that the redraw after
				// every selection throws away.
				nodeClick: false as const,
				breadcrumb: {
					show: false,
					itemStyle: {
						color: colors.surface,
						borderColor: colors.grid,
						textStyle: { color: colors.text },
					},
				},
				// Set per tile above. What is left here is the placement and
				// the rule that a label too big for its tile is dropped rather
				// than drawn over its neighbours.
				label: {
					show: true,
					formatter: "{b}",
					overflow: "truncate" as const,
					textBorderWidth: 0,
				},
				upperLabel: nested
					? { show: true, height: 20, textBorderWidth: 0 }
					: undefined,
				itemStyle: {
					borderColor: colors.surface,
					borderWidth: 2,
					gapWidth: 2,
				},
				data,
			},
		],
	};
}

// --- Funnel ----------------------------------------------------------------

export function buildFunnel(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	const hint = ctx.hintFor(measures[0]);

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: colors.font },
		legend: legend(ctx, true),
		tooltip: {
			...tooltip(ctx, "item"),
			formatter: (p: unknown) => {
				const e = p as { name: string; value: number; marker: string };
				return `${e.marker} ${escapeHtml(e.name)}: <b>${tipValue(e.value, hint)}</b>`;
			},
		},
		series: [
			{
				type: "funnel",
				top: 30,
				bottom: 10,
				sort: "descending",
				gap: 2,
				// Colour per band, so the label colour is decided per band
				// too: one fixed white reads on the darker series colours and
				// disappears on the lighter ones.
				label: {
					show: true,
					position: "inside" as const,
					textBorderWidth: 0,
				},
				data: rows.map((r, i) => {
					const fill = colors.series[i % colors.series.length];
					const opacity = highlightOpacity(ctx, r);
					return {
						name: String(r[dimensions[0]] ?? ""),
						value: toNumber(r[measures[0]]) ?? 0,
						itemStyle: {
							color: fill,
							...(opacity === undefined ? {} : { opacity }),
						},
						label: {
							color: contrastingText(fill, "#ffffff", "#16181d"),
						},
					};
				}),
			},
		],
	};
}

// --- Gauge -----------------------------------------------------------------

export function buildGauge(ctx: ChartContext) {
	const { rows, measures, colors } = ctx;
	const row = rows[0] ?? {};
	const value = toNumber(row[measures[0]]) ?? 0;
	const hint = ctx.hintFor(measures[0]);
	// A second measure is read as the target, which is the only thing that
	// makes a gauge more informative than a number.
	const target = measures[1] ? toNumber(row[measures[1]]) : null;
	// The dial starts at zero, so a figure at or below it leaves the default
	// scale rather than a maximum below the minimum.
	const max =
		target && target > 0
			? Math.max(target * 1.25, value * 1.1)
			: value > 0
				? value * 1.5
				: 100;

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: colors.font },
		series: [
			{
				type: "gauge",
				min: 0,
				max,
				progress: { show: true, width: 14 },
				axisLine: {
					lineStyle: { width: 14, color: [[1, colors.grid]] },
				},
				itemStyle: { color: seriesColor(ctx, measures[0], 0) },
				pointer: { show: false },
				axisTick: { show: false },
				splitLine: { show: false },
				axisLabel: { show: false },
				detail: {
					valueAnimation: false,
					offsetCenter: [0, "10%"],
					fontSize: 22,
					fontWeight: 600,
					color: colors.text,
					formatter: () => formatCompact(value, hint),
				},
				title: {
					offsetCenter: [0, "40%"],
					color: ctx.colors.textMuted,
					fontSize: 12,
				},
				data: [
					{
						value,
						name: target
							? `of ${formatCompact(target, hint)}`
							: measures[0],
					},
				],
			},
		],
	};
}

// --- Waterfall -------------------------------------------------------------

export function buildWaterfall(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	const hint = ctx.hintFor(measures[0]);
	const categories = rows.map((r) => String(r[dimensions[0]] ?? ""));
	const values = rows.map((r) => toNumber(r[measures[0]]) ?? 0);

	// A waterfall is a stacked bar where the lower stack is invisible and
	// carries the running total. Positive and negative steps are separate
	// series so they can be coloured independently. Every value stacks onto
	// the one below whatever its sign, because the library otherwise stacks
	// negatives apart from positives and a running total below zero would draw
	// its step up from zero.
	const base: number[] = [];
	const rising: unknown[] = [];
	const falling: unknown[] = [];
	let running = 0;

	// A step outside the selection is dimmed like a bar anywhere else. The
	// plain number is kept where nothing is selected.
	const step = (value: number | string, rowIndex: number) => {
		const opacity = highlightOpacity(ctx, rows[rowIndex]);
		return opacity === undefined || value === "-"
			? value
			: { value, itemStyle: { opacity } };
	};

	values.forEach((value, rowIndex) => {
		if (value >= 0) {
			base.push(running);
			rising.push(step(value, rowIndex));
			falling.push("-");
		} else {
			base.push(running + value);
			rising.push("-");
			falling.push(step(-value, rowIndex));
		}
		running += value;
	});

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: colors.font },
		grid: baseGrid,
		legend: { show: false },
		tooltip: {
			...tooltip(ctx),
			formatter: (params: unknown) => {
				const list = Array.isArray(params) ? params : [params];
				const first = list[0] as {
					dataIndex: number;
					axisValue: string;
				};
				const value = values[first.dataIndex];
				const cumulative = values
					.slice(0, first.dataIndex + 1)
					.reduce((a, b) => a + b, 0);
				return `<div style="font-weight:600">${escapeHtml(first.axisValue)}</div>
					<div>Change: <b>${tipValue(value, hint)}</b></div>
					<div style="opacity:.75">Running total: ${tipValue(cumulative, hint)}</div>`;
			},
		},
		xAxis: categoryAxis(ctx, categories),
		yAxis: valueAxis(ctx, hint),
		series: [
			{
				name: "base",
				type: "bar",
				stack: "wf",
				stackStrategy: "all" as const,
				itemStyle: { color: "transparent" },
				emphasis: { itemStyle: { color: "transparent" } },
				data: base,
				silent: true,
			},
			{
				name: "Increase",
				type: "bar",
				stack: "wf",
				stackStrategy: "all" as const,
				itemStyle: {
					color: colors.positive,
					borderRadius: [2, 2, 0, 0],
				},
				data: rising,
			},
			{
				name: "Decrease",
				type: "bar",
				stack: "wf",
				stackStrategy: "all" as const,
				itemStyle: {
					color: colors.negative,
					borderRadius: [2, 2, 0, 0],
				},
				data: falling,
			},
		],
	};
}

// --- Choropleth --------------------------------------------------------------

// A figure by country, coloured on a map.
//
// The hard part is not the drawing, it is the matching. Boundary data spells
// several countries differently from every business system that has recorded
// one, and a map that silently drops what it cannot place is a map that lies by
// omission: the row it drops is usually one of the largest, and nothing on the
// page says a row is missing.
//
// So what did not match is counted and handed back with the option, and the
// visual says so under the map. Naming the unmatched values is the difference
// between a map somebody can fix and a map they have to trust.
export function buildChoropleth(
	ctx: ChartContext,
	known: Map<string, string>,
	// Each region's extent in degrees, for zooming onto a selected one. Left
	// out, the map stays at the whole world.
	boundsOf?: (name: string) => [number, number, number, number] | null,
) {
	const { rows, dimensions, measures, colors } = ctx;
	const field = dimensions[0];
	const measure = measures[0];
	const hint = ctx.hintFor(measure);

	const placed = new Map<string, number>();
	// The values in the data behind each region, so a click on the region
	// selects what the data calls it rather than what the boundary file does.
	const rawsFor = new Map<string, string[]>();
	const unmatched: string[] = [];

	for (const row of rows) {
		const raw = String(row[field] ?? "");
		if (raw === "") continue;

		const value = toNumber(row[measure]);
		if (value === null) continue;

		const country = matchCountry(raw, known);
		if (!country) {
			if (!unmatched.includes(raw)) unmatched.push(raw);
			continue;
		}

		// Two values landing on one country are added, which is what happens
		// when the data holds both a code and a name for the same place.
		placed.set(country, (placed.get(country) ?? 0) + value);
		const raws = rawsFor.get(country) ?? [];
		if (!raws.includes(raw)) raws.push(raw);
		rawsFor.set(country, raws);
	}

	const selection = activeSelection(ctx, placed.size);
	const chosen = selection
		? [...placed.keys()].filter((name) =>
				(rawsFor.get(name) ?? []).some((raw) =>
					matchesSelection(selection, { [field]: raw }),
				),
			)
		: [];

	// One selected region is zoomed onto, so a small country clicked on a
	// world map can be seen. Zoom is the share of the world the region spans,
	// halved to leave its neighbours in view, and capped so a very small
	// region is not blown up past recognition.
	const box = chosen.length === 1 ? boundsOf?.(chosen[0]) : null;
	const focus = box
		? {
				center: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
				zoom: Math.min(
					12,
					Math.max(
						1,
						Math.min(
							360 / Math.max(box[2] - box[0], 1),
							170 / Math.max(box[3] - box[1], 1),
						) / 2,
					),
				),
			}
		: {};

	const values = [...placed.values()];
	if (values.length === 0) {
		return { option: null, unmatched, matched: 0 };
	}

	const option = {
		animation: false,
		textStyle: { color: colors.text, fontFamily: colors.font },
		tooltip: {
			...tooltip(ctx),
			trigger: "item" as const,
			formatter: (params: unknown) => {
				const p = params as { name: string; value: number };
				// Every country is drawn, including the ones the data says
				// nothing about, so the tooltip has to tell the two apart.
				if (typeof p.value !== "number" || Number.isNaN(p.value)) {
					return `${escapeHtml(p.name)}<br/>No data`;
				}
				return `${escapeHtml(p.name)}<br/>${escapeHtml(measure)}: ${tipValue(p.value, hint)}`;
			},
		},
		visualMap: {
			min: Math.min(...values),
			max: Math.max(...values),
			calculable: true,
			orient: "horizontal" as const,
			left: "center" as const,
			bottom: 4,
			itemWidth: 12,
			itemHeight: 90,
			textStyle: { color: colors.textMuted, fontSize: 10 },
			inRange: {
				color: [
					withAlpha(colors.series[0], 0.15),
					withAlpha(colors.series[0], 0.55),
					colors.series[0],
				],
			},
		},
		series: [
			{
				type: "map" as const,
				map: worldMapName,
				roam: true,
				// The whole world by default. A report about one region can be
				// zoomed into, and the reader's own zoom is not something to
				// reset on every redraw.
				emphasis: {
					label: { show: false },
					itemStyle: { areaColor: withAlpha(colors.series[0], 0.85) },
				},
				itemStyle: {
					// The countries the data says nothing about, which is most
					// of them on most reports. Drawn, because a map with holes
					// in it is unreadable, but plainly not coloured.
					areaColor: colors.grid,
					borderColor: colors.grid,
					borderWidth: 0.5,
				},
				select: { disabled: true },
				...focus,
				data: [...placed.entries()].map(([name, value]) => {
					const raws = rawsFor.get(name) ?? [];
					const inside = !selection || chosen.includes(name);
					return {
						name,
						value,
						raws,
						// The selected region is outlined as well as left
						// solid, since a small country dimmed around is
						// otherwise hard to find.
						...(selection
							? {
									itemStyle: inside
										? {
												borderColor: colors.text,
												borderWidth: 1.5,
											}
										: { opacity: dimmedOpacity },
								}
							: {}),
					};
				}),
			},
		],
	};

	return { option, unmatched, matched: placed.size };
}

// --- Timeline ----------------------------------------------------------------

// Bars spanning a start and an end, one row per thing.
//
// For anything with a lifecycle: campaigns, projects, contract windows,
// outages. Nothing here could draw one, and the workaround is a table of two
// date columns that a reader has to hold in their head to compare.
//
// Built out of two stacked bars rather than a custom series: an invisible one
// up to the start, and a visible one the length of the span. That is the same
// picture, and it keeps another chart type out of the largest asset the client
// downloads.
//
// The axis carries milliseconds and is formatted back into dates, because a
// category axis would space every bar evenly whatever the real gaps between
// them are, and the gaps are half of what a timeline says.
export function buildTimeline(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	const [labelField, startField, endField] = dimensions;
	const measure = measures[0];

	const asTime = (value: unknown): number | null => {
		if (value === null || value === undefined || value === "") return null;
		const at = Date.parse(String(value));
		return Number.isFinite(at) ? at : null;
	};

	const bars = rows
		.map((row) => {
			const from = asTime(row[startField]);
			const to = asTime(row[endField]);
			// A span needs both ends. One of them missing is an open interval,
			// and drawing it to the edge of the chart would claim an end date
			// the data does not have.
			if (from === null || to === null) return null;
			return {
				label: String(row[labelField] ?? ""),
				opacity: highlightOpacity(ctx, row),
				from,
				to: Math.max(to, from),
				value: measure ? toNumber(row[measure]) : null,
			};
		})
		.filter((bar): bar is NonNullable<typeof bar> => bar !== null)
		// Earliest at the top, which is how a schedule is read.
		.sort((a, b) => a.from - b.from);

	if (bars.length === 0) return null;

	const day = 86400000;
	const asDate = (at: number) => new Date(at).toISOString().slice(0, 10);

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: colors.font },
		grid: { ...baseGrid, top: 12, left: 8 },
		legend: { show: false },
		tooltip: {
			...tooltip(ctx),
			trigger: "item" as const,
			formatter: (params: unknown) => {
				const p = params as { dataIndex: number };
				const bar = bars[p.dataIndex];
				if (!bar) return "";
				const days = Math.max(1, Math.round((bar.to - bar.from) / day));
				const lines = [
					`<strong>${escapeHtml(bar.label)}</strong>`,
					`${asDate(bar.from)} to ${asDate(bar.to)}`,
					days === 1 ? "1 day" : `${days} days`,
				];
				if (measure && bar.value !== null) {
					lines.push(
						`${escapeHtml(measure)}: ${tipValue(bar.value, ctx.hintFor(measure))}`,
					);
				}
				return lines.join("<br/>");
			},
		},
		xAxis: {
			type: "time" as const,
			axisLabel: { color: colors.axis, hideOverlap: true },
			splitLine: {
				show: ctx.style?.xAxis?.showGrid !== false,
				lineStyle: { color: colors.grid },
			},
		},
		yAxis: {
			type: "category" as const,
			data: bars.map((bar) => bar.label),
			// A category axis counts up from the bottom, which puts the
			// earliest thing at the foot of a schedule nobody reads that way.
			inverse: true,
			axisLabel: { color: colors.axis, hideOverlap: true },
			axisLine: { lineStyle: { color: colors.grid } },
			axisTick: { show: false },
		},
		series: [
			{
				// The run-up to the start, invisible. This is what floats the
				// visible bar to where the span actually begins.
				type: "bar" as const,
				stack: "span",
				silent: true,
				itemStyle: { color: "transparent" },
				data: bars.map((bar) => bar.from),
			},
			{
				type: "bar" as const,
				stack: "span",
				barWidth: "55%",
				itemStyle: {
					color: colors.series[0],
					borderRadius: 3,
				},
				// A span of zero has no width to draw, so a single day is
				// given one rather than disappearing.
				data: bars.map((bar) => {
					const span = Math.max(bar.to - bar.from, day / 2);
					return bar.opacity === undefined
						? span
						: { value: span, itemStyle: { opacity: bar.opacity } };
				}),
			},
		],
	};
}

// --- Calendar ----------------------------------------------------------------

// A year of daily figures, laid out as a calendar.
//
// The best single answer to "when is it busy". Weekly seasonality, month ends
// and public holidays all become visible without anybody modelling them, which
// is not true of the same series drawn as a line: a line with three hundred and
// sixty five points is a smear, and the weekday pattern that is obvious here is
// invisible in it.
//
// The date is read from the dimension rather than asked of the source, so any
// field holding a date works and none of them has to be marked as one.
export function buildCalendar(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	const dateField = dimensions[0];
	const measure = measures[0];
	const hint = ctx.hintFor(measure);

	const points: [string, number][] = [];
	for (const row of rows) {
		const raw = row[dateField];
		if (raw === null || raw === undefined || raw === "") continue;
		// The date part only. A timestamp and a date are the same day, and a
		// calendar has one cell for it.
		const day = String(raw).slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
		const value = toNumber(row[measure]);
		if (value === null) continue;
		points.push([day, value]);
	}

	// Nothing that reads as a date, so there is no calendar to draw. Said by
	// the empty state rather than by an empty grid of twelve months.
	if (points.length === 0) return null;

	// Days outside the selection are faded, and read by the same key a click
	// on a day selects, which is the plain date.
	const selection = activeSelection(ctx, points.length);
	const cells = points.map(([day, value]) => {
		const opacity = markOpacity(selection, { [dateField]: day });
		return opacity === undefined
			? [day, value]
			: { value: [day, value], itemStyle: { opacity } };
	});

	const days = points.map(([day]) => day).sort();
	const from = days[0];
	const to = days[days.length - 1];
	const values = points.map(([, value]) => value);

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: colors.font },
		tooltip: {
			...tooltip(ctx),
			trigger: "item" as const,
			formatter: (params: unknown) => {
				const p = params as { value: [string, number] };
				return `${escapeHtml(p.value[0])}<br/>${escapeHtml(measure)}: ${tipValue(p.value[1], hint)}`;
			},
		},
		visualMap: {
			min: Math.min(...values),
			max: Math.max(...values),
			calculable: false,
			orient: "horizontal" as const,
			left: "center" as const,
			bottom: 0,
			itemWidth: 10,
			itemHeight: 60,
			textStyle: { color: colors.textMuted, fontSize: 10 },
			inRange: {
				color: [
					withAlpha(colors.series[0], 0.12),
					withAlpha(colors.series[0], 0.55),
					colors.series[0],
				],
			},
		},
		calendar: {
			top: 30,
			left: 30,
			right: 12,
			bottom: 46,
			cellSize: ["auto", "auto"] as ["auto", "auto"],
			range: from === to ? from.slice(0, 7) : [from, to],
			itemStyle: {
				color: "transparent",
				borderColor: colors.grid,
				borderWidth: 1,
			},
			splitLine: { lineStyle: { color: colors.grid } },
			yearLabel: { show: false },
			monthLabel: { color: colors.axis, fontSize: 10 },
			dayLabel: {
				color: colors.axis,
				fontSize: 10,
				// Monday first, which is how a working week is read.
				firstDay: 1,
			},
		},
		series: [
			{
				type: "heatmap" as const,
				coordinateSystem: "calendar" as const,
				data: cells,
			},
		],
	};
}

// --- Sankey ------------------------------------------------------------------

// Flow between two sets of categories.
//
// The funnel covers a fixed sequence of stages and nothing covered a branching
// one: channel to region, status to next status, source to outcome. Two
// dimensions and a measure, which the query layer already returns.
export function buildSankey(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	const [fromField, toField] = dimensions;
	const measure = measures[0];
	const hint = ctx.hintFor(measure);

	// Both sides are prefixed, because a value appearing on the left and on the
	// right is two different nodes. Without this, "Open" as a starting status
	// and "Open" as an ending one become one node with a loop through it, and
	// the diagram will not lay out at all.
	const leftOf = (value: string) => `from ${value}`;
	const rightOf = (value: string) => `to ${value}`;

	const nodes = new Map<string, string>();
	const links = new Map<string, number>();
	// The row values behind each node and link, which is what a click on one
	// selects. The labels are text, and a date or a number read back out of a
	// label is not always the value the filter needs.
	const nodeRaw = new Map<string, { raw: unknown; side: 0 | 1 }>();
	const linkRaws = new Map<string, [unknown, unknown]>();

	for (const row of rows) {
		const value = toNumber(row[measure]);
		// A flow of nothing is not a flow, and a negative one has no width.
		if (value === null || value <= 0) continue;

		const left = String(row[fromField] ?? "");
		const right = String(row[toField] ?? "");
		if (left === "" || right === "") continue;

		nodes.set(leftOf(left), left);
		nodes.set(rightOf(right), right);
		nodeRaw.set(leftOf(left), { raw: row[fromField], side: 0 });
		nodeRaw.set(rightOf(right), { raw: row[toField], side: 1 });

		const key = `${leftOf(left)}\u001f${rightOf(right)}`;
		links.set(key, (links.get(key) ?? 0) + value);
		linkRaws.set(key, [row[fromField], row[toField]]);
	}

	if (links.size === 0) return null;

	// A link is selected when both of its ends match whatever the selection
	// says about them, and a node when a selected link touches it. So picking
	// a node keeps its flows and the nodes at their other ends, and picking a
	// flow keeps that flow and its two ends.
	const selection = activeSelection(ctx, Number.POSITIVE_INFINITY);
	const solidLinks = new Set<string>();
	const solidNodes = new Set<string>();
	if (selection) {
		for (const [key, [left, right]] of linkRaws) {
			if (
				matchesSelection(selection, {
					[fromField]: left,
					[toField]: right,
				})
			) {
				solidLinks.add(key);
				const [source, target] = key.split("\u001f");
				solidNodes.add(source);
				solidNodes.add(target);
			}
		}
	}

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: colors.font },
		tooltip: {
			...tooltip(ctx),
			trigger: "item" as const,
			formatter: (params: unknown) => {
				const p = params as {
					dataType: string;
					name: string;
					value: number;
					data: { source?: string; target?: string };
				};
				if (p.dataType === "edge") {
					const source = nodes.get(p.data.source ?? "") ?? "";
					const target = nodes.get(p.data.target ?? "") ?? "";
					return `${escapeHtml(source)} to ${escapeHtml(target)}<br/>${tipValue(p.value, hint)}`;
				}
				return `${escapeHtml(nodes.get(p.name) ?? p.name)}<br/>${tipValue(p.value, hint)}`;
			},
		},
		series: [
			{
				type: "sankey" as const,
				left: 8,
				right: 8,
				top: 12,
				bottom: 12,
				emphasis: { focus: "adjacency" as const },
				nodeGap: 10,
				nodeWidth: 12,
				label: {
					color: colors.text,
					fontSize: 11,
					// The prefix is bookkeeping, so the label shows the value
					// the reader recognises.
					formatter: (params: unknown) =>
						nodes.get((params as { name: string }).name) ?? "",
				},
				lineStyle: { color: "gradient", opacity: 0.4 },
				data: [...nodes.keys()].map((id) => ({
					name: id,
					raw: nodeRaw.get(id)?.raw,
					side: nodeRaw.get(id)?.side ?? 0,
					...(selection && !solidNodes.has(id)
						? { itemStyle: { opacity: dimmedOpacity } }
						: {}),
				})),
				links: [...links.entries()].map(([key, value]) => {
					const [source, target] = key.split("\u001f");
					return {
						source,
						target,
						value,
						raws: linkRaws.get(key),
						...(selection
							? {
									lineStyle: {
										opacity: solidLinks.has(key)
											? 0.6
											: 0.08,
									},
								}
							: {}),
					};
				}),
			},
		],
	};
}

// --- Histogram and box plot --------------------------------------------------

// The shape of a measure across whatever it is grouped by.
//
// Not a histogram of underlying records, because there are none to have. Every
// source here is a metric view: it carries its own semantic layer, measures are
// read through MEASURE(), and what comes back is aggregates. A bin expression in
// the GROUP BY would have been binning rows that do not exist.
//
// So the question this answers is the one that is actually available, and it is
// usually the one being asked anyway: how order value is distributed across
// customers, how margin is distributed across products. The dimension names the
// units and the measure is what is spread across them.
//
// The bins are counted by the warehouse over every value, and arrive already
// counted. Counting them here meant asking for the values, asking for values
// meant a row limit, and a row limit over ten million invoices was the first
// five hundred invoice numbers in alphabetical order.
//
// The range is trimmed to the first and ninety ninth percentile, and the two
// tails fold into the end bins. Equal bins over the full extent of money data
// put every value in one bar and left the other twenty nine empty.
export function buildHistogram(ctx: ChartContext) {
	const { rows, measures, colors } = ctx;
	const measure = measures[0];
	const hint = ctx.hintFor(measure);
	const c = distributionColumns;

	const bins = rows
		.map((row) => ({
			from: toNumber(row[c.binStart]),
			to: toNumber(row[c.binEnd]),
			count: toNumber(row[c.count]) ?? 0,
		}))
		.filter(
			(bin): bin is { from: number; to: number; count: number } =>
				bin.from !== null && bin.to !== null,
		);
	if (bins.length === 0) return null;

	const total = bins.reduce((sum, bin) => sum + bin.count, 0);

	// Labelled by where each bin starts. Both ends on every bar is unreadable
	// at any width a page gives a chart, and the next bar says where this one
	// stops.
	const categories = bins.map((bin) => formatCompact(bin.from, hint));

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: colors.font },
		grid: { ...baseGrid, top: axisNameTop },
		legend: { show: false },
		tooltip: {
			...tooltip(ctx),
			trigger: "axis" as const,
			axisPointer: { type: "shadow" as const },
			formatter: (params: unknown) => {
				const list = Array.isArray(params) ? params : [params];
				const first = list[0] as { dataIndex: number };
				const index = first.dataIndex;
				const bin = bins[index];
				if (!bin) return "";

				// The end bins hold their tail as well as their own range, so
				// they are named for what they actually contain.
				// A single bin is both ends at once and holds every value.
				const range =
					bins.length === 1
						? `${tipValue(bin.from, hint)} to ${tipValue(bin.to, hint)}`
						: index === 0
							? `Up to ${tipValue(bin.to, hint)}`
							: index === bins.length - 1
								? `${tipValue(bin.from, hint)} and above`
								: `${tipValue(bin.from, hint)} to ${tipValue(bin.to, hint)}`;

				const share = total > 0 ? (bin.count / total) * 100 : 0;
				return [
					range,
					`${bin.count.toLocaleString()} of ${total.toLocaleString()} (${share.toFixed(1)}%)`,
				].join("<br/>");
			},
		},
		xAxis: {
			type: "category" as const,
			data: categories,
			name: ctx.style?.xAxis?.label ?? measure,
			nameLocation: "middle" as const,
			nameGap: 28,
			nameTextStyle: { color: colors.textMuted },
			axisLabel: { color: colors.axis, hideOverlap: true },
			axisLine: { lineStyle: { color: colors.grid } },
			axisTick: { show: false },
		},
		yAxis: {
			type: "value" as const,
			...verticalAxisName(ctx, ctx.style?.yAxis?.label ?? "Count"),
			axisLabel: { color: colors.axis },
			splitLine: {
				show: ctx.style?.yAxis?.showGrid !== false,
				lineStyle: { color: colors.grid },
			},
		},
		series: [
			{
				type: "bar" as const,
				name: "Count",
				// Touching, because the bars are a continuous range rather
				// than separate categories, and a gap between them says
				// otherwise.
				barCategoryGap: "2%",
				itemStyle: { color: colors.series[0] },
				data: bins.map((bin) => bin.count),
			},
		],
	};
}

// Spread and outliers, one box per category.
//
// Two dimensions draws a box for each value of the first, with the spread taken
// across the second. One dimension draws a single box across it. The measure is
// what is being spread either way.
//
// The quartiles and the whiskers are computed by the warehouse over every
// value, so the box describes the whole population rather than whichever few
// hundred rows a limit happened to return. The outliers are counted rather than
// drawn: nine hundred thousand outlying orders cannot be plotted, and how many
// there are is the part that gets read.
export function buildBoxPlot(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	const measure = measures[0];
	const hint = ctx.hintFor(measure);
	const c = distributionColumns;

	// The grouping field, when there is one. With a single dimension the whole
	// set is one box, which is the honest reading of "the spread of this".
	const groupField = dimensions.length > 1 ? dimensions[0] : null;

	const boxes = rows
		.map((row) => ({
			label: groupField ? String(row[groupField] ?? "") : "All",
			opacity: groupField ? highlightOpacity(ctx, row) : undefined,
			count: toNumber(row[c.count]) ?? 0,
			outliers: toNumber(row[c.outliers]) ?? 0,
			five: [
				toNumber(row[c.lowerWhisker]),
				toNumber(row[c.lowerQuartile]),
				toNumber(row[c.median]),
				toNumber(row[c.upperQuartile]),
				toNumber(row[c.upperWhisker]),
			],
		}))
		// A group whose measure is null everywhere has no box to draw. Left
		// out rather than drawn flat at zero, which reads as a real answer.
		.filter((box) => box.five.every((v) => v !== null));
	if (boxes.length === 0) return null;

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: colors.font },
		grid: { ...baseGrid, top: axisNameTop },
		legend: { show: false },
		tooltip: {
			...tooltip(ctx),
			trigger: "item" as const,
			formatter: (params: unknown) => {
				const p = params as { dataIndex: number };
				const entry = boxes[p.dataIndex];
				if (!entry) return "";
				const [lo, q1, median, q3, hi] = entry.five as number[];
				const lines = [
					`<strong>${escapeHtml(entry.label)}</strong>`,
					`Highest inside: ${tipValue(hi, hint)}`,
					`Upper quartile: ${tipValue(q3, hint)}`,
					`Median: ${tipValue(median, hint)}`,
					`Lower quartile: ${tipValue(q1, hint)}`,
					`Lowest inside: ${tipValue(lo, hint)}`,
					`Across ${entry.count.toLocaleString()} values`,
				];
				if (entry.outliers > 0) {
					lines.push(
						`${entry.outliers.toLocaleString()} beyond the whiskers`,
					);
				}
				return lines.join("<br/>");
			},
		},
		xAxis: {
			type: "category" as const,
			data: boxes.map((entry) => entry.label),
			axisLabel: { color: colors.axis, hideOverlap: true },
			axisLine: { lineStyle: { color: colors.grid } },
			axisTick: { show: false },
		},
		yAxis: {
			type: "value" as const,
			...verticalAxisName(ctx, ctx.style?.yAxis?.label ?? measure),
			// Not forced through zero. The box is the whole chart, and
			// stretching the scale to the origin flattens it into a line.
			scale: true,
			axisLabel: {
				color: colors.axis,
				formatter: (v: number) => formatCompact(v, hint),
			},
			splitLine: {
				show: ctx.style?.yAxis?.showGrid !== false,
				lineStyle: { color: colors.grid },
			},
		},
		series: [
			{
				type: "boxplot" as const,
				// Bounded in pixels rather than as a share of the band. One
				// group means the band is the whole plot, and a box at half of
				// that was a rectangle the width of the chart.
				boxWidth: [10, 52],
				itemStyle: {
					color: withAlpha(colors.series[0], 0.35),
					borderColor: colors.series[0],
					borderWidth: 1.25,
				},
				data: boxes.map((entry) =>
					entry.opacity === undefined
						? entry.five
						: {
								value: entry.five,
								itemStyle: { opacity: entry.opacity },
							},
				),
			},
		],
	};
}

// --- Pareto ------------------------------------------------------------------

// Ranked bars with the cumulative share drawn over them.
//
// The standard answer to "which few things account for most of it", and the one
// chart here that could not be built at all until figures could be derived from
// an answer: the cumulative line is each row's share of the total accumulated
// down the rows, and no source models that.
//
// The eighty percent line is drawn by default and can be moved. It is what
// turns the curve into a reading: everything to the left of where the line
// meets it is the set worth acting on.
export function buildPareto(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	const labelField = dimensions[0];
	const measure = measures[0];
	const hint = ctx.hintFor(measure);

	const categories = rows.map((r) => String(r[labelField] ?? ""));
	const bars = rows.map((row) => ({
		value: toNumber(row[measure]),
		itemStyle: {
			color: colors.series[0],
			opacity: highlightOpacity(ctx, row),
			borderRadius: [2, 2, 0, 0] as [number, number, number, number],
		},
	}));
	const cumulative = rows.map((row) => toNumber(row[paretoCumulative]));

	const cut = Number(ctx.options?.cutoff);
	const threshold = Number.isFinite(cut) && cut > 0 && cut <= 100 ? cut : 80;

	const lineColor = colors.resolve({ token: "warning" }, colors.series[1]);

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: colors.font },
		grid: { ...baseGrid, top: 30 },
		legend: legend(ctx, true),
		tooltip: {
			...tooltip(ctx),
			trigger: "axis" as const,
			axisPointer: { type: "shadow" as const },
			formatter: (params: unknown) => {
				const list = Array.isArray(params) ? params : [params];
				const first = list[0] as { dataIndex: number };
				const row = rows[first.dataIndex];
				if (!row) return "";
				const share = toNumber(row[paretoCumulative]);
				return [
					`<strong>${escapeHtml(row[labelField])}</strong>`,
					`${escapeHtml(measure)}: ${tipValue(row[measure], hint)}`,
					share === null ? "" : `Running share: ${share.toFixed(1)}%`,
				]
					.filter(Boolean)
					.join("<br/>");
			},
		},
		xAxis: categoryAxis(ctx, categories),
		yAxis: [
			valueAxis(ctx, hint),
			{
				type: "value" as const,
				name: "Cumulative",
				// Fixed to the full range, because the curve's shape against
				// a hundred is the reading. Scaling it to the data would make
				// every Pareto look the same.
				min: 0,
				max: 100,
				axisLabel: {
					color: colors.axis,
					formatter: (v: number) => `${v}%`,
				},
				splitLine: { show: false },
			},
		],
		series: [
			{
				type: "bar" as const,
				name: measure,
				data: bars,
			},
			{
				type: "line" as const,
				name: "Cumulative share",
				yAxisIndex: 1,
				symbol: "circle",
				symbolSize: 5,
				lineStyle: { width: 2, color: lineColor },
				itemStyle: { color: lineColor },
				markLine: {
					silent: true,
					symbol: "none" as const,
					animation: false,
					data: [
						{
							yAxis: threshold,
							label: {
								show: true,
								position: "insideEndTop" as const,
								color: colors.textMuted,
								fontSize: 11,
								formatter: `${threshold}%`,
							},
							lineStyle: {
								color: colors.axis,
								type: "dashed" as const,
								width: 1.5,
							},
						},
					],
				},
				data: cumulative,
			},
		],
	};
}

// --- Slope -------------------------------------------------------------------

// Two points per category, joined by a line.
//
// The clearest way to show a set of changes at once. Paired bars make a reader
// compare eight lengths in four pairs and work out which pairs moved; a slope
// chart makes the movement the mark, so an eye reads the whole set at a glance
// and the crossings are the story.
//
// Drawn as one series per category rather than two series of points, because
// the line between a category's two values is the thing being read and ECharts
// only joins points that belong to the same series.
export function buildSlope(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	const labelField = dimensions[0];
	const measure = measures[0];
	const hint = ctx.hintFor(measure);
	const earlier = ctx.comparisonRows;

	// No comparison, so there is no slope to draw. Said by the chart rather
	// than drawn as a flat line, which would read as "nothing changed".
	if (!earlier) return null;

	const before = new Map(
		earlier.map((row) => [
			String(row[labelField] ?? ""),
			toNumber(row[measure]),
		]),
	);

	const pairs = rows
		.map((row) => {
			const label = String(row[labelField] ?? "");
			const now = toNumber(row[measure]);
			const then = before.get(label) ?? null;
			// A category present in one window and not the other has no slope.
			// Drawing it from zero would invent an arrival or a disappearance
			// that the data does not report.
			if (now === null || then === null) return null;
			return { label, then, now };
		})
		.filter((pair): pair is NonNullable<typeof pair> => pair !== null);

	const up = colors.resolve({ token: "success" }, colors.series[0]);
	const down = colors.resolve({ token: "danger" }, colors.series[1]);

	// Each line is one category, so a selected category keeps its line and
	// the others fade.
	const selection = activeSelection(ctx, pairs.length);

	const series = pairs.map((pair) => ({
		type: "line" as const,
		name: pair.label,
		symbol: "circle",
		symbolSize: 7,
		// Rising and falling read differently at a glance, which is the whole
		// point of the shape.
		itemStyle: {
			color: pair.now >= pair.then ? up : down,
			opacity: markOpacity(selection, { [labelField]: pair.label }),
		},
		lineStyle: {
			width: 1.75,
			color: pair.now >= pair.then ? up : down,
			opacity: markOpacity(selection, { [labelField]: pair.label }),
		},
		// Only the right-hand end is labelled. Both ends doubles the ink for
		// one extra column of names, and the left is already an axis.
		endLabel: {
			show: true,
			color: colors.textMuted,
			fontSize: 11,
			// A function, because a string formatter is a template and a label
			// holding braces would be read as a placeholder.
			formatter: () => pair.label,
		},
		emphasis: { focus: "series" as const },
		data: [pair.then, pair.now],
	}));

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: colors.font },
		// Room on the right for the end labels, which sit outside the plot.
		grid: {
			...baseGrid,
			top: Math.max(20, ctx.style?.yAxis?.label ? axisNameTop : 0),
			right: 96,
		},
		legend: { show: false },
		tooltip: {
			...tooltip(ctx),
			trigger: "item" as const,
			formatter: (params: unknown) => {
				const p = params as { seriesName: string };
				const pair = pairs.find((x) => x.label === p.seriesName);
				if (!pair) return "";
				const change =
					pair.then === 0
						? null
						: (pair.now - pair.then) / Math.abs(pair.then);
				return [
					`<strong>${escapeHtml(pair.label)}</strong>`,
					`Before: ${tipValue(pair.then, hint)}`,
					`After: ${tipValue(pair.now, hint)}`,
					change === null
						? "No change to report against zero"
						: `Change: ${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`,
				].join("<br/>");
			},
		},
		xAxis: {
			type: "category" as const,
			// Two positions and nothing between them, so the axis is drawn
			// tight to the ends rather than with a category's usual padding.
			boundaryGap: false,
			data: ["Before", "After"],
			axisLabel: { color: colors.axis },
			axisLine: { lineStyle: { color: colors.grid } },
			axisTick: { show: false },
			splitLine: { show: true, lineStyle: { color: colors.grid } },
		},
		yAxis: {
			type: "value" as const,
			...verticalAxisName(ctx, ctx.style?.yAxis?.label),
			scale: ctx.style?.yAxis?.beginAtZero === false,
			axisLabel: {
				color: colors.axis,
				formatter: (v: number) => formatCompact(v, hint),
			},
			splitLine: { show: false },
		},
		series,
	};
}

// --- Bullet ------------------------------------------------------------------

// Actual against target, one row per category.
//
// The gauge answers this for a single figure and eats a tile doing it. Most of
// the time the question is asked about several things at once, and a stack of
// gauges is unreadable: they cannot be compared to each other, only each to its
// own dial.
//
// Drawn as a bar against a tick, which is Few's bullet without the qualitative
// bands. The bands are left out deliberately: they need three more thresholds
// per row that nobody has, and without real ones they become decoration that
// implies a judgement the data does not carry.
export function buildBullet(ctx: ChartContext) {
	const { dimensions, measures, colors } = ctx;
	const [actualField, targetField] = measures;
	const labelField = dimensions[0];
	const hint = ctx.hintFor(actualField);

	// Sorted on the gap rather than on the actual, because "furthest behind"
	// is the question this chart is asked, and the largest shortfall is not
	// the smallest number.
	const shortfall = (row: Record<string, unknown>): number => {
		const actual = toNumber(row[actualField]) ?? 0;
		const target = toNumber(row[targetField]);
		if (target === null || target === 0) return 0;
		return actual / target;
	};

	const by = ctx.options?.sortBy;
	const rows =
		by === "valueDesc" || by === "valueAsc"
			? [...ctx.rows].sort(
					(a, b) =>
						(by === "valueDesc" ? -1 : 1) *
						(shortfall(a) - shortfall(b)),
				)
			: ctx.rows;

	const categories = rows.map((r) => String(r[labelField] ?? ""));
	const colourByTarget = ctx.options?.colourByTarget !== false;

	// Read from the row the bar draws rather than by position, because the
	// rows are sorted here and the positions no longer match the query's.
	const bars = rows.map((row) => {
		const actual = toNumber(row[actualField]);
		const target = toNumber(row[targetField]);
		const met = actual !== null && target !== null && actual >= target;

		return {
			value: actual,
			itemStyle: {
				color: colourByTarget
					? met
						? colors.resolve({ token: "success" }, colors.series[0])
						: colors.resolve({ token: "warning" }, colors.series[0])
					: colors.series[0],
				opacity: highlightOpacity(ctx, row),
				borderRadius: 2,
			},
		};
	});

	const targets = rows.map((row) => toNumber(row[targetField]));
	const targetOpacity = rows.map((row) => highlightOpacity(ctx, row));

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: colors.font },
		grid: { ...baseGrid, top: 12, bottom: 8 },
		tooltip: {
			...tooltip(ctx),
			formatter: (params: unknown) => {
				const list = Array.isArray(params) ? params : [params];
				const first = list[0] as { dataIndex: number };
				const row = rows[first.dataIndex];
				if (!row) return "";

				const actual = toNumber(row[actualField]);
				const target = toNumber(row[targetField]);
				const lines = [
					`<strong>${escapeHtml(row[labelField])}</strong>`,
					`${escapeHtml(actualField)}: ${tipValue(actual, hint)}`,
					`${escapeHtml(targetField)}: ${tipValue(target, ctx.hintFor(targetField))}`,
				];
				// The share of target is the number the chart is actually
				// about, and it is the one nobody can read off a bar.
				if (actual !== null && target !== null && target !== 0) {
					lines.push(
						`Against target: ${Math.round((actual / target) * 100)}%`,
					);
				}
				return lines.join("<br/>");
			},
		},
		xAxis: {
			type: "value" as const,
			name: ctx.style?.xAxis?.label,
			axisLabel: {
				color: colors.axis,
				formatter: (v: number) => formatCompact(v, hint),
			},
			splitLine: {
				show: ctx.style?.xAxis?.showGrid !== false,
				lineStyle: { color: colors.grid },
			},
		},
		yAxis: {
			type: "category" as const,
			data: categories,
			// Reversed so the first row is at the top. A category axis counts
			// up from the bottom, which puts a list in the order nobody wrote
			// it in.
			inverse: true,
			axisLabel: { color: colors.axis, hideOverlap: true },
			axisLine: { lineStyle: { color: colors.grid } },
			axisTick: { show: false },
		},
		series: [
			{
				type: "bar" as const,
				name: actualField,
				barWidth: 14,
				data: bars,
			},
			{
				// The target, drawn as the tick a bullet chart uses rather
				// than as a second bar. A second bar invites the two to be
				// compared as quantities of the same thing, when one of them
				// is the line the other is being judged against.
				type: "scatter" as const,
				name: targetField,
				symbol: "rect",
				symbolSize: [3, 24],
				itemStyle: { color: colors.text },
				// Named by category, so a click on the tick selects the same
				// thing a click on its bar does.
				data: targets.map((value, index) =>
					value === null
						? null
						: {
								value: [value, index],
								name: categories[index],
								...(targetOpacity[index] === undefined
									? {}
									: {
											itemStyle: {
												opacity: targetOpacity[index],
											},
										}),
							},
				),
			},
		],
	};
}

// --- Scatter -----------------------------------------------------------------

// Two measures plotted against each other, which is the question the
// relationship category exists to answer.
//
// This used to go through the cartesian builder, which puts the dimension on a
// category axis and draws each measure as its own series of dots. That is a dot
// chart. It cannot show correlation, which is what the catalogue told authors it
// was for, and the third measure it accepted was drawn at a fixed size.
//
// So: the first measure is the horizontal position, the second is the vertical,
// and a third sizes the point, which is a bubble chart for free. The dimension
// names each point rather than positioning it, and is what the tooltip reads.
//
// One measure still draws the old shape. Reports authored before this expect
// it, and a chart that silently became empty on deploy would be worse than the
// one that was merely mislabelled.
export function buildScatter(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;
	if (measures.length < 2) return buildCartesian(ctx, "scatter");

	const [xField, yField, sizeField] = measures;
	const labelField = dimensions[0];
	const xHint = ctx.hintFor(xField);
	const yHint = ctx.hintFor(yField);

	const sizes = sizeField
		? rows
				.map((r) => toNumber(r[sizeField]))
				.filter((n): n is number => n !== null)
		: [];
	const sizeMax = sizes.length > 0 ? Math.max(...sizes) : 0;

	// Area rather than radius, because a point twice as wide reads as four
	// times the value and that is how a bubble chart misleads.
	const minRadius = 5;
	const maxRadius = 26;
	const radiusFor = (value: number | null): number => {
		if (value === null || sizeMax <= 0) return 9;
		const share = Math.max(0, value) / sizeMax;
		return (
			minRadius + (maxRadius - minRadius) * Math.sqrt(Math.min(1, share))
		);
	};

	// Author bounds win. Trimming is what to do when nobody has said, not a
	// second opinion about what somebody did say.
	const asked = ctx.options?.trimAxes !== false;
	const xBounds =
		asked &&
		ctx.style?.xAxis?.min === undefined &&
		ctx.style?.xAxis?.max === undefined
			? trimmedBounds(rows.map((r) => toNumber(r[xField]) ?? Number.NaN))
			: null;
	const yBounds =
		asked &&
		ctx.style?.yAxis?.min === undefined &&
		ctx.style?.yAxis?.max === undefined
			? trimmedBounds(rows.map((r) => toNumber(r[yField]) ?? Number.NaN))
			: null;

	const points = rows
		.map((row) => {
			const x = toNumber(row[xField]);
			const y = toNumber(row[yField]);
			// A point missing either coordinate has no position, so it is left
			// out rather than pinned to an axis it does not sit on.
			if (x === null || y === null) return null;
			const size = sizeField ? toNumber(row[sizeField]) : null;
			const opacity = highlightOpacity(ctx, row);
			return {
				value: [x, y, size ?? 0],
				name: labelField ? String(row[labelField] ?? "") : "",
				symbolSize: radiusFor(size),
				// Solid rather than the cloud's usual translucency, so the
				// selected point stands out from the ones overlapping it.
				...(opacity === undefined
					? {}
					: { itemStyle: { opacity: opacity === 1 ? 1 : 0.12 } }),
			};
		})
		.filter((point): point is NonNullable<typeof point> => point !== null);

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: colors.font },
		grid: {
			...baseGrid,
			top: axisNameTop,
			bottom: ctx.options?.zoomSlider === true ? 34 : baseGrid.bottom,
		},
		dataZoom: zoomWindow(ctx, 0),
		tooltip: {
			...tooltip(ctx),
			// Per point, like every other chart whose tooltip reads one mark.
			// An axis pointer gathers everything at one position along an
			// axis, which on two value axes is a set rather than a point: the
			// formatter was handed the whole array and read a value off it
			// that was not there.
			trigger: "item" as const,
			formatter: (params: unknown) => {
				const p = params as {
					name: string;
					value: [number, number, number];
				};
				const lines = [
					`${escapeHtml(xField)}: ${tipValue(p.value[0], xHint)}`,
					`${escapeHtml(yField)}: ${tipValue(p.value[1], yHint)}`,
				];
				if (sizeField) {
					lines.push(
						`${escapeHtml(sizeField)}: ${tipValue(p.value[2], ctx.hintFor(sizeField))}`,
					);
				}
				const head = p.name
					? `<strong>${escapeHtml(p.name)}</strong><br/>`
					: "";
				return head + lines.join("<br/>");
			},
		},
		xAxis: {
			type: "value" as const,
			name: ctx.style?.xAxis?.label ?? xField,
			nameLocation: "middle" as const,
			nameGap: 26,
			nameTextStyle: { color: colors.textMuted },
			// Both scales carry data rather than categories, so neither is
			// forced through zero: a cloud of points between 90 and 110 is the
			// whole chart, and stretching the axis to the origin flattens it
			// into a dot.
			scale: ctx.style?.xAxis?.beginAtZero !== true,
			min: ctx.style?.xAxis?.min ?? xBounds?.min,
			max: ctx.style?.xAxis?.max ?? xBounds?.max,
			axisLabel: {
				color: colors.axis,
				formatter: (v: number) => formatCompact(v, xHint),
			},
			splitLine: {
				show: ctx.style?.xAxis?.showGrid !== false,
				lineStyle: { color: colors.grid },
			},
		},
		yAxis: {
			type: "value" as const,
			...verticalAxisName(ctx, ctx.style?.yAxis?.label ?? yField),
			scale: ctx.style?.yAxis?.beginAtZero !== true,
			min: ctx.style?.yAxis?.min ?? yBounds?.min,
			max: ctx.style?.yAxis?.max ?? yBounds?.max,
			axisLabel: {
				color: colors.axis,
				formatter: (v: number) => formatCompact(v, yHint),
			},
			splitLine: {
				show: ctx.style?.yAxis?.showGrid !== false,
				lineStyle: { color: colors.grid },
			},
		},
		series: [
			{
				type: "scatter" as const,
				name: yField,
				itemStyle: {
					color: colors.series[0],
					opacity: 0.75,
					borderColor: colors.surface,
					borderWidth: 1,
				},
				markLine: referenceMarkLine(ctx),
				data: points,
			},
		],
	};
}

// --- Heatmap ---------------------------------------------------------------

export function buildHeatmap(ctx: ChartContext) {
	const { rows, dimensions, measures, colors, style } = ctx;
	const [rowField, colField] = dimensions;
	const measure = measures[0];
	const hint = ctx.hintFor(measure);

	const rowValues = Array.from(
		new Set(rows.map((r) => String(r[rowField] ?? ""))),
	);
	const colValues = Array.from(
		new Set(rows.map((r) => String(r[colField] ?? ""))),
	);

	const data: {
		value: [number, number, number];
		raws: [unknown, unknown];
		itemStyle?: { opacity: number };
	}[] = [];
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;

	// A cell is one row value and one column value, and carries both so a
	// click reads them back without going through the axis labels.
	const selection = activeSelection(ctx, Number.POSITIVE_INFINITY);

	// Positions by value, so placing a cell is a lookup rather than a scan of
	// every distinct value.
	const colIndex = new Map(colValues.map((value, i) => [value, i]));
	const rowIndex = new Map(rowValues.map((value, i) => [value, i]));

	for (const row of rows) {
		const x = colIndex.get(String(row[colField] ?? "")) ?? -1;
		const y = rowIndex.get(String(row[rowField] ?? "")) ?? -1;
		const value = toNumber(row[measure]) ?? 0;
		if (x < 0 || y < 0) continue;
		const opacity = markOpacity(selection, row);
		data.push({
			value: [x, y, value],
			raws: [row[rowField], row[colField]],
			...(opacity === undefined ? {} : { itemStyle: { opacity } }),
		});
		if (value < min) min = value;
		if (value > max) max = value;
	}

	const scale = style?.colorScales?.[0];
	const low = colors.resolve(scale?.low, colors.surface);
	const high = colors.resolve(scale?.high, colors.series[0]);

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: colors.font },
		grid: { left: 8, right: 8, top: 8, bottom: 60, containLabel: true },
		tooltip: {
			...tooltip(ctx, "item"),
			formatter: (p: unknown) => {
				const e = p as { value: [number, number, number] };
				return `${escapeHtml(rowValues[e.value[1]])} / ${escapeHtml(colValues[e.value[0]])}<br/><b>${tipValue(
					e.value[2],
					hint,
				)}</b>`;
			},
		},
		xAxis: {
			type: "category" as const,
			data: colValues,
			axisLabel: { color: colors.axis, hideOverlap: true, rotate: 30 },
			splitArea: { show: true },
		},
		yAxis: {
			type: "category" as const,
			data: rowValues,
			axisLabel: { color: colors.axis },
			splitArea: { show: true },
		},
		visualMap: {
			min: Number.isFinite(min) ? min : 0,
			max: Number.isFinite(max) ? max : 1,
			calculable: false,
			orient: "horizontal",
			left: "center",
			bottom: 0,
			textStyle: { color: colors.textMuted },
			inRange: { color: [low, high] },
			formatter: (v: number) => formatCompact(v, hint),
		},
		series: [
			{
				type: "heatmap",
				data,
				label: { show: rowValues.length * colValues.length <= 80 },
				itemStyle: { borderColor: colors.surface, borderWidth: 1 },
			},
		],
	};
}

// --- Radar -----------------------------------------------------------------

export function buildRadar(ctx: ChartContext) {
	const { rows, dimensions, measures, colors } = ctx;

	// Each measure becomes an axis, normalised to its own maximum so measures
	// on different scales remain comparable in shape.
	const maxima = measures.map((m) =>
		Math.max(...rows.map((r) => Math.abs(toNumber(r[m]) ?? 0)), 1),
	);

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: colors.font },
		legend: legend(ctx, true),
		tooltip: tooltip(ctx, "item"),
		radar: {
			indicator: measures.map((m, i) => ({ name: m, max: maxima[i] })),
			axisName: { color: colors.textMuted, fontSize: 11 },
			splitLine: { lineStyle: { color: colors.grid } },
			splitArea: { show: false },
			axisLine: { lineStyle: { color: colors.grid } },
		},
		series: [
			{
				type: "radar",
				data: rows.slice(0, 6).map((row, i) => {
					const color = colors.series[i % colors.series.length];
					// A shape outside the selection keeps a faint outline
					// and loses its fill, so the selected one is the shape
					// read.
					const opacity = highlightOpacity(ctx, row);
					const faded = opacity !== undefined && opacity < 1;
					return {
						name: String(row[dimensions[0]] ?? ""),
						value: measures.map((m) => toNumber(row[m]) ?? 0),
						lineStyle: { color, ...(faded ? { opacity } : {}) },
						itemStyle: { color, ...(faded ? { opacity } : {}) },
						areaStyle: {
							color: withAlpha(color, faded ? 0.03 : 0.15),
						},
					};
				}),
			},
		],
	};
}
