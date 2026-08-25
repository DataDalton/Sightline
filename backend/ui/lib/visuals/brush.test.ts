import assert from "node:assert/strict";
import { test } from "node:test";
import { indicesToValues, rangeToIndices } from "./brush";

const rows = [
	{ month: "2026-01", sales: 1 },
	{ month: "2026-02", sales: 2 },
	{ month: "2026-03", sales: 3 },
	{ month: "2026-04", sales: 4 },
];

test("a region covering the middle two categories selects them", () => {
	assert.deepEqual(rangeToIndices([1, 2], rows.length), [1, 2]);
});

test("edges landing between categories include the ones reached", () => {
	assert.deepEqual(rangeToIndices([0.6, 2.4], rows.length), [1, 2]);
});

test("drawn right to left is the same selection", () => {
	assert.deepEqual(
		rangeToIndices([2, 1], rows.length),
		rangeToIndices([1, 2], rows.length),
	);
});

test("a region running past the ends is clamped to the data", () => {
	assert.deepEqual(rangeToIndices([-4, 99], rows.length), [0, 1, 2, 3]);
});

test("no region selects nothing rather than everything", () => {
	assert.deepEqual(rangeToIndices(null, rows.length), []);
	assert.deepEqual(rangeToIndices([], rows.length), []);
	assert.deepEqual(rangeToIndices(["a", "b"], rows.length), []);
});

test("a range of values rather than indices selects nothing, not everything", () => {
	// What a date axis reports: milliseconds, nowhere near an index.
	assert.deepEqual(rangeToIndices([1767225600000, 1769817600000], rows.length), []);
});

test("values come back in order, without blanks or repeats", () => {
	const withGap = [
		{ month: "2026-01" },
		{ month: null },
		{ month: "2026-01" },
		{ month: "2026-02" },
	];
	assert.deepEqual(
		indicesToValues([0, 1, 2, 3], withGap, "month"),
		["2026-01", "2026-02"],
	);
});

test("an index past the end is skipped rather than becoming empty text", () => {
	assert.deepEqual(indicesToValues([0, 9], rows, "month"), ["2026-01"]);
});
