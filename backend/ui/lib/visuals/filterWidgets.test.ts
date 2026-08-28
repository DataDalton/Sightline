import assert from "node:assert/strict";
import { test } from "node:test";
import { filterWidgetsOf } from "./filterWidgets";

const visual = (
	visualId: string,
	visualType: string,
	dimensions: string[] = [],
	measures: string[] = [],
) => ({ visualId, visualType, config: { dimensions, measures } });

test("a control that filters a category takes its first dimension", () => {
	assert.deepEqual(
		filterWidgetsOf([
			visual("w1", "dropdownFilter", ["Business Unit", "Region"]),
		]),
		[{ visualId: "w1", field: "Business Unit" }],
	);
});

test("a threshold takes its measure rather than its dimension", () => {
	// It cuts on a figure, so the dimension beside it is what the figure is
	// grouped by rather than what is being tested.
	assert.deepEqual(
		filterWidgetsOf([
			visual("w1", "thresholdControl", ["Region"], ["Net Sales"]),
		]),
		[{ visualId: "w1", field: "Net Sales" }],
	);
});

test("a numeric range takes its measure too", () => {
	assert.deepEqual(
		filterWidgetsOf([
			visual("w1", "numericRangeFilter", ["Region"], ["Units"]),
		]),
		[{ visualId: "w1", field: "Units" }],
	);
});

test("a numeric range over a dimension still finds its field", () => {
	assert.deepEqual(
		filterWidgetsOf([visual("w1", "numericRangeFilter", ["Order Year"])]),
		[{ visualId: "w1", field: "Order Year" }],
	);
});

test("a filter group is one control per field, not one control", () => {
	// Every field after the first would be lost from a link if this were
	// treated as a single control.
	assert.deepEqual(
		filterWidgetsOf([
			visual("g", "filterBar", ["Region", "Business Unit", "Channel"]),
		]),
		[
			{ visualId: "g:Region", field: "Region" },
			{ visualId: "g:Business Unit", field: "Business Unit" },
			{ visualId: "g:Channel", field: "Channel" },
		],
	);
});

test("a search box writes against its first field", () => {
	assert.deepEqual(
		filterWidgetsOf([
			visual("w1", "searchFilter", ["Product Family", "Product Name"]),
		]),
		[{ visualId: "w1", field: "Product Family" }],
	);
});

test("visuals that are not filters are left out", () => {
	assert.deepEqual(
		filterWidgetsOf([
			visual("c1", "barChart", ["Region"], ["Net Sales"]),
			visual("t1", "table", ["Region"], ["Net Sales"]),
			visual("k1", "kpiRow", [], ["Net Sales"]),
		]),
		[],
	);
});

test("a control with nothing encoded owns no field", () => {
	assert.deepEqual(filterWidgetsOf([visual("w1", "dropdownFilter")]), []);
});

test("every filter on a page is found", () => {
	const found = filterWidgetsOf([
		visual("d", "dateRangeFilter", ["Order Date"]),
		visual("u", "dropdownFilter", ["Business Unit"]),
		visual("c", "barChart", ["Region"], ["Net Sales"]),
		visual("p", "presenceFilter", ["Notes"]),
		visual("t", "toggleFilter", ["Is Returned"]),
	]);
	assert.deepEqual(
		found.map((w) => w.field),
		["Order Date", "Business Unit", "Notes", "Is Returned"],
	);
});
