import assert from "node:assert/strict";
import { test } from "node:test";
import {
	evaluateConditions,
	referenceValue,
	scalePosition,
	styleForMeasure,
	type ConditionRule,
	type VisualStyle,
} from "./style";

test("a series falls back to the palette by index", () => {
	const style: VisualStyle = { palette: ["chart-3", "chart-5"] };
	assert.deepEqual(styleForMeasure(style, "Net Sales", 0).color, {
		token: "chart-3",
	});
	assert.deepEqual(styleForMeasure(style, "Units", 1).color, {
		token: "chart-5",
	});
	// Wraps rather than running out.
	assert.deepEqual(styleForMeasure(style, "Freight", 2).color, {
		token: "chart-3",
	});
});

test("an explicit series colour beats the palette", () => {
	const style: VisualStyle = {
		palette: ["chart-1"],
		series: [{ measure: "Net Sales", color: { hex: "#ff0000" } }],
	};
	assert.deepEqual(styleForMeasure(style, "Net Sales", 0).color, {
		hex: "#ff0000",
	});
});

test("a default series entry applies to measures with no entry", () => {
	const style: VisualStyle = {
		series: [{ fill: "gradient", fillOpacity: 0.4 }],
	};
	const resolved = styleForMeasure(style, "Anything", 0);
	assert.equal(resolved.fill, "gradient");
	assert.equal(resolved.fillOpacity, 0.4);
});

test("smoothing is off unless asked for", () => {
	// A smoothed line implies measurements between the points that were never
	// taken, so it is never the default.
	assert.equal(styleForMeasure(undefined, "Net Sales", 0).smooth, false);
});

test("a threshold rule matches and carries a marker", () => {
	const rules: ConditionRule[] = [
		{
			field: "Margin",
			operator: "lt",
			value: 0,
			background: { token: "danger" },
			marker: "▼",
		},
	];

	const hit = evaluateConditions(rules, { Margin: -25 }, "Margin");
	assert.ok(hit);
	assert.deepEqual(hit.background, { token: "danger" });
	// The marker exists so the meaning survives greyscale and colour vision
	// deficiency, rather than living only in the fill.
	assert.equal(hit.marker, "▼");

	assert.equal(evaluateConditions(rules, { Margin: 25 }, "Margin"), null);
});

test("applyTo row paints a different column than the one tested", () => {
	const rules: ConditionRule[] = [
		{
			field: "Margin",
			operator: "lt",
			value: 0,
			applyTo: "row",
			background: { token: "danger" },
		},
	];
	// Tested on Margin, applied to a different column.
	assert.ok(evaluateConditions(rules, { Margin: -5 }, "Net Sales"));
});

test("later rules override earlier ones field by field", () => {
	const rules: ConditionRule[] = [
		{
			field: "V",
			operator: "gt",
			value: 0,
			background: { token: "info" },
			bold: true,
		},
		{
			field: "V",
			operator: "gt",
			value: 100,
			background: { token: "success" },
		},
	];
	const hit = evaluateConditions(rules, { V: 500 }, "V");
	assert.ok(hit);
	// The second rule replaced the background but left the weight alone.
	assert.deepEqual(hit.background, { token: "success" });
	assert.equal(hit.bold, true);
});

test("between and top rank operators", () => {
	const between: ConditionRule[] = [
		{ field: "V", operator: "between", value: 10, value2: 20, bold: true },
	];
	assert.ok(evaluateConditions(between, { V: 15 }, "V"));
	assert.equal(evaluateConditions(between, { V: 25 }, "V"), null);

	const top: ConditionRule[] = [
		{ field: "V", operator: "top", value: 3, bold: true },
	];
	assert.ok(
		evaluateConditions(top, { V: 1 }, "V", { position: 1, total: 100 }),
	);
	assert.equal(
		evaluateConditions(top, { V: 1 }, "V", { position: 50, total: 100 }),
		null,
	);
});

test("a sequential scale positions a value in the range", () => {
	assert.deepEqual(scalePosition(50, 0, 100), { ratio: 0.5, side: "high" });
	assert.deepEqual(scalePosition(0, 0, 100), { ratio: 0, side: "high" });
});

test("a diverging scale splits at the midpoint", () => {
	// Below the pivot reads as low, above as high, each scaled within its own
	// half so a small loss does not look like a large one.
	const below = scalePosition(-50, -100, 100, 0);
	assert.deepEqual(below, { ratio: 0.5, side: "low" });

	const above = scalePosition(50, -100, 100, 0);
	assert.deepEqual(above, { ratio: 0.5, side: "high" });
});

test("a degenerate range produces no scale rather than an extreme", () => {
	// Every value identical: colouring them all at one end would imply a
	// spread that is not there.
	assert.equal(scalePosition(5, 5, 5), null);
	assert.equal(scalePosition(Number.NaN, 0, 10), null);
});

// --- Reference lines -------------------------------------------------------

const rows = [{ sales: 10 }, { sales: 20 }, { sales: 30 }, { sales: 40 }];

test("a fixed reference line sits where it was set", () => {
	assert.equal(
		referenceValue({ id: "a", kind: "value", value: 25 }, rows, "sales"),
		25,
	);
});

test("a fixed reference line with no number cannot be placed", () => {
	assert.equal(
		referenceValue({ id: "a", kind: "value" }, rows, "sales"),
		null,
	);
});

test("the average line is the mean of the values on the chart", () => {
	assert.equal(
		referenceValue({ id: "a", kind: "average" }, rows, "sales"),
		25,
	);
});

test("the median of an even count averages the middle two", () => {
	assert.equal(
		referenceValue({ id: "a", kind: "median" }, rows, "sales"),
		25,
	);
});

test("the median of an odd count is the middle value", () => {
	assert.equal(
		referenceValue({ id: "a", kind: "median" }, rows.slice(0, 3), "sales"),
		20,
	);
});

test("the highest and lowest lines sit on the extremes", () => {
	assert.equal(referenceValue({ id: "a", kind: "max" }, rows, "sales"), 40);
	assert.equal(referenceValue({ id: "a", kind: "min" }, rows, "sales"), 10);
});

test("a derived line over a column with no numbers cannot be placed", () => {
	assert.equal(
		referenceValue(
			{ id: "a", kind: "average" },
			[{ sales: "n/a" }],
			"sales",
		),
		null,
	);
});

test("values that are not numbers are left out of the average", () => {
	// Two readable values, so the mean is theirs rather than being dragged
	// towards zero by the ones that are not there.
	assert.equal(
		referenceValue(
			{ id: "a", kind: "average" },
			[{ sales: 10 }, { sales: null }, { sales: 30 }],
			"sales",
		),
		20,
	);
});
