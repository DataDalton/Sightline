import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildBullet,
	buildCartesian,
	buildFunnel,
	buildHeatmap,
	buildPie,
	buildRadar,
	buildScatter,
	buildWaterfall,
	type ChartContext,
} from "./chartOptions";
import type { ThemeColors } from "./colors";
import { withUpdateMarkers } from "./updateMarkers";

// What each builder hands the chart library, for the settings an author can
// change. A setting that reaches the editor and stops here looks like it works
// and does nothing, and nothing else in the suite would say so.

const colors = {
	series: ["#112233", "#445566"],
	grid: "#222222",
	axis: "#888888",
	text: "#cccccc",
	textMuted: "#999999",
	surface: "#000000",
	tooltipBg: "#000000",
	tooltipText: "#ffffff",
	positive: "#00ff00",
	negative: "#ff0000",
	font: "sans-serif",
	resolve: (spec: unknown, fallback: string) => {
		if (!spec) return fallback;
		const held = spec as { hex?: string; token?: string };
		return held.hex ?? `token:${held.token}`;
	},
} as unknown as ThemeColors;

const base: ChartContext = {
	colors,
	hintFor: () => "decimal",
	dimensions: ["name"],
	measures: ["value"],
	rows: [
		{ name: "small", value: 1 },
		{ name: "big", value: 9 },
	],
};

// The builders return a shape only the chart library reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Option = any;

const fill = (value: "none" | "solid" | "gradient") => ({
	series: [{ measure: "value", fill: value }],
});

test("a horizontal bar chart reads from the top", () => {
	const option: Option = buildCartesian(
		{ ...base, options: { sortBy: "valueDesc" } },
		"bar",
		"horizontal",
	);
	assert.equal(option.yAxis.inverse, true);
	assert.equal(option.yAxis.data[0], "big");
});

test("a list of bars shows every name that fits, cut to a width", () => {
	const option: Option = buildCartesian(base, "bar", "horizontal");
	assert.equal(option.yAxis.axisLabel.interval, 0);
	assert.equal(option.yAxis.axisLabel.hideOverlap, true);
	assert.equal(option.yAxis.axisLabel.overflow, "truncate");
});

test("an area chart fills unless told not to, and a line does not", () => {
	const filled: Option = buildCartesian(base, "area");
	assert.notEqual(filled.series[0].areaStyle, undefined);
	const none: Option = buildCartesian(
		{ ...base, style: fill("none") },
		"area",
	);
	assert.equal(none.series[0].areaStyle, undefined);
	const line: Option = buildCartesian(base, "line");
	assert.equal(line.series[0].areaStyle, undefined);
});

test("a gradient bar is a gradient along its length", () => {
	const upright: Option = buildCartesian(
		{ ...base, style: fill("gradient") },
		"bar",
	);
	assert.equal(upright.series[0].itemStyle.color.type, "linear");
	assert.equal(upright.series[0].itemStyle.color.y2, 1);
	const across: Option = buildCartesian(
		{ ...base, style: fill("gradient") },
		"bar",
		"horizontal",
	);
	assert.equal(across.series[0].itemStyle.color.x, 1);
});

test("a gradient bar still forecasts in its own colour", () => {
	const option: Option = buildCartesian(
		{ ...base, style: fill("gradient") },
		"bar",
	);
	assert.equal(option.series[0].baseColor, "#112233");
});

test("the axis settings the editor offers reach the chart", () => {
	const option: Option = buildCartesian(
		{
			...base,
			style: {
				yAxis: { min: 5, max: 50, showGrid: false },
				xAxis: { label: "Names", labelRotation: 45 },
			},
		},
		"bar",
	);
	assert.equal(option.yAxis.min, 5);
	assert.equal(option.yAxis.max, 50);
	assert.equal(option.yAxis.splitLine.show, false);
	assert.equal(option.xAxis.name, "Names");
	assert.equal(option.xAxis.axisLabel.rotate, 45);
});

test("how a line is drawn reaches the chart", () => {
	const option: Option = buildCartesian(
		{
			...base,
			style: {
				series: [
					{
						measure: "value",
						smooth: true,
						lineWidth: 4,
						showPoints: false,
					},
				],
			},
		},
		"line",
	);
	assert.equal(option.series[0].smooth, true);
	assert.equal(option.series[0].lineStyle.width, 4);
	assert.equal(option.series[0].showSymbol, false);
});

test("a legend below the chart makes room for itself", () => {
	const above: Option = buildCartesian(base, "bar");
	const below: Option = buildCartesian(
		{ ...base, style: { legend: { position: "bottom" } } },
		"bar",
	);
	assert.ok(below.grid.bottom > above.grid.bottom);
	assert.equal(below.legend.bottom, 0);
});

test("charts whose marks are rows take the chosen set of colours", () => {
	const style = { palette: ["success" as const] };
	const pie: Option = buildPie({ ...base, style }, false);
	assert.equal(pie.series[0].data[0].itemStyle.color, "token:success");
	const funnel: Option = buildFunnel({ ...base, style });
	assert.equal(funnel.series[0].data[0].itemStyle.color, "token:success");
	const radar: Option = buildRadar({
		...base,
		measures: ["value", "value"],
		style,
	});
	assert.equal(radar.series[0].data[0].itemStyle.color, "token:success");
});

const bullet: ChartContext = {
	...base,
	measures: ["actual", "target"],
	rows: [
		{ name: "ahead", actual: 9, target: 10 },
		{ name: "behind", actual: 1, target: 10 },
	],
};

test("a bullet chart opens furthest behind first, as the editor says", () => {
	const option: Option = buildBullet(bullet);
	assert.equal(option.yAxis.data[0], "behind");
});

test("a bullet chart takes its colour and value axis settings", () => {
	const option: Option = buildBullet({
		...bullet,
		options: { colourByTarget: false },
		style: {
			series: [{ measure: "actual", color: { token: "info" } }],
			yAxis: { label: "Sales", beginAtZero: false },
		},
	});
	assert.equal(option.series[0].data[0].itemStyle.color, "token:info");
	assert.equal(option.xAxis.name, "Sales");
	assert.equal(option.xAxis.scale, true);
});

test("a waterfall draws its reference lines", () => {
	const option: Option = buildWaterfall({
		...base,
		style: { referenceLines: [{ id: "r", kind: "value", value: 5 }] },
	});
	assert.equal(option.series[1].markLine.data.length, 1);
});

test("a heatmap takes its colour scale", () => {
	const option: Option = buildHeatmap({
		...base,
		dimensions: ["name", "other"],
		rows: [{ name: "a", other: "b", value: 1 }],
		style: {
			colorScales: [
				{
					field: "value",
					kind: "diverging",
					low: { token: "warning" },
					high: { token: "info" },
				},
			],
		},
	});
	assert.equal(option.visualMap.inRange.color[0], "token:warning");
	assert.equal(option.visualMap.inRange.color[2], "token:info");
});

const scatterRows: ChartContext = {
	...base,
	measures: ["across", "up"],
	rows: [
		{ name: "a", across: 1, up: 100 },
		{ name: "b", across: 3, up: 300 },
	],
};

test("a scatter chart takes its colour", () => {
	const option: Option = buildScatter({
		...scatterRows,
		style: {
			series: [{ measure: "across", color: { token: "danger" } }],
		},
	});
	assert.equal(option.series[0].itemStyle.color, "token:danger");
});

test("a scatter chart's average line reads the vertical measure", () => {
	const option: Option = buildScatter({
		...scatterRows,
		style: { referenceLines: [{ id: "r", kind: "average" }] },
	});
	assert.equal(option.series[0].markLine.data[0].yAxis, 200);
});

test("an update's effective date lands on a time axis", () => {
	const option: Option = buildCartesian(
		{
			...base,
			rows: [
				{ name: "2026-01-01", value: 1 },
				{ name: "2026-02-01", value: 2 },
				{ name: "2026-03-01", value: 3 },
			],
		},
		"line",
		"vertical",
	);
	const marked: Option = withUpdateMarkers(option, [
		{ at: "2026-01-15T00:00:00Z", label: "Definition changed" },
	]);
	assert.equal(marked.series[0].markLine.data[0].xAxis, "2026-02-01");
	assert.equal(marked.series[0].markLine.data[0].name, "Definition changed");
});

test("a chart of names is left alone by update markers", () => {
	const option: Option = buildCartesian(base, "bar", "vertical");
	assert.equal(
		withUpdateMarkers(option, [{ at: "2026-01-15", label: "x" }]),
		option,
	);
});
