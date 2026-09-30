"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import * as echarts from "echarts/core";
import {
	BarChart,
	BoxplotChart,
	LineChart,
	ScatterChart,
	PieChart,
	TreemapChart,
	FunnelChart,
	GaugeChart,
	HeatmapChart,
	RadarChart,
	SankeyChart,
	MapChart,
} from "echarts/charts";
import {
	GridComponent,
	LegendComponent,
	TooltipComponent,
	DataZoomComponent,
	VisualMapComponent,
	MarkLineComponent,
	BrushComponent,
	ToolboxComponent,
	CalendarComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useTheme } from "../context/ThemeContext";
import { useVisualQuery } from "../hooks/useVisualQuery";
import {
	distributionColumns,
	queryForVisual,
} from "../../lib/query/visualSpec";
import type { QueryTransform } from "../../lib/query/transform";
import {
	shiftDateFilters,
	type ComparePeriod,
	type DateClause,
} from "../../lib/query/compare";
import {
	blankLabel,
	formatDate,
	formatValue,
	type FormatHint,
} from "../../lib/format";
import { describeChart } from "../../lib/visuals/chartSummary";
import { matchCountry } from "../../lib/visuals/countryNames";
import { checkEncoding } from "../../lib/visuals/catalog";
import {
	describeForecast,
	forecastRows,
	localToday,
	looksAdditive,
} from "../../lib/visuals/forecast";
import { indicesToValues, rangeToIndices } from "../../lib/visuals/brush";
import {
	keyboardMarks,
	stepMark,
	type KeyMark,
} from "../../lib/visuals/chartKeys";
import {
	canSelect,
	describeValue,
	selectionFromClick,
	selectionValue,
	type MarkClick,
	type SelectionPart,
} from "../../lib/visuals/selection";
import type { VisualStyle } from "../../lib/visuals/style";
import { readThemeColors } from "./colors";
import { ensureWorldMap, regionBounds } from "./worldMap";
import {
	buildBoxPlot,
	buildBullet,
	buildCalendar,
	buildCartesian,
	buildChoropleth,
	buildHistogram,
	buildFunnel,
	buildGauge,
	buildHeatmap,
	buildPareto,
	buildPie,
	buildRadar,
	buildSankey,
	buildScatter,
	buildSlope,
	buildTimeline,
	buildTreemap,
	buildWaterfall,
	forecastSeriesPrefix,
	type ChartContext,
} from "./chartOptions";
import { VisualEmpty, VisualError, VisualLoading } from "./VisualFrame";
import type { FieldMeta } from "./types";
import styles from "./Visual.module.css";

// Loaded when somebody asks, since every time series carries the way in and
// few are followed.
const ExplainDialog = dynamic(
	() => import("../explain/ExplainDialog").then((m) => m.ExplainDialog),
	{ ssr: false },
);

// Charts drawn across a category axis, where a point on a date axis is one
// period and the point before it is the period before.
const periodCharts = new Set([
	"barChart",
	"lineChart",
	"areaChart",
	"comboChart",
	"stackedBarChart",
]);

// Charts that can carry a forecast past their last period, when their first
// dimension is a date.
const forecastCharts = new Set([
	"barChart",
	"lineChart",
	"areaChart",
	"comboChart",
]);

// Charts whose marks are each one value of a dimension, such as a bar for a
// region or a slice for a channel. A mark's change is read against the period
// before the page's date range.
const memberCharts = new Set([
	...periodCharts,
	"horizontalBarChart",
	"pieChart",
	"donutChart",
	"treemapChart",
	"funnelChart",
	"paretoChart",
]);

// A mark clicked on a chart, and the two questions whose difference is its
// change.
interface Pointed {
	label: string;
	measure: string;
	current: unknown[];
	previous: unknown[];
	// The earlier side in words, such as "12/01/2025" or "the period before".
	against: string;
}

// Only the chart types in use are registered, so the bundle carries those
// rather than all of ECharts. Canvas rendering is chosen over SVG because a
// chart here can carry thousands of points and SVG puts a DOM node behind
// every one of them.
echarts.use([
	BarChart,
	// The five number summary arrives from the warehouse, and this draws it.
	// A pair of stacked bars used to stand in for a box, which cost nothing in
	// bundle size and could not size itself against the band, could not draw
	// whisker caps, and stacked wrongly the moment a quartile went negative.
	BoxplotChart,
	LineChart,
	ScatterChart,
	PieChart,
	TreemapChart,
	FunnelChart,
	GaugeChart,
	HeatmapChart,
	RadarChart,
	SankeyChart,
	MapChart,
	GridComponent,
	LegendComponent,
	TooltipComponent,
	DataZoomComponent,
	VisualMapComponent,
	MarkLineComponent,
	BrushComponent,
	ToolboxComponent,
	CalendarComponent,
	CanvasRenderer,
]);

// Columns of a summarised answer that hold a value of the measure, so they are
// formatted the way the measure is rather than as a bare number. Count and the
// outlier tally are counts of rows and stay plain.
const summaryValueColumns = new Set<string>([
	distributionColumns.lowerWhisker,
	distributionColumns.lowerQuartile,
	distributionColumns.median,
	distributionColumns.upperQuartile,
	distributionColumns.upperWhisker,
	distributionColumns.binStart,
	distributionColumns.binEnd,
]);

// The dimension values a clicked mark stands for, outermost first. Usually one
// field, and two for a mark that sits at a pair of values such as a heatmap
// cell, a stacked segment or a flow between two nodes.
export type ChartSelection = SelectionPart[];

// Types drawn as a continuous line, where the points can be hidden and a click
// anywhere in a period's column picks that period.
const columnPickCharts = new Set(["lineChart", "areaChart"]);

// How far the pointer can travel between press and release and still count as
// a click. Further than this was a drag, such as a brushed range or a panned
// map, and the release is not a choice of mark.
const clickSlop = 4;

// Draws one mark as hovered, with its tooltip, or clears both. The library's
// own hover state, so it looks the same as a pointer resting on the mark.
function paintFocus(chart: echarts.ECharts, mark: KeyMark | undefined): void {
	chart.dispatchAction({ type: "downplay" });
	if (!mark) {
		chart.dispatchAction({ type: "hideTip" });
		return;
	}
	const target = {
		seriesIndex: mark.seriesIndex,
		dataIndex: mark.dataIndex,
		name: mark.name,
	};
	chart.dispatchAction({ type: "highlight", ...target });
	chart.dispatchAction({ type: "showTip", ...target });
}

interface ChartProps {
	visualType: string;
	sourceKey: string;
	dimensions: string[];
	measures: string[];
	filters?: unknown[];
	// Left unset for a placed visual, so the default comes from
	// lib/query/visualSpec by chart type, the same one the server warms with.
	limit?: number;
	// Figures worked out from the answer, declared on the visual. Part of the
	// query rather than applied to the marks, so the derived columns arrive
	// inside the cached payload and the warm path asks for the same thing.
	transforms?: QueryTransform[];
	// What to compare against, and the date the page's range filter sits on.
	//
	// Resolved by the renderer rather than read out of the options here,
	// because the field falls back to the source's own default time field and
	// only the renderer can see the source.
	compareTo?: ComparePeriod | null;
	compareField?: string | null;
	fields: Map<string, FieldMeta>;
	// A number, or "100%" when an enclosing layout has already decided. The
	// canvas is redrawn by a resize observer either way.
	height?: number | string;
	style?: VisualStyle;
	// Settings declared for this visual type in the catalogue. Passed
	// straight through to the builders rather than unpacked here, because
	// which of them a type honours is a property of the builder.
	options?: Record<string, unknown>;
	// Fires when a reader clicks a mark. The page decides whether that means
	// cross-filter or drill down, because the same click means different
	// things depending on how the visual was configured.
	onSelect?: (selection: ChartSelection) => void;
	// The page selection this chart made. Highlighted rather than filtered, so
	// the clicked chart still shows the whole picture with the selection
	// standing out and everything else dimmed.
	selection?: SelectionPart[];
	// Fires when a reader clicks the chart away from any mark, which is how a
	// selection made here is let go of without finding the chip that shows it.
	onClearSelection?: () => void;
	// Fires when a reader drags across the chart to select a range. Separate
	// from onSelect because a range is a different intent from a single
	// category: it means "these ones", not "this one".
	onSelectRange?: (field: string, values: string[]) => void;
	// Where to leave a way of reading the drawn chart back as an image.
	//
	// A ref rather than a callback that stores the getter, because the getter
	// reads the chart instance at the moment it is called and depends on
	// nothing else. Storing it made every redraw a state update, a state
	// update is a render, and a render rebuilt the option the effect was keyed
	// on, so the two chased each other until React gave up.
	//
	// Given out by the chart rather than taken from the DOM, because the
	// canvas belongs to the renderer and reaching for it would break the
	// moment that changed.
	imageRef?: React.MutableRefObject<(() => string | null) | null>;
	// Only read for the spoken description, so a reader who cannot see the
	// chart is told which one it is.
	title?: string | null;
}

export function Chart({
	visualType,
	sourceKey,
	dimensions,
	measures,
	filters,
	limit,
	transforms,
	compareTo,
	compareField,
	fields,
	height = 300,
	style,
	options,
	onSelect,
	selection,
	onClearSelection,
	onSelectRange,
	imageRef,
	title,
}: ChartProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	// The element the chart draws into, held in state as well as the ref so
	// the drawing effect runs again when a new one mounts.
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const chartRef = useRef<echarts.ECharts | null>(null);
	const { resolved } = useTheme();

	// The catalogue says what this type needs, so an under-configured visual
	// can say what it is waiting for instead of rendering an empty frame.
	const problem = checkEncoding(visualType, dimensions, measures);
	const ready = problem === null;

	// Shaped by lib/query/visualSpec, which is also what the server warms
	// against. Two spellings of the same query are two cache keys, and the warm
	// one would be the key nobody asks for.
	const {
		rows,
		columns: answered,
		error,
		isLoading,
	} = useVisualQuery(
		ready
			? queryForVisual(visualType, {
					sourceKey,
					dimensions,
					measures,
					filters,
					limit,
					options,
					transforms,
				})
			: null,
	);

	// The same question about an earlier window, for the types that draw a
	// comparison rather than a single period.
	//
	// The shifted filters are an ordinary spec, so this shares the batcher, the
	// cache and the warm path with everything else the page asks for. Null
	// whenever there is no date window on the page to move, which leaves the
	// chart to say it has nothing to compare against rather than drawing a
	// change of zero.
	//
	// Keyed on the serialised filters rather than the array. The page rebuilds
	// that array on every render, so keying on its identity would hand back a
	// new window every time and rebuild the chart with it.
	const filterKey = JSON.stringify(filters ?? []);
	const comparisonFilters = useMemo(() => {
		if (!compareTo || !compareField) return null;
		return shiftDateFilters(
			(filters ?? []) as DateClause[],
			compareField,
			compareTo,
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [compareTo, compareField, filterKey]);

	// A map needs its boundaries before it can be drawn, and they are four
	// hundred kilobytes fetched only when a map is actually on a page. Held in
	// state rather than awaited inside the option, because building the option
	// is synchronous and the fetch is not.
	const isMap = visualType === "choroplethChart";
	const [countries, setCountries] = useState<Map<string, string> | null>(
		null,
	);
	const [mapFailed, setMapFailed] = useState(false);

	useEffect(() => {
		if (!isMap) return;
		let live = true;
		void ensureWorldMap()
			.then((names) => {
				if (live) setCountries(names);
			})
			.catch(() => {
				if (live) setMapFailed(true);
			});
		return () => {
			live = false;
		};
	}, [isMap]);

	// What the map could not place.
	//
	// Derived rather than read back out of the builder, because a ref set
	// during render does not re-render and the whole point of this is that the
	// reader is told. A map that silently drops what it cannot match is a map
	// that lies by omission, and the row it drops is usually a large one.
	const unmatched = useMemo(() => {
		if (!isMap || !countries) return [];
		const field = dimensions[0];
		const out: string[] = [];
		for (const row of rows) {
			const raw = String(row[field] ?? "");
			if (raw === "" || out.includes(raw)) continue;
			if (!matchCountry(raw, countries)) out.push(raw);
		}
		return out;
	}, [isMap, countries, rows, dimensions]);

	// Types whose whole shape is a comparison, so an absent one is worth
	// explaining rather than leaving as a blank frame.
	const comparisonNeeded = visualType === "slopeChart";

	const comparison = useVisualQuery(
		ready && comparisonFilters
			? queryForVisual(visualType, {
					sourceKey,
					dimensions,
					measures,
					filters: comparisonFilters,
					limit,
					options,
					transforms,
				})
			: null,
	);

	// The callbacks and the data the handlers need, read at call time.
	//
	// The page hands this component a new arrow function on every render. When
	// those were dependencies of the effect that builds the chart, the chart
	// was torn down and rebuilt on every render, and a rebuild clears the
	// brush. So drawing a selection destroyed the selection: the reader saw a
	// window appear and nothing happen.
	// The region as it stands mid-drag, in case the gesture's own event does
	// not carry it.
	const areasRef = useRef<unknown>(null);

	// What a click on a mark does, replaced on every draw.
	const pickRef = useRef<((params: MarkClick) => void) | null>(null);
	// The instance the canvas listeners are bound to, so a redraw does not
	// bind them a second time.
	const zrBoundRef = useRef<echarts.ECharts | null>(null);
	// Where the last press landed and whether the pointer travelled before
	// it was released, which tells a click from a drag.
	// Whether the library reported a click on a mark for the same press, so
	// the canvas listener can tell a mark from empty space.
	const pressRef = useRef({ x: 0, y: 0, moved: false, marked: false });

	// A time series can say where the change into any of its periods came
	// from, for a measure the dataset defines. A figure worked out on the
	// chart has no definition to split.
	const periodField =
		periodCharts.has(visualType) &&
		dimensions.length > 0 &&
		(dimensions[0] === compareField ||
			/date|timestamp/i.test(fields.get(dimensions[0])?.dataType ?? ""))
			? dimensions[0]
			: null;
	// The page's date range moved back by its own length, which is what a
	// bar or a slice that is not a period is compared against. Null when the
	// page has no range to move.
	const previousWindow = useMemo(
		() =>
			memberCharts.has(visualType) && compareField
				? shiftDateFilters(
						(filters ?? []) as DateClause[],
						compareField,
						"previous",
					)
				: null,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[visualType, compareField, filterKey],
	);
	// Forecasts of each measure past the last period, from the rows already
	// here. Held by the rows and the two settings, so a redraw for any other
	// reason does not fit the models again. Today is part of the key because
	// it decides which period is still unfinished.
	const today = localToday();
	const forecastOn =
		forecastCharts.has(visualType) &&
		periodField !== null &&
		dimensions.length === 1 &&
		options?.forecast === true;
	const forecastPeriods =
		typeof options?.forecastPeriods === "number"
			? options.forecastPeriods
			: null;
	// Whether each measure adds up across periods, which decides whether the
	// caption speaks of the period total or its average. Kept as a string so
	// the memo below sees a change only when the answer changes.
	const additiveKey = measures
		.map((m) => (looksAdditive(m, fields.get(m)?.formatHint) ? "1" : "0"))
		.join("");
	const forecast = useMemo(
		() =>
			forecastOn && periodField
				? forecastRows(rows, periodField, measures, {
						horizon: forecastPeriods,
						today,
						additive: Object.fromEntries(
							measures.map((m, i) => [m, additiveKey[i] === "1"]),
						),
					})
				: null,
		// The measures by content, since the page hands over a new array on
		// every render and each fit is a search over a grid of parameter sets.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[
			forecastOn,
			rows,
			periodField,
			JSON.stringify(measures),
			forecastPeriods,
			today,
			additiveKey,
		],
	);

	const explainable = Boolean(periodField || previousWindow);
	const [pointed, setPointed] = useState<Pointed | null>(null);
	const [explaining, setExplaining] = useState<Pointed | null>(null);

	// A mark chosen under other filters is not a mark on this chart.
	useEffect(() => setPointed(null), [filterKey, periodField]);

	// Whether a click on a mark means something here. A chart with nowhere to
	// send a selection, or whose marks are not values of a dimension, keeps
	// the plain cursor so it does not invite a click that does nothing.
	const selectable =
		onSelect !== undefined && canSelect(visualType, dimensions);
	const interactive = selectable || explainable;

	const liveRef = useRef({
		onSelect,
		onClearSelection,
		onSelectRange,
		visualType,
		dimensions,
		measures,
		rows,
		periodField,
		fields,
		filters,
		previousWindow,
		selectable,
	});
	liveRef.current = {
		onSelect,
		onClearSelection,
		onSelectRange,
		visualType,
		dimensions,
		measures,
		rows,
		periodField,
		fields,
		filters,
		previousWindow,
		selectable,
	};

	// A range selection needs an axis to select across, so it is offered on the
	// cartesian charts and not on a pie or a gauge.
	const supportsBrush =
		onSelectRange !== undefined &&
		dimensions.length > 0 &&
		[
			"barChart",
			"lineChart",
			"areaChart",
			"horizontalBarChart",
			"comboChart",
			"stackedBarChart",
			// Scatter is deliberately absent. Its axes carry values rather
			// than categories, so a region drawn on it describes a numeric
			// range, not a set of rows, and turning that into a filter is a
			// different feature rather than the same one.
		].includes(visualType);

	const option = useMemo(() => {
		if (rows.length === 0) return null;

		const ctx: ChartContext = {
			rows,
			dimensions,
			measures,
			colors: readThemeColors(),
			style,
			options,
			hintFor: (field) =>
				(fields.get(field)?.formatHint as FormatHint) ?? "decimal",
			// The same visual over the earlier window, for a chart whose shape
			// is a change. Null when the page has no window to move.
			comparisonRows: comparisonFilters ? comparison.rows : null,
			forecast,
		};

		// The chart that produced a selection marks it, so the reader can see
		// what they picked rather than only its effect on everything else.
		if (selection && selection.length > 0 && dimensions.length > 0) {
			ctx.selection = selection;
		}

		const built = (() => {
			switch (visualType) {
				case "pieChart":
					return buildPie(ctx, false);
				case "donutChart":
					return buildPie(ctx, true);
				case "treemapChart":
					return buildTreemap(ctx);
				case "funnelChart":
					return buildFunnel(ctx);
				case "gauge":
					return buildGauge(ctx);
				case "waterfallChart":
					return buildWaterfall(ctx);
				case "bulletChart":
					return buildBullet(ctx);
				case "slopeChart":
					return buildSlope(ctx);
				case "paretoChart":
					return buildPareto(ctx);
				case "histogramChart":
					return buildHistogram(ctx);
				case "boxPlot":
					return buildBoxPlot(ctx);
				case "calendarChart":
					return buildCalendar(ctx);
				case "timelineChart":
					return buildTimeline(ctx);
				case "choroplethChart":
					return countries
						? buildChoropleth(ctx, countries, regionBounds).option
						: null;
				case "sankeyChart":
					return buildSankey(ctx);
				case "heatmapChart":
					return buildHeatmap(ctx);
				case "radarChart":
					return buildRadar(ctx);
				case "horizontalBarChart":
					return buildCartesian(ctx, "bar", "horizontal");
				case "stackedBarChart":
					return buildCartesian(ctx, "stacked100");
				case "comboChart":
					return buildCartesian(ctx, "combo");
				case "areaChart":
					return buildCartesian(ctx, "area");
				case "scatterChart":
					return buildScatter(ctx);
				case "lineChart":
					return buildCartesian(ctx, "line");
				default:
					return buildCartesian(ctx, "bar");
			}
		})();

		// The library puts a pointer over every mark by default, which on a
		// chart that does nothing with a click promises something it does not
		// do.
		if (!built || interactive) return built;
		const series = (built as { series?: unknown }).series;
		return {
			...built,
			series: (Array.isArray(series) ? series : [series]).map(
				(entry) => ({
					...(entry as Record<string, unknown>),
					cursor: "default",
				}),
			),
		};
		// Held by content, since the selection is rebuilt on every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		rows,
		dimensions,
		measures,
		visualType,
		fields,
		style,
		// Serialized rather than referenced, so a fresh object carrying the
		// same settings does not rebuild the chart and drop a selection a
		// reader is in the middle of drawing.
		JSON.stringify(options ?? {}),
		JSON.stringify(selection ?? []),
		interactive,
		comparison.rows,
		comparisonFilters,
		forecast,
		countries,
		// The palette is read off the document when the option is built, so
		// a theme change has to build it again.
		resolved,
	]);

	// Whether the built chart carries forecast marks. Read back off the option,
	// because the builder leaves them off a chart whose categories the
	// forecast cannot line up with, and the caption has to agree with what was
	// drawn.
	const forecastShown = useMemo(() => {
		const series = (option as { series?: unknown } | null)?.series;
		return (
			Array.isArray(series) &&
			series.some((entry) =>
				String((entry as { id?: unknown }).id ?? "").startsWith(
					forecastSeriesPrefix,
				),
			)
		);
	}, [option]);
	const forecastCaption =
		forecastShown && forecast ? describeForecast(forecast) : null;

	// The categories along the axis in the order the chart drew them, as rows
	// a brushed range can be read from. Taken from the built option, so a
	// chart sorted by value or pivoted into a stack maps a range to the bars
	// the reader covered rather than to rows in query order.
	const brushRows = useMemo(() => {
		const field = dimensions[0];
		if (!option || !field) return rows;
		const o = option as { xAxis?: unknown; yAxis?: unknown };
		const axes = [o.xAxis, o.yAxis].flatMap((axis) =>
			Array.isArray(axis) ? axis : [axis],
		) as ({ type?: string; data?: unknown[] } | undefined)[];
		const category = axes.find(
			(axis) => axis?.type === "category" && Array.isArray(axis.data),
		);
		if (!category?.data) return rows;
		// Forecast periods appended to the axis are not rows, so a range
		// drawn over them selects only the measured periods.
		const measured = forecastShown
			? category.data.slice(0, rows.length)
			: category.data;
		return measured.map((value) => ({ [field]: value }));
	}, [option, rows, dimensions, forecastShown]);
	const brushRowsRef = useRef(brushRows);
	brushRowsRef.current = brushRows;

	// The marks a reader can step through from the keyboard, in drawn order,
	// and which one is focused. Offered where a click selects, so a key does
	// what a click would and nothing a click would not.
	const marks = useMemo(
		() => (selectable && option ? keyboardMarks(visualType, option) : []),
		[selectable, option, visualType],
	);
	const [focusIndex, setFocusIndex] = useState(-1);
	// Spoken as the focus moves, since the canvas has nothing a screen reader
	// can read out.
	const [announcement, setAnnouncement] = useState("");
	const focused = focusIndex >= 0 ? marks[focusIndex] : undefined;

	// Under other filters the marks are different ones, so the focus starts
	// again rather than landing on whatever now sits at the same position.
	useEffect(() => setFocusIndex(-1), [filterKey, dimensions]);

	// How many marks the axis bounds leave off the chart.
	//
	// Read back off the option rather than decided again here, so the number
	// under the chart is counted against the bounds the chart is drawn with
	// and the two cannot disagree. A chart that drops points without saying so
	// is a chart that lies quietly, and a trimmed axis drops points by design.
	const clipped = useMemo(() => {
		// Scatter only, because it is the one type where the first measure is
		// the horizontal axis and the second the vertical. Anywhere else the
		// pairing is a guess, and a count against the wrong axis would be a
		// sentence under the chart saying something untrue.
		if (!option || visualType !== "scatterChart" || measures.length < 2) {
			return 0;
		}
		const axes: [unknown, string][] = [
			[(option as Record<string, unknown>).xAxis, measures[0]],
			[(option as Record<string, unknown>).yAxis, measures[1]],
		];

		let count = 0;
		for (const row of rows) {
			for (const [axis, field] of axes) {
				const bounds = axis as
					| { min?: number; max?: number }
					| undefined;
				if (!bounds || !field) continue;
				if (
					typeof bounds.min !== "number" &&
					typeof bounds.max !== "number"
				) {
					continue;
				}
				const value = Number(row[field]);
				if (!Number.isFinite(value)) continue;
				if (
					(typeof bounds.min === "number" && value < bounds.min) ||
					(typeof bounds.max === "number" && value > bounds.max)
				) {
					count++;
					break;
				}
			}
		}
		return count;
	}, [option, rows, measures, visualType]);

	// Twice the drawn size, so the picture holds up pasted into a document at
	// its natural width. The page's own surface behind it rather than
	// transparency, which lands as black on most things it gets pasted into.
	// Nothing here depends on the option, because the getter looks the chart up
	// when it runs rather than closing over it. So this happens once.
	useEffect(() => {
		if (!imageRef) return;
		const ref = imageRef;
		ref.current = () => {
			const chart = chartRef.current;
			if (!chart) return null;
			return chart.getDataURL({
				type: "png",
				pixelRatio: 2,
				backgroundColor: readThemeColors().surface,
			});
		};
		return () => {
			ref.current = null;
		};
	}, [imageRef]);

	useEffect(() => {
		if (!containerRef.current || !option) return;

		// Created on whichever element is mounted now. The container is
		// replaced whenever a placeholder has stood in for the chart, and
		// attachContainer drops the instance bound to the old one.
		if (!chartRef.current) {
			chartRef.current = echarts.init(containerRef.current, undefined, {
				renderer: "canvas",
			});
		}

		// Replace rather than merge, so a series or axis removed from the
		// config does not linger from the previous render.
		chartRef.current.setOption(option, { notMerge: true });

		// Brushing is enabled through the toolbox rather than the toolbox
		// being shown: the reader drags directly on the chart, and the buttons
		// would only add clutter.
		if (supportsBrush) {
			chartRef.current.setOption({
				toolbox: { show: false, feature: { brush: {} } },
				brush: {
					toolbox: ["lineX", "clear"],
					xAxisIndex: 0,
					// No throttle. A debounce delayed the final selection past
					// the end of the gesture, so the handler that acts on the
					// gesture ending read the selection from before the drag
					// and applied nothing. Recording a selection is an
					// assignment to a ref, which is not worth throttling.
					throttleType: "fixRate",
					throttleDelay: 0,
					brushStyle: {
						borderWidth: 1,
						color: "rgba(120, 140, 180, 0.18)",
						borderColor: "rgba(120, 140, 180, 0.6)",
					},
				},
			});
			// Starts in brush mode so a drag selects rather than doing nothing,
			// which is what a reader expects after being told they can drag.
			chartRef.current.dispatchAction({
				type: "takeGlobalCursor",
				key: "brush",
				brushOption: { brushType: "lineX", brushMode: "single" },
			});
		}

		chartRef.current.off("brushEnd");
		chartRef.current.off("brushSelected");
		if (supportsBrush) {
			// A selection is taken from the geometry of the region drawn, not
			// from the library's list of selected indices.
			//
			// That list is reported per series on its own schedule and is
			// empty whenever the chart is redrawn, which happens the instant a
			// selection is acted on. The region is a pair of positions on the
			// axis, so the rows it covers are a slice, and a slice is the same
			// every time.
			const commit = (areas: unknown) => {
				const area = Array.isArray(areas)
					? (areas[0] as { coordRange?: unknown } | undefined)
					: undefined;
				const { dimensions: dims, onSelectRange: report } =
					liveRef.current;
				const current = brushRowsRef.current;
				const field = dims[0];
				if (!field || !report) return;

				const values = indicesToValues(
					rangeToIndices(area?.coordRange, current.length),
					current,
					field,
				).map(selectionValue);
				report(field, values);
			};

			// Nothing is acted on until the reader lets go.
			//
			// The region is reported continuously while the pointer moves, and
			// acting on those made the chart filter itself on the first pixel
			// of the drag: the page re-queried, the chart redrew, and the
			// gesture the reader was halfway through was gone. So the moving
			// region is only remembered here.
			chartRef.current.on("brushSelected", (params: unknown) => {
				const batch = (params as { batch?: { areas?: unknown }[] })
					.batch?.[0];
				if (batch?.areas) areasRef.current = batch.areas;
			});

			// Letting go is the decision. A drag that covered nothing clears,
			// which is how a selection is undone without a separate control.
			chartRef.current.on("brushEnd", (params: unknown) => {
				const areas =
					(params as { areas?: unknown }).areas ?? areasRef.current;
				areasRef.current = null;
				commit(areas);
			});
		}

		// One mark chosen, from a click on the mark itself or from a click in
		// a period's column on a line. Assigned on every draw so it closes
		// over nothing stale, and read through the ref by the listeners, which
		// are bound once per chart instance.
		pickRef.current = (params: MarkClick) => {
			const {
				visualType: type,
				dimensions: dims,
				measures: shown,
				rows: current,
				onSelect: pick,
				periodField: axis,
				fields: known,
				filters: applied,
				previousWindow: earlier,
			} = liveRef.current;

			const measure =
				params.seriesName && shown.includes(params.seriesName)
					? params.seriesName
					: shown[0];
			const usable = Boolean(measure && known.has(measure));
			const base = applied ?? [];

			if (axis && params.name) {
				// A period is compared with the one before it in time,
				// whatever order the bars are drawn in.
				const periods = [
					...new Set(current.map((r) => String(r[axis] ?? ""))),
				]
					.filter(Boolean)
					.sort();
				const at = periods.indexOf(params.name);
				setPointed(
					at > 0 && usable
						? {
								label: formatDate(params.name),
								measure,
								current: [
									...base,
									{
										field: axis,
										op: "eq",
										value: params.name,
									},
								],
								previous: [
									...base,
									{
										field: axis,
										op: "eq",
										value: periods[at - 1],
									},
								],
								against: formatDate(periods[at - 1]),
							}
						: null,
				);
			} else if (
				earlier &&
				dims.length > 0 &&
				params.name &&
				(params.treePathInfo?.length ?? 0) <= 2
			) {
				// Anything else is one value of the first dimension,
				// compared with itself over the period before.
				const clause =
					params.name === blankLabel
						? { field: dims[0], op: "is_empty" }
						: { field: dims[0], op: "eq", value: params.name };
				setPointed(
					usable
						? {
								label: params.name,
								measure,
								current: [...base, clause],
								previous: [...earlier, clause],
								against: "the period before",
							}
						: null,
				);
			}

			if (!pick) return;

			// Which field a mark stands for depends on the type. A nested
			// treemap tile is a group and a tile, a sankey node is one
			// side, and a slope point is its line rather than its end.
			// Read in one place so the filter, the chip and the dimming
			// agree.
			const chosen = selectionFromClick(type, dims, shown, params);
			if (chosen && chosen.length > 0) pick(chosen);
		};

		const chart = chartRef.current;
		chart.off("click");
		chart.on("click", (params: unknown) => {
			pressRef.current.marked = true;
			if (pressRef.current.moved) return;
			pickRef.current?.(params as MarkClick);
		});

		// Clicks away from any mark, heard on the canvas underneath the
		// series. Bound once per instance, because the library's own event
		// handling listens on the same surface and clearing every listener
		// there would take its handling with it.
		if (zrBoundRef.current !== chart) {
			zrBoundRef.current = chart;
			const zr = chart.getZr();
			zr.on("mousedown", (e: { offsetX: number; offsetY: number }) => {
				pressRef.current = {
					x: e.offsetX,
					y: e.offsetY,
					moved: false,
					marked: false,
				};
			});
			zr.on("mouseup", (e: { offsetX: number; offsetY: number }) => {
				const press = pressRef.current;
				press.moved =
					Math.abs(e.offsetX - press.x) > clickSlop ||
					Math.abs(e.offsetY - press.y) > clickSlop;
			});
			zr.on(
				"click",
				(e: { target?: unknown; offsetX: number; offsetY: number }) => {
					// The library dispatches a click on a mark before this
					// runs, and that click has been handled.
					const press = pressRef.current;
					const marked = press.marked;
					press.marked = false;
					if (press.moved || marked) return;
					const live = liveRef.current;
					const point = [e.offsetX, e.offsetY];
					const inPlot =
						columnPickCharts.has(live.visualType) &&
						chart.containPixel({ gridIndex: 0 }, point);

					// A line's points are hidden on a long series, so a click
					// in the plot picks the period whose column it landed in.
					// The line and the area under it are shapes with no data
					// of their own, so a click on them lands here too.
					if (inPlot && (live.selectable || live.periodField)) {
						const at = chart.convertFromPixel(
							{ gridIndex: 0 },
							point,
						) as number[] | number;
						const index = Math.round(
							Array.isArray(at) ? Number(at[0]) : Number(at),
						);
						// A forecast period has nothing measured to select
						// or explain, and is not empty space either.
						if (index >= brushRowsRef.current.length) return;
						const field = live.dimensions[0];
						const row = brushRowsRef.current[index];
						if (field && row && Number.isFinite(index)) {
							pickRef.current?.({
								name: String(row[field] ?? ""),
								dataIndex: index,
							});
							return;
						}
					}

					// Anything else under the pointer is a legend entry or a
					// label, which has its own job. Only empty space lets go.
					if (e.target && !inPlot) return;
					if (live.selectable) live.onClearSelection?.();
				},
			);
		}
		// resolved is a dependency because the palette is read off the
		// document, so a theme change has to repaint. container is one because
		// a new element needs a chart created on it.
		// Deliberately narrow. The handlers read what they need at call time, so
		// a fresh callback from the page is not a reason to rebuild the chart
		// and throw away whatever the reader was doing in it.
	}, [option, resolved, supportsBrush, container]);

	// The focused mark drawn as hovered, with its tooltip. Applied again after
	// every redraw, because replacing the option clears the library's own
	// highlight, and only while the chart holds focus so a pointer elsewhere
	// is not fought over.
	useEffect(() => {
		const chart = chartRef.current;
		if (!chart || !container || document.activeElement !== container) {
			return;
		}
		paintFocus(chart, focused);
	}, [focused, option, container]);

	// The observer attaches to the element itself rather than on mount.
	//
	// The container is not rendered while the query is in flight: a loading
	// placeholder is. So an effect that ran once on mount found no element,
	// returned, and never ran again, which meant no chart ever noticed its box
	// changing. A card could be resized all day and the canvas inside it kept
	// whatever size it happened to be created at.
	const observerRef = useRef<ResizeObserver | null>(null);

	const attachContainer = useCallback((element: HTMLDivElement | null) => {
		// An instance is bound to the element it was created on. Once that
		// element is gone, painting into the instance draws off screen, so it
		// is disposed and the next draw creates one on the new element.
		if (element !== containerRef.current) {
			chartRef.current?.dispose();
			chartRef.current = null;
		}
		containerRef.current = element;
		setContainer(element);
		observerRef.current?.disconnect();

		if (!element) {
			observerRef.current = null;
			return;
		}

		const observer = new ResizeObserver(() => chartRef.current?.resize());
		observer.observe(element);
		observerRef.current = observer;
	}, []);

	useEffect(() => () => observerRef.current?.disconnect(), []);

	useEffect(() => {
		return () => {
			chartRef.current?.dispose();
			chartRef.current = null;
		};
	}, []);

	// What a focused mark is read out as, such as "North, Revenue $1.2M, 2 of
	// 8".
	const describeMark = (mark: KeyMark, index: number): string => {
		const measure =
			mark.click.seriesName && measures.includes(mark.click.seriesName)
				? mark.click.seriesName
				: measures[0];
		const figure =
			typeof mark.value === "number" ||
			(typeof mark.value === "string" && mark.value.trim() !== "")
				? formatValue(
						mark.value,
						(fields.get(measure ?? "")?.formatHint as FormatHint) ??
							"decimal",
					)
				: null;
		const measureName = measure
			? fields.get(measure)?.displayName || measure
			: "";
		const label = describeValue(selectionValue(mark.label));
		return [
			label,
			figure ? `${measureName} ${figure}`.trim() : null,
			`${index + 1} of ${marks.length}`,
		]
			.filter(Boolean)
			.join(", ");
	};

	// Arrows move between marks, Enter or Space chooses the focused one the
	// way a click on it would, and Escape lets go of what this chart selected.
	const onChartKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (marks.length === 0) return;
		if (event.key === "Escape") {
			if (focusIndex < 0 && !(selection && selection.length > 0)) return;
			event.preventDefault();
			event.stopPropagation();
			setFocusIndex(-1);
			if (selection && selection.length > 0) {
				onClearSelection?.();
				setAnnouncement("Selection cleared");
			} else {
				setAnnouncement("");
			}
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			if (!focused) return;
			event.preventDefault();
			pickRef.current?.(focused.click);
			return;
		}
		const next = stepMark(focusIndex, marks.length, event.key);
		if (next === null) return;
		event.preventDefault();
		setFocusIndex(next);
		setAnnouncement(describeMark(marks[next], next));
	};

	// Leaving the chart puts the tooltip away, and the focused mark is kept
	// so coming back resumes where the reader was.
	const onChartBlur = () => {
		if (chartRef.current) paintFocus(chartRef.current, undefined);
	};
	const onChartFocus = () => {
		if (chartRef.current && focused) paintFocus(chartRef.current, focused);
	};

	if (problem) return <VisualEmpty message={problem.message} />;
	if (error) return <VisualError error={error} />;
	if (isLoading && rows.length === 0) return <VisualLoading rows={5} />;
	if (rows.length === 0) return <VisualEmpty />;

	if (isMap && mapFailed) {
		return (
			<VisualEmpty message="The map boundaries could not be loaded, so there is nothing to draw this on. Reloading the page is worth a try." />
		);
	}
	if (isMap && !countries) return <VisualLoading rows={4} />;

	// A comparison chart with nothing to compare against. Said rather than
	// drawn as a flat line, which would read as "nothing changed" when the
	// truth is that no earlier window was asked for.
	if (comparisonNeeded && !comparisonFilters) {
		return (
			<VisualEmpty message="This chart draws a change, so it needs a date range on the page and a date field set under Compare against." />
		);
	}

	if (comparisonNeeded && comparison.isLoading) {
		return <VisualLoading rows={5} />;
	}

	// What the chart says, for a reader who cannot see it.
	//
	// A canvas is one opaque element with no text in it, so without this a
	// screen reader meets a page of visuals and finds nothing on any of them.
	// The sentence is the glance and the table under it is the detail, and the
	// table holds the rows the chart drew rather than a second query that
	// could disagree with it.
	// The columns the answer actually carries, not the ones the visual asked
	// for. A box plot asks for a measure across a grain and is answered with
	// quartiles, so a table built from the request would have had a column per
	// field and a value in none of them.
	const columns =
		answered.length > 0 ? answered : [...dimensions, ...measures];

	// A summarised answer names its columns after what they are rather than
	// after the measure, so the hint comes from the measure they describe.
	const hintFor = (column: string): FormatHint => {
		const own = fields.get(column)?.formatHint as FormatHint | undefined;
		if (own) return own;
		if (summaryValueColumns.has(column) && measures[0]) {
			return (
				(fields.get(measures[0])?.formatHint as FormatHint) ?? "decimal"
			);
		}
		return "decimal";
	};

	return (
		<div
			className={styles.chartFrame}
			style={typeof height === "number" ? { height } : undefined}
		>
			<div
				ref={attachContainer}
				className={styles.chartCanvas}
				// A chart whose marks can be chosen takes focus and handles
				// its own arrow keys, which is what the application role tells
				// a screen reader to let through. Anything else is a picture.
				{...(marks.length > 0
					? {
							tabIndex: 0,
							role: "application",
							"aria-roledescription": "chart",
							"aria-label": `${describeChart(
								visualType,
								rows,
								dimensions,
								measures,
								title,
							)}${forecastCaption ? ` ${forecastCaption}` : ""} Arrow keys move between marks, Enter selects one, Escape clears the selection.`,
							onKeyDown: onChartKey,
							onFocus: onChartFocus,
							onBlur: onChartBlur,
						}
					: {
							role: "img",
							"aria-label": `${describeChart(
								visualType,
								rows,
								dimensions,
								measures,
								title,
							)}${forecastCaption ? ` ${forecastCaption}` : ""}`,
						})}
				// No cursor of its own. The library sets one per element as
				// the pointer moves, a pointer over a mark that does something
				// and the plain arrow everywhere else, and a pointer set here
				// would claim the whole box was clickable.
			/>
			<div className="sr-only" aria-live="polite" aria-atomic="true">
				{announcement}
			</div>
			{pointed && (
				<div className={styles.chartWhy}>
					<button
						type="button"
						className={styles.chartWhyButton}
						onClick={() => setExplaining(pointed)}
					>
						Why did {pointed.label} change?
					</button>
					<button
						type="button"
						className={styles.chartWhyClose}
						onClick={() => setPointed(null)}
						aria-label="Dismiss"
					>
						<svg
							width="10"
							height="10"
							viewBox="0 0 10 10"
							aria-hidden="true"
						>
							<path
								d="M1 1l8 8M9 1l-8 8"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
							/>
						</svg>
					</button>
				</div>
			)}
			{explaining && (
				<ExplainDialog
					sourceKey={sourceKey}
					measure={explaining.measure}
					hint={
						(fields.get(explaining.measure)
							?.formatHint as FormatHint) ?? "decimal"
					}
					filters={explaining.current}
					previousFilters={explaining.previous}
					against={explaining.against}
					onClose={() => setExplaining(null)}
				/>
			)}
			{forecastCaption && (
				<p className={styles.chartFootnote}>{forecastCaption}</p>
			)}
			{clipped > 0 && (
				<p className={styles.chartFootnote} role="status">
					{clipped === 1
						? "1 point sits outside the axis range and is not drawn."
						: `${clipped.toLocaleString()} points sit outside the axis range and are not drawn.`}
				</p>
			)}
			{unmatched.length > 0 && (
				<p className={styles.mapUnmatched} role="status">
					{unmatched.length === 1
						? `1 value could not be placed on the map: ${unmatched[0]}.`
						: `${unmatched.length} values could not be placed on the map: ${unmatched.slice(0, 6).join(", ")}${unmatched.length > 6 ? ", and others" : ""}.`}
				</p>
			)}

			{/* Wrapped rather than clipped directly, because a caption is laid
			    out outside the table's border box: sr-only on the table hid
			    every row and left the sentence on screen under each chart,
			    where it read as a stray line of machine text nobody could
			    edit. The wrapper has a border box the caption sits inside. */}
			<div className="sr-only">
				<table>
					<caption>
						{describeChart(
							visualType,
							rows,
							dimensions,
							measures,
							title,
						)}
					</caption>
					<thead>
						<tr>
							{columns.map((column) => (
								<th key={column} scope="col">
									{column}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, index) => (
							<tr key={index}>
								{columns.map((column) => (
									<td key={column}>
										{formatValue(
											row[column],
											hintFor(column),
										)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
