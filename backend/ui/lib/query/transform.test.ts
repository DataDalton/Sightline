import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTransforms, type QueryTransform } from "./transform";

const rows = () => [
	{ Region: "North", Sales: 40, Units: 4 },
	{ Region: "South", Sales: 30, Units: 6 },
	{ Region: "East", Sales: 20, Units: 5 },
	{ Region: "West", Sales: 10, Units: 1 },
];

const columns = ["Region", "Sales", "Units"];

const run = (transforms: QueryTransform[], data = rows()) =>
	applyTransforms(data, columns, transforms);

test("no transforms leaves the answer exactly as it was", () => {
	const data = rows();
	const result = applyTransforms(data, columns, []);
	assert.equal(result.rows, data);
	assert.equal(result.columns, columns);
});

test("share of total is each row against the column's sum", () => {
	const { rows: out, columns: cols } = run([
		{ kind: "percentOfTotal", measure: "Sales", as: "Share" },
	]);
	assert.deepEqual(
		out.map((r) => r.Share),
		[40, 30, 20, 10],
	);
	assert.ok(cols.includes("Share"));
});

test("a column that sums to zero has no shares in it", () => {
	const { rows: out } = run(
		[{ kind: "percentOfTotal", measure: "Sales", as: "Share" }],
		[
			{ Region: "North", Sales: 0, Units: 0 },
			{ Region: "South", Sales: 0, Units: 0 },
		],
	);
	assert.deepEqual(
		out.map((r) => r.Share),
		[null, null],
	);
});

test("a running total accumulates down the rows as they arrive", () => {
	const { rows: out } = run([
		{ kind: "runningTotal", measure: "Sales", as: "Cumulative" },
	]);
	assert.deepEqual(
		out.map((r) => r.Cumulative),
		[40, 70, 90, 100],
	);
});

test("a gap neither resets a running total nor adds to it", () => {
	const { rows: out } = run(
		[{ kind: "runningTotal", measure: "Sales", as: "Cumulative" }],
		[
			{ Region: "A", Sales: 10, Units: 1 },
			{ Region: "B", Sales: null as unknown as number, Units: 1 },
			{ Region: "C", Sales: 5, Units: 1 },
		],
	);
	assert.deepEqual(
		out.map((r) => r.Cumulative),
		[10, 10, 15],
	);
});

test("rank counts down from the largest by default", () => {
	const { rows: out } = run([
		{ kind: "rank", measure: "Sales", as: "Position" },
	]);
	assert.deepEqual(
		out.map((r) => r.Position),
		[1, 2, 3, 4],
	);
});

test("rank can count up from the smallest instead", () => {
	const { rows: out } = run([
		{ kind: "rank", measure: "Sales", as: "Position", direction: "asc" },
	]);
	assert.deepEqual(
		out.map((r) => r.Position),
		[4, 3, 2, 1],
	);
});

test("a tie shares a position and the next value skips past it", () => {
	const { rows: out } = run(
		[{ kind: "rank", measure: "Sales", as: "Position" }],
		[
			{ Region: "A", Sales: 10, Units: 1 },
			{ Region: "B", Sales: 10, Units: 1 },
			{ Region: "C", Sales: 5, Units: 1 },
		],
	);
	assert.deepEqual(
		out.map((r) => r.Position),
		[1, 1, 3],
	);
});

test("a row with nothing in the column is unranked rather than last", () => {
	const { rows: out } = run(
		[{ kind: "rank", measure: "Sales", as: "Position" }],
		[
			{ Region: "A", Sales: 10, Units: 1 },
			{ Region: "B", Sales: null as unknown as number, Units: 1 },
		],
	);
	assert.deepEqual(
		out.map((r) => r.Position),
		[1, null],
	);
});

test("a ratio divides one column by another", () => {
	const { rows: out } = run([
		{
			kind: "ratio",
			measure: "Sales",
			denominator: "Units",
			as: "Per unit",
		},
	]);
	assert.deepEqual(
		out.map((r) => r["Per unit"]),
		[10, 5, 4, 10],
	);
});

test("a ratio can be scaled so it reads as a percentage", () => {
	const { rows: out } = run(
		[
			{
				kind: "ratio",
				measure: "Units",
				denominator: "Sales",
				as: "Rate",
				scale: 100,
			},
		],
		[{ Region: "A", Sales: 50, Units: 5 }],
	);
	assert.equal(out[0].Rate, 10);
});

test("dividing by zero has no answer rather than an infinite one", () => {
	const { rows: out } = run(
		[
			{
				kind: "ratio",
				measure: "Sales",
				denominator: "Units",
				as: "Per unit",
			},
		],
		[{ Region: "A", Sales: 10, Units: 0 }],
	);
	assert.equal(out[0]["Per unit"], null);
});

test("indexing puts the first figure at 100 and the rest against it", () => {
	const { rows: out } = run(
		[{ kind: "indexTo", measure: "Sales", as: "Index" }],
		[
			{ Region: "A", Sales: 50, Units: 1 },
			{ Region: "B", Sales: 75, Units: 1 },
			{ Region: "C", Sales: 25, Units: 1 },
		],
	);
	assert.deepEqual(
		out.map((r) => r.Index),
		[100, 150, 50],
	);
});

test("a series opening with a gap indexes against the first real figure", () => {
	const { rows: out } = run(
		[{ kind: "indexTo", measure: "Sales", as: "Index" }],
		[
			{ Region: "A", Sales: null as unknown as number, Units: 1 },
			{ Region: "B", Sales: 40, Units: 1 },
			{ Region: "C", Sales: 80, Units: 1 },
		],
	);
	assert.deepEqual(
		out.map((r) => r.Index),
		[null, 100, 200],
	);
});

test("a later transform can read a column an earlier one produced", () => {
	const { rows: out, columns: cols } = run([
		{ kind: "runningTotal", measure: "Sales", as: "Cumulative" },
		{ kind: "percentOfTotal", measure: "Cumulative", as: "Cumulative %" },
	]);
	assert.ok(cols.includes("Cumulative %"));
	// 40 + 70 + 90 + 100 is 300, so the first row is 40 of 300.
	assert.equal(Math.round(out[0]["Cumulative %"] as number), 13);
});

test("the original rows are not written through", () => {
	const data = rows();
	run([{ kind: "runningTotal", measure: "Sales", as: "Cumulative" }], data);
	assert.equal("Cumulative" in data[0], false);
});

test("a name used twice overwrites rather than appearing twice", () => {
	const { columns: cols } = run([
		{ kind: "runningTotal", measure: "Sales", as: "Figure" },
		{ kind: "percentOfTotal", measure: "Sales", as: "Figure" },
	]);
	assert.equal(cols.filter((c) => c === "Figure").length, 1);
});

test("values arriving as strings are still arithmetic", () => {
	const { rows: out } = run(
		[{ kind: "runningTotal", measure: "Sales", as: "Cumulative" }],
		[
			{ Region: "A", Sales: "10" as unknown as number, Units: 1 },
			{ Region: "B", Sales: "5" as unknown as number, Units: 1 },
		],
	);
	assert.deepEqual(
		out.map((r) => r.Cumulative),
		[10, 15],
	);
});
