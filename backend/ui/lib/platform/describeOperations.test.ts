import { test } from "node:test";
import assert from "node:assert/strict";
import { describeOperations } from "./describeOperations";

const titles = new Map([["v1", "Revenue by month"]]);
const titleOf = (id: string) => titles.get(id) ?? null;

test("names a visual by its current title", () => {
	assert.deepEqual(
		describeOperations([{ type: "removeVisual", visualId: "V1" }], titleOf),
		['Removes "Revenue by month"'],
	);
});

test("falls back to the title the operation carries", () => {
	assert.deepEqual(
		describeOperations(
			[{ type: "updateVisual", visualId: "v9", title: "New one" }],
			titleOf,
		),
		['Changes "New one"'],
	);
});

test("says something readable about an untitled new visual", () => {
	assert.deepEqual(
		describeOperations(
			[{ type: "addVisual", visualType: "data_table" }],
			titleOf,
		),
		["Adds a data table"],
	);
});

test("folds repeats into one line", () => {
	const moved = { type: "reorderVisuals" };
	assert.deepEqual(describeOperations([moved, moved, moved], titleOf), [
		"Rearranges a page",
	]);
});

test("an operation it does not know still gets a line", () => {
	assert.deepEqual(describeOperations([{ type: "somethingNew" }], titleOf), [
		"Makes another change to the report",
	]);
});

test("says which part of the report changes", () => {
	const current = { description: "Old", theme: "" };
	assert.deepEqual(
		describeOperations(
			[{ type: "updateReport", description: "New", theme: "" }],
			titleOf,
			current,
		),
		['Changes the subtitle to "New"'],
	);
	assert.deepEqual(
		describeOperations(
			[{ type: "updateReport", description: "Old", theme: "ocean" }],
			titleOf,
			current,
		),
		["Changes the theme"],
	);
});
