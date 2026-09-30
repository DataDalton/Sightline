import assert from "node:assert/strict";
import { test } from "node:test";
import { keyboardMarks, stepMark } from "./chartKeys";
import { selectionFromClick } from "./selection";

// --- Stepping ----------------------------------------------------------------

test("the first step starts at the end the key points away from", () => {
	assert.equal(stepMark(-1, 5, "ArrowRight"), 0);
	assert.equal(stepMark(-1, 5, "ArrowDown"), 0);
	assert.equal(stepMark(-1, 5, "ArrowLeft"), 4);
	assert.equal(stepMark(-1, 5, "ArrowUp"), 4);
});

test("steps hold at the ends rather than wrapping", () => {
	assert.equal(stepMark(4, 5, "ArrowRight"), 4);
	assert.equal(stepMark(0, 5, "ArrowLeft"), 0);
	assert.equal(stepMark(2, 5, "ArrowRight"), 3);
});

test("Home and End jump to the ends", () => {
	assert.equal(stepMark(2, 5, "Home"), 0);
	assert.equal(stepMark(2, 5, "End"), 4);
});

test("other keys and an empty chart are not steps", () => {
	assert.equal(stepMark(2, 5, "Enter"), null);
	assert.equal(stepMark(-1, 0, "ArrowRight"), null);
});

// --- Marks -------------------------------------------------------------------

test("a bar is named by its category and clicks like one", () => {
	const option = {
		xAxis: { type: "category", data: ["North", "South"] },
		yAxis: { type: "value" },
		series: [{ type: "bar", name: "revenue", data: [10, 20] }],
	};
	const marks = keyboardMarks("barChart", option);
	assert.equal(marks.length, 2);
	assert.equal(marks[1].label, "South");
	assert.equal(marks[1].value, 20);
	assert.equal(marks[1].dataIndex, 1);
	assert.deepEqual(
		selectionFromClick("barChart", ["region"], ["revenue"], marks[1].click),
		[{ field: "region", values: ["South"] }],
	);
});

test("a silent run-up series is skipped", () => {
	const option = {
		yAxis: { type: "category", data: ["A", "B"] },
		series: [
			{ type: "bar", silent: true, data: [1, 2] },
			{ type: "bar", data: [3, 4] },
		],
	};
	const marks = keyboardMarks("timelineChart", option);
	assert.equal(marks[0].seriesIndex, 1);
	assert.equal(marks[0].label, "A");
	assert.equal(marks[0].value, 3);
});

test("forecast periods and marks are not steps", () => {
	// The shape a chart with a forecast is built in. The measured series
	// stops at its last period, and the forecast line and its range after
	// it are silent series on the same axis.
	const option = {
		xAxis: {
			type: "category",
			data: ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"],
		},
		yAxis: { type: "value" },
		series: [
			{ type: "line", name: "revenue", data: [10, 20] },
			{
				id: "forecast:revenue",
				type: "line",
				name: "Forecast",
				silent: true,
				data: [null, 20, 24, 26],
			},
			{
				id: "forecast-low:revenue",
				type: "line",
				name: "Forecast",
				silent: true,
				data: [null, 20, 21, 22],
			},
		],
	};
	const marks = keyboardMarks("lineChart", option);
	assert.equal(marks.length, 2);
	assert.deepEqual(
		marks.map((mark) => [mark.seriesIndex, mark.label]),
		[
			[0, "2026-06-01"],
			[0, "2026-07-01"],
		],
	);
});

test("a slice keeps its own name", () => {
	const option = {
		series: [
			{
				type: "pie",
				data: [
					{ name: "Online", value: 5 },
					{ name: "Store", value: 7 },
				],
			},
		],
	};
	const marks = keyboardMarks("pieChart", option);
	assert.deepEqual(
		marks.map((m) => [m.label, m.value]),
		[
			["Online", 5],
			["Store", 7],
		],
	);
});

test("a sankey node is labelled by its row value and selects its side", () => {
	const option = {
		series: [
			{
				type: "sankey",
				data: [
					{ name: "0:Web", raw: "Web", side: 0 },
					{ name: "1:Paid", raw: "Paid", side: 1 },
				],
			},
		],
	};
	const marks = keyboardMarks("sankeyChart", option);
	assert.equal(marks[1].label, "Paid");
	assert.deepEqual(
		selectionFromClick(
			"sankeyChart",
			["source", "outcome"],
			["count"],
			marks[1].click,
		),
		[{ field: "outcome", values: ["Paid"] }],
	);
});

test("a treemap tile is found by name", () => {
	const option = {
		series: [{ type: "treemap", data: [{ name: "Tools", value: 4 }] }],
	};
	const [mark] = keyboardMarks("treemapChart", option);
	assert.equal(mark.dataIndex, undefined);
	assert.equal(mark.name, "Tools");
});

test("a slope chart steps across its lines", () => {
	const option = {
		series: [
			{ type: "line", name: "North", data: [1, 2] },
			{ type: "line", name: "South", data: [3, 5] },
		],
	};
	const marks = keyboardMarks("slopeChart", option);
	assert.deepEqual(
		marks.map((m) => [m.seriesIndex, m.label, m.value]),
		[
			[0, "North", 2],
			[1, "South", 5],
		],
	);
	assert.deepEqual(
		selectionFromClick(
			"slopeChart",
			["region"],
			["revenue"],
			marks[1].click,
		),
		[{ field: "region", values: ["South"] }],
	);
});

test("an option with no series has no marks", () => {
	assert.deepEqual(keyboardMarks("barChart", null), []);
	assert.deepEqual(keyboardMarks("barChart", { series: [] }), []);
});
