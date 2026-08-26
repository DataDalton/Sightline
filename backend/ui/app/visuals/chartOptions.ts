import {
	formatCompact,
	formatValue,
	toNumber,
	type FormatHint,
} from "../../lib/format";
import { styleForMeasure, type VisualStyle } from "../../lib/visuals/style";
import { withAlpha, type ThemeColors } from "./colors";

// Builds the ECharts option for each visual type.
//
// Kept out of the component so the mapping from data to marks is testable and
// so adding a chart type does not mean touching React. Every builder receives
// the same inputs and returns a plain option object.

export interface ChartContext {
	rows: Record<string, unknown>[];
	dimensions: string[];
	measures: string[];
	colors: ThemeColors;
	style?: VisualStyle;
	hintFor: (field: string) => FormatHint;
	// Set when this chart produced the page selection. Marks that are not in it
	// are dimmed rather than removed, so the selection is read in context.
	//
	// A set rather than a single value: a reader who drags across five bars has
	// selected five, and highlighting the first of them while the page filters
	// on all five says two different things at once.
	highlight?: { field: string; values: string[] } | null;
	// What the author set on this particular visual, as declared in the visual
	// catalogue. Read through option(), which applies the catalogue fallback so
	// a chart and the properties panel cannot disagree about what unset means.
	options?: Record<string, unknown>;
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

// Opacity per data point, dimming everything that is not the selection.
// Returns undefined when nothing is selected, so the normal path allocates no
// per-point styling at all.
function highlightOpacity(
	ctx: ChartContext,
	rowIndex: number,
): number | undefined {
	if (!ctx.highlight) return undefined;

	// Everything on screen is in the selection, which happens once a chart has
	// narrowed to what was drawn on it. There is nothing to contrast against,
	// so dimming would only make the whole chart look faded.
	if (ctx.highlight.values.length >= ctx.rows.length) return undefined;

	const value = String(ctx.rows[rowIndex]?.[ctx.highlight.field] ?? "");
	return ctx.highlight.values.includes(value) ? 1 : 0.25;
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

function valueAxis(ctx: ChartContext, hint: FormatHint) {
	return {
		type: "value" as const,
		name: ctx.style?.yAxis?.label,
		// A truncated axis exaggerates differences, so zero is included unless
		// the author explicitly opts out.
		scale: ctx.style?.yAxis?.beginAtZero === false,
		min: ctx.style?.yAxis?.min,
		max: ctx.style?.yAxis?.max,
		axisLabel: {
			color: ctx.colors.axis,
			formatter: (v: number) => formatCompact(v, hint),
		},
		splitLine: {
			show: ctx.style?.yAxis?.showGrid !== false,
			lineStyle: { color: ctx.colors.grid },
		},
	};
}

function categoryAxis(ctx: ChartContext, categories: string[]) {
	return {
		type: "category" as const,
		data: categories,
		name: ctx.style?.xAxis?.label,
		axisLabel: {
			hideOverlap: true,
			color: ctx.colors.axis,
			rotate: ctx.style?.xAxis?.labelRotation ?? 0,
		},
		axisLine: { lineStyle: { color: ctx.colors.grid } },
		axisTick: { alignWithLabel: true },
		splitLine: { show: ctx.style?.xAxis?.showGrid ?? false },
	};
}

const baseGrid = { left: 8, right: 16, top: 30, bottom: 8, containLabel: true };

// --- Cartesian: bar, line, area, scatter, combo, stacked -------------------

export function buildCartesian(
	ctx: ChartContext,
	kind: "bar" | "line" | "area" | "scatter" | "combo" | "stacked100",
	orientation: "vertical" | "horizontal" = "vertical",
) {
	const { dimensions, measures, colors, style } = ctx;
	const axisField = dimensions[0];
	// Ordered before anything reads a row, so the categories and every series
	// are built from the same sequence.
	const rows = sortedRows(ctx, measures[0]);
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

			const opacity = highlightOpacity(ctx, rowIndex);
			// A plain value where nothing is selected keeps the fast path;
			// only a highlighted chart pays for per-point objects.
			return opacity === undefined
				? raw
				: { value: raw, itemStyle: { opacity } };
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
			data,
		};
	});

	const category = categoryAxis(ctx, categories);
	const value = valueAxis(
		ctx,
		kind === "stacked100" ? "percent" : primaryHint,
	);

	return {
		animation: false,
		color: colors.series,
		textStyle: { color: colors.text, fontFamily: "inherit" },
		grid: { ...baseGrid, top: style?.legend?.show === false ? 12 : 30 },
		legend: legend(ctx, measures.length > 1),
		tooltip: {
			...tooltip(ctx),
			axisPointer: { type: kind === "bar" ? "shadow" : "line" },
			formatter: cartesianTooltip(ctx, axisField, Boolean(totals)),
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
		series,
	};
}

function cartesianTooltip(
	ctx: ChartContext,
	axisField: string,
	normalised: boolean,
) {
	return (params: unknown) => {
		const list = Array.isArray(params) ? params : [params];
		if (list.length === 0) return "";
		const first = list[0] as { dataIndex: number; axisValue?: string };
		const row = ctx.rows[first.dataIndex] ?? {};

		const total = ctx.style?.tooltip?.showShare
			? ctx.measures.reduce((sum, m) => sum + (toNumber(row[m]) ?? 0), 0)
			: 0;

		const header = `<div style="font-weight:600;margin-bottom:4px">${
			first.axisValue ?? String(row[axisField] ?? "")
		}</div>`;

		const lines = list.map((entry) => {
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
			return `<div>${e.marker} ${e.seriesName}: <b>${value}</b>${share}</div>`;
		});

		const extras = (ctx.style?.tooltip?.extraFields ?? [])
			.filter((f) => row[f] !== undefined)
			.map(
				(f) =>
					`<div style="opacity:.75">${f}: ${formatValue(row[f], ctx.hintFor(f))}</div>`,
			);

		return header + lines.join("") + extras.join("");
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
	const topN = Number(ctx.options?.topN);
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

	const data = grouped.map((r, i) => ({
		name: String(r[field] ?? ""),
		value: toNumber(r[measure]) ?? 0,
		itemStyle: { color: colors.series[i % colors.series.length] },
	}));

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
		textStyle: { color: colors.text, fontFamily: "inherit" },
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
				return `${e.marker} ${e.name}<br/><b>${formatValue(e.value, hint)}</b> (${e.percent}%)`;
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

	// A second dimension nests, which is what a treemap is actually for.
	const nested = dimensions.length > 1;
	let data: unknown[];

	if (nested) {
		const groups = new Map<string, { name: string; value: number }[]>();
		for (const row of rows) {
			const parent = String(row[dimensions[0]] ?? "");
			const child = String(row[dimensions[1]] ?? "");
			const list = groups.get(parent) ?? [];
			list.push({ name: child, value: toNumber(row[measure]) ?? 0 });
			groups.set(parent, list);
		}
		data = Array.from(groups.entries()).map(([name, children], i) => ({
			name,
			itemStyle: { color: colors.series[i % colors.series.length] },
			children,
		}));
	} else {
		data = rows.map((r, i) => ({
			name: String(r[dimensions[0]] ?? ""),
			value: toNumber(r[measure]) ?? 0,
			itemStyle: { color: colors.series[i % colors.series.length] },
		}));
	}

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: "inherit" },
		tooltip: {
			...tooltip(ctx, "item"),
			formatter: (p: unknown) => {
				const e = p as { name: string; value: number };
				return `${e.name}<br/><b>${formatValue(e.value, hint)}</b>`;
			},
		},
		series: [
			{
				type: "treemap",
				roam: false,
				nodeClick: false,
				breadcrumb: { show: nested },
				label: { show: true, formatter: "{b}", color: "#fff" },
				upperLabel: nested ? { show: true, height: 20 } : undefined,
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
		textStyle: { color: colors.text, fontFamily: "inherit" },
		legend: legend(ctx, true),
		tooltip: {
			...tooltip(ctx, "item"),
			formatter: (p: unknown) => {
				const e = p as { name: string; value: number; marker: string };
				return `${e.marker} ${e.name}: <b>${formatValue(e.value, hint)}</b>`;
			},
		},
		series: [
			{
				type: "funnel",
				top: 30,
				bottom: 10,
				sort: "descending",
				gap: 2,
				label: { show: true, position: "inside", color: "#fff" },
				data: rows.map((r, i) => ({
					name: String(r[dimensions[0]] ?? ""),
					value: toNumber(r[measures[0]]) ?? 0,
					itemStyle: {
						color: colors.series[i % colors.series.length],
					},
				})),
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
	const max =
		target && target > 0
			? Math.max(target * 1.25, value * 1.1)
			: value * 1.5 || 100;

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: "inherit" },
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
	// series so they can be coloured independently.
	const base: number[] = [];
	const rising: (number | string)[] = [];
	const falling: (number | string)[] = [];
	let running = 0;

	for (const value of values) {
		if (value >= 0) {
			base.push(running);
			rising.push(value);
			falling.push("-");
		} else {
			base.push(running + value);
			rising.push("-");
			falling.push(-value);
		}
		running += value;
	}

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: "inherit" },
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
				return `<div style="font-weight:600">${first.axisValue}</div>
					<div>Change: <b>${formatValue(value, hint)}</b></div>
					<div style="opacity:.75">Running total: ${formatValue(cumulative, hint)}</div>`;
			},
		},
		xAxis: categoryAxis(ctx, categories),
		yAxis: valueAxis(ctx, hint),
		series: [
			{
				name: "base",
				type: "bar",
				stack: "wf",
				itemStyle: { color: "transparent" },
				emphasis: { itemStyle: { color: "transparent" } },
				data: base,
				silent: true,
			},
			{
				name: "Increase",
				type: "bar",
				stack: "wf",
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
				itemStyle: {
					color: colors.negative,
					borderRadius: [2, 2, 0, 0],
				},
				data: falling,
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

	const data: [number, number, number][] = [];
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;

	for (const row of rows) {
		const x = colValues.indexOf(String(row[colField] ?? ""));
		const y = rowValues.indexOf(String(row[rowField] ?? ""));
		const value = toNumber(row[measure]) ?? 0;
		if (x < 0 || y < 0) continue;
		data.push([x, y, value]);
		if (value < min) min = value;
		if (value > max) max = value;
	}

	const scale = style?.colorScales?.[0];
	const low = colors.resolve(scale?.low, colors.surface);
	const high = colors.resolve(scale?.high, colors.series[0]);

	return {
		animation: false,
		textStyle: { color: colors.text, fontFamily: "inherit" },
		grid: { left: 8, right: 8, top: 8, bottom: 60, containLabel: true },
		tooltip: {
			...tooltip(ctx, "item"),
			formatter: (p: unknown) => {
				const e = p as { value: [number, number, number] };
				return `${rowValues[e.value[1]]} / ${colValues[e.value[0]]}<br/><b>${formatValue(
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
		textStyle: { color: colors.text, fontFamily: "inherit" },
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
					return {
						name: String(row[dimensions[0]] ?? ""),
						value: measures.map((m) => toNumber(row[m]) ?? 0),
						lineStyle: { color },
						itemStyle: { color },
						areaStyle: { color: withAlpha(color, 0.15) },
					};
				}),
			},
		],
	};
}
