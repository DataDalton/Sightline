"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import {
	BarChart,
	LineChart,
	ScatterChart,
	PieChart,
	TreemapChart,
	FunnelChart,
	GaugeChart,
	HeatmapChart,
	RadarChart,
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
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useTheme } from "../context/ThemeContext";
import { useVisualQuery } from "../hooks/useVisualQuery";
import { queryForVisual } from "../../lib/query/visualSpec";
import type { FormatHint } from "../../lib/format";
import { checkEncoding } from "../../lib/visuals/catalog";
import { indicesToValues, rangeToIndices } from "../../lib/visuals/brush";
import type { VisualStyle } from "../../lib/visuals/style";
import { readThemeColors } from "./colors";
import {
	buildCartesian,
	buildFunnel,
	buildGauge,
	buildHeatmap,
	buildPie,
	buildRadar,
	buildTreemap,
	buildWaterfall,
	type ChartContext,
} from "./chartOptions";
import { VisualEmpty, VisualError, VisualLoading } from "./VisualFrame";
import type { FieldMeta } from "./types";

// Only the chart types in use are registered, so the bundle carries those
// rather than all of ECharts. Canvas rendering is chosen over SVG because a
// chart here can carry thousands of points and SVG puts a DOM node behind
// every one of them.
echarts.use([
	BarChart,
	LineChart,
	ScatterChart,
	PieChart,
	TreemapChart,
	FunnelChart,
	GaugeChart,
	HeatmapChart,
	RadarChart,
	GridComponent,
	LegendComponent,
	TooltipComponent,
	DataZoomComponent,
	VisualMapComponent,
	MarkLineComponent,
	BrushComponent,
	ToolboxComponent,
	CanvasRenderer,
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
}

export function Chart({
	visualType,
	sourceKey,
	dimensions,
	measures,
	filters,
	limit = 500,
	fields,
	height = 300,
	style,
	options,
	onSelect,
	selectedValues,
	onSelectRange,
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
	const { rows, error, isLoading } = useVisualQuery(
		ready
			? queryForVisual(visualType, {
					sourceKey,
					dimensions,
					measures,
					filters,
					limit,
					options,
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
				return buildCartesian(ctx, "scatter");
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
	]);

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
			(params: { name?: string; dataIndex?: number }) => {
				const {
					dimensions: dims,
					rows: current,
					onSelect: pick,
				} = liveRef.current;
				if (!pick || dims.length === 0) return;
				const field = dims[0];
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

	return (
		<div
			ref={attachContainer}
			style={{
				width: "100%",
				height,
				cursor: onSelect ? "pointer" : "default",
			}}
		/>
	);
}
