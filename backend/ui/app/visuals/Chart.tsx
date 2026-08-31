"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { formatValue, type FormatHint } from "../../lib/format";
import { describeChart } from "../../lib/visuals/chartSummary";
import { matchCountry } from "../../lib/visuals/countryNames";
import { checkEncoding } from "../../lib/visuals/catalog";
import { indicesToValues, rangeToIndices } from "../../lib/visuals/brush";
import type { VisualStyle } from "../../lib/visuals/style";
import { readThemeColors } from "./colors";
import { ensureWorldMap } from "./worldMap";
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
	type ChartContext,
} from "./chartOptions";
import { VisualEmpty, VisualError, VisualLoading } from "./VisualFrame";
import type { FieldMeta } from "./types";
import styles from "./Visual.module.css";

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

export interface ChartSelection {
	field: string;
	value: string;
}

interface ChartProps {
	visualType: string;
	sourceKey: string;
	dimensions: string[];
	measures: string[];
	filters?: unknown[];
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
	// Highlighted rather than filtered, so the clicked chart still shows the
	// whole picture with the selection standing out.
	// Values this chart's own selection covers. Everything else is dimmed, so
	// the selection reads against the rest rather than replacing it.
	selectedValues?: string[];
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
	limit = 500,
	transforms,
	compareTo,
	compareField,
	fields,
	height = 300,
	style,
	options,
	onSelect,
	selectedValues,
	onSelectRange,
	imageRef,
	title,
}: ChartProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
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

	const liveRef = useRef({ onSelect, onSelectRange, dimensions, rows });
	liveRef.current = { onSelect, onSelectRange, dimensions, rows };

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
		};

		// The chart that produced a selection marks it, so the reader can see
		// what they picked rather than only its effect on everything else.
		if (
			selectedValues &&
			selectedValues.length > 0 &&
			dimensions.length > 0
		) {
			ctx.highlight = { field: dimensions[0], values: selectedValues };
		}

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
					? buildChoropleth(ctx, countries).option
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
		(selectedValues ?? []).join("\u0000"),
		comparison.rows,
		comparisonFilters,
		countries,
	]);

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
				const {
					dimensions: dims,
					rows: current,
					onSelectRange: report,
				} = liveRef.current;
				const field = dims[0];
				if (!field || !report) return;

				const values = indicesToValues(
					rangeToIndices(area?.coordRange, current.length),
					current,
					field,
				);
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

		chartRef.current.off("click");
		chartRef.current.on(
			"click",
			(params: {
				name?: string;
				dataIndex?: number;
				treePathInfo?: unknown[];
			}) => {
				const {
					dimensions: dims,
					rows: current,
					onSelect: pick,
				} = liveRef.current;
				if (!pick || dims.length === 0) return;

				// A nested treemap draws two dimensions, so which one was
				// clicked depends on how deep the tile is. The path includes
				// the root, so a group is two long and a tile inside it is
				// three. Taking the first dimension either way filtered the
				// group field by a tile name that is not in it, which matched
				// nothing and read as the click doing nothing.
				const depth = params.treePathInfo?.length ?? 0;
				const field =
					depth > 2 && dims.length > 1 ? dims[depth - 2] : dims[0];

				const value =
					params.name ??
					(params.dataIndex !== undefined
						? String(current[params.dataIndex]?.[field] ?? "")
						: "");
				if (value) pick({ field, value });
			},
		);
		// resolved is a dependency because the palette is read off the
		// document, so a theme change has to repaint.
		// Deliberately narrow. The handlers read what they need at call time, so
		// a fresh callback from the page is not a reason to rebuild the chart
		// and throw away whatever the reader was doing in it.
	}, [option, resolved, supportsBrush]);

	// The observer attaches to the element itself rather than on mount.
	//
	// The container is not rendered while the query is in flight: a loading
	// placeholder is. So an effect that ran once on mount found no element,
	// returned, and never ran again, which meant no chart ever noticed its box
	// changing. A card could be resized all day and the canvas inside it kept
	// whatever size it happened to be created at.
	const observerRef = useRef<ResizeObserver | null>(null);

	const attachContainer = useCallback((element: HTMLDivElement | null) => {
		containerRef.current = element;
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
				role="img"
				aria-label={describeChart(
					visualType,
					rows,
					dimensions,
					measures,
					title,
				)}
				style={{ cursor: onSelect ? "pointer" : "default" }}
			/>
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
