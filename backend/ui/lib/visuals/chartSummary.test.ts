import assert from "node:assert/strict";
import { test } from "node:test";
import { describeChart } from "./chartSummary";

const months = [
	{ Month: "Jan", "Net Sales": 100 },
	{ Month: "Feb", "Net Sales": 110 },
	{ Month: "Mar", "Net Sales": 150 },
];

test("a chart says what kind it is, of what, and across what", () => {
	const summary = describeChart(
		"barChart",
		months,
		["Month"],
		["Net Sales"],
		null,
	);
	assert.match(summary, /^Bar chart of Net Sales by Month, 3 points\.$/);
});

test("the visual's title leads the sentence when it has one", () => {
	const summary = describeChart(
		"barChart",
		months,
		["Month"],
		["Net Sales"],
		"Sales by month",
	);
	assert.ok(summary.startsWith("Sales by month. Bar chart"));
});

test("several measures are listed the way somebody would say them", () => {
	const summary = describeChart(
		"lineChart",
		months,
		["Month"],
		["Net Sales", "Units", "Margin"],
		null,
	);
	assert.ok(summary.includes("of Net Sales, Units and Margin"));
});

test("a chart along a time axis says which way it went", () => {
	const summary = describeChart(
		"lineChart",
		months,
		["Month"],
		["Net Sales"],
		null,
	);
	assert.ok(summary.includes("rising 50 percent from first to last"));
});

test("a fall is described as a fall", () => {
	const summary = describeChart(
		"lineChart",
		[...months].reverse(),
		["Month"],
		["Net Sales"],
		null,
	);
	assert.ok(summary.includes("falling"));
});

test("a ranked chart is not described as rising or falling", () => {
	// First and last on a bar chart are the biggest and smallest, so a
	// direction would be describing the sort order rather than the data.
	const summary = describeChart(
		"barChart",
		months,
		["Month"],
		["Net Sales"],
		null,
	);
	assert.ok(!summary.includes("rising"));
	assert.ok(!summary.includes("falling"));
});

test("a series that barely moves is called level rather than rising", () => {
	const summary = describeChart(
		"lineChart",
		[
			{ Month: "Jan", "Net Sales": 100 },
			{ Month: "Feb", "Net Sales": 100.4 },
		],
		["Month"],
		["Net Sales"],
		null,
	);
	assert.ok(summary.includes("roughly level"));
});

test("a chart with no rows says so", () => {
	assert.equal(
		describeChart("barChart", [], ["Month"], ["Net Sales"], null),
		"Bar chart with no data.",
	);
});

test("one point is one point, not one points", () => {
	const summary = describeChart(
		"barChart",
		[months[0]],
		["Month"],
		["Net Sales"],
		null,
	);
	assert.ok(summary.includes("1 point,") || summary.includes("1 point."));
});

test("a starting value of zero has no percentage to report", () => {
	const summary = describeChart(
		"lineChart",
		[
			{ Month: "Jan", "Net Sales": 0 },
			{ Month: "Feb", "Net Sales": 90 },
		],
		["Month"],
		["Net Sales"],
		null,
	);
	assert.ok(!summary.includes("percent"));
});

test("values that are not numbers do not produce a direction", () => {
	const summary = describeChart(
		"lineChart",
		[
			{ Month: "Jan", "Net Sales": null },
			{ Month: "Feb", "Net Sales": 90 },
		],
		["Month"],
		["Net Sales"],
		null,
	);
	assert.ok(!summary.includes("rising"));
});

test("a type the catalogue does not know is still described", () => {
	const summary = describeChart(
		"notAThing",
		months,
		["Month"],
		["Net Sales"],
		null,
	);
	assert.ok(summary.startsWith("Chart of Net Sales by Month"));
});

// A box plot and a histogram are answered with a summary, so the sentence has
// to describe the boxes and bars that are there rather than the grain they
// were taken over.

test("a box plot names its boxes and the grain behind them", () => {
	const summary = describeChart(
		"boxPlot",
		[
			{ Division: "Endoscopy", Median: 518 },
			{ Division: "Instruments", Median: 586 },
		],
		["Division", "Order Number"],
		["Net Sales"],
		null,
	);
	assert.equal(
		summary,
		"Box plot of Net Sales across Order Number, 2 boxes, one for each Division.",
	);
});

test("a box plot with no grouping is one box", () => {
	const summary = describeChart(
		"boxPlot",
		[{ Median: 518 }],
		["Order Number"],
		["Net Sales"],
		null,
	);
	assert.equal(
		summary,
		"Box plot of Net Sales across Order Number, one box.",
	);
});

test("a histogram counts its bars", () => {
	const summary = describeChart(
		"histogramChart",
		[{ Count: 12 }, { Count: 40 }, { Count: 3 }],
		["Invoice Number"],
		["Net Sales"],
		"Invoice value spread",
	);
	assert.equal(
		summary,
		"Invoice value spread. Histogram of Net Sales across Invoice Number, 3 bars.",
	);
});
