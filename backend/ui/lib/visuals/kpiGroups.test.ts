import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveKpiGroups } from "./kpiGroups";

// The rule worth pinning: every measure an author encoded ends up somewhere.
// A band definition and a measure list are edited separately and drift apart,
// and the failure that matters is a figure the author added and cannot find.

const four = ["a", "b", "c", "d"];

function allOf(groups: { measures: string[] }[]): string[] {
	return groups.flatMap((g) => g.measures);
}

test("no bands is one unlabelled row, which is what it always was", () => {
	assert.deepEqual(resolveKpiGroups(four, undefined), [
		{ label: null, measures: four },
	]);
	assert.deepEqual(resolveKpiGroups(four, []), [
		{ label: null, measures: four },
	]);
});

test("bands take their measures in order", () => {
	const bands = resolveKpiGroups(four, [
		{ label: "Headline", count: 2 },
		{ label: "Ratios", count: 2 },
	]);
	assert.deepEqual(bands, [
		{ label: "Headline", measures: ["a", "b"] },
		{ label: "Ratios", measures: ["c", "d"] },
	]);
});

test("a measure added after the bands were set still appears", () => {
	// The author adds a fifth measure and does not touch the bands. It lands in
	// a final unlabelled row rather than vanishing.
	const bands = resolveKpiGroups(
		[...four, "e"],
		[
			{ label: "Headline", count: 2 },
			{ label: "Ratios", count: 2 },
		],
	);
	assert.deepEqual(allOf(bands), ["a", "b", "c", "d", "e"]);
	assert.equal(bands[2].label, null);
	assert.deepEqual(bands[2].measures, ["e"]);
});

test("bands that outrun the measures do not leave empty rows", () => {
	// Two measures were removed and the counts were not updated.
	const bands = resolveKpiGroups(
		["a", "b"],
		[
			{ label: "Headline", count: 2 },
			{ label: "Ratios", count: 2 },
			{ label: "Counts", count: 2 },
		],
	);
	assert.equal(bands.length, 1);
	assert.deepEqual(bands[0].measures, ["a", "b"]);
});

test("a band asking for more than is left takes what is left", () => {
	const bands = resolveKpiGroups(
		["a", "b", "c"],
		[
			{ label: "Headline", count: 2 },
			{ label: "Rest", count: 9 },
		],
	);
	assert.deepEqual(allOf(bands), ["a", "b", "c"]);
	assert.deepEqual(bands[1].measures, ["c"]);
});

test("a count of zero takes one rather than leaving a label over nothing", () => {
	const bands = resolveKpiGroups(four, [
		{ label: "Odd", count: 0 },
		{ label: "Rest", count: 3 },
	]);
	assert.deepEqual(bands[0].measures, ["a"]);
	assert.deepEqual(allOf(bands), four);
});

test("a blank label is no label, not an empty heading", () => {
	const bands = resolveKpiGroups(four, [
		{ label: "   ", count: 2 },
		{ count: 2 },
	]);
	assert.equal(bands[0].label, null);
	assert.equal(bands[1].label, null);
});

test("no measures is nothing to lay out", () => {
	assert.deepEqual(
		resolveKpiGroups([], [{ label: "Headline", count: 2 }]),
		[],
	);
	assert.deepEqual(resolveKpiGroups([], undefined), []);
});
