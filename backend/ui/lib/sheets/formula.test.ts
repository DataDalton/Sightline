import { test } from "node:test";
import assert from "node:assert/strict";
import {
	computeColumns,
	evaluate,
	FormulaError,
	FormulaSyntaxError,
	isError,
	parse,
	references,
	type Context,
	type Value,
} from "./formula";

function run(formula: string, row: Record<string, Value> = {}): Value {
	const ctx: Context = {
		index: 0,
		get: (name) => (name in row ? row[name] : undefined),
		column: () => undefined,
	};
	return evaluate(parse(formula), ctx);
}

test("arithmetic follows the usual order", () => {
	assert.equal(run("1 + 2 * 3"), 7);
	assert.equal(run("(1 + 2) * 3"), 9);
	assert.equal(run("2 ^ 3 ^ 2"), 512, "power groups to the right");
	assert.equal(run("-2 ^ 2"), -4);
	assert.equal(run("10 - 4 - 3"), 3, "minus groups to the left");
	assert.equal(run("= 50%"), 0.5, "a leading = and a trailing % both read");
});

test("columns are read by name, and a decimal string counts as a number", () => {
	assert.equal(
		run("[Revenue] / [Units]", { Revenue: "1000.50", Units: 2 }),
		500.25,
	);
	assert.equal(
		run('[Region] & " · " & [Units]', { Region: "West", Units: 3 }),
		"West · 3",
	);
});

test("errors say what went wrong and carry through", () => {
	assert.equal(String(run("1 / 0")), "#DIV/0!");
	assert.equal(String(run("[Nope] + 1")), "#REF!");
	assert.equal(String(run("NOPE(1)")), "#NAME?");
	assert.equal(String(run('"abc" * 2')), "#VALUE!");
	assert.equal(String(run("(1 / 0) + 5")), "#DIV/0!");
	assert.equal(run("IFERROR(1 / 0, 0)"), 0);
});

test("IF only evaluates the branch it takes", () => {
	assert.equal(
		run("IF([Units] = 0, 0, [Revenue] / [Units])", {
			Units: 0,
			Revenue: 5,
		}),
		0,
	);
	assert.equal(run('IF([Units] > 1, "many", "one")', { Units: 3 }), "many");
});

test("comparison is numeric for numbers and case-blind for text", () => {
	assert.equal(run('"10" > 9'), true);
	assert.equal(run('"west" = "WEST"'), true);
	assert.equal(run('"a" <> "b"'), true);
});

test("functions", () => {
	assert.equal(run("ROUND(3.14159, 2)"), 3.14);
	assert.equal(run("MAX(1, 5, 3)"), 5);
	assert.equal(run("AVERAGE(2, 4)"), 3);
	assert.equal(run('SUM(1, "", 2)'), 3);
	assert.equal(run('LEFT("Hardware", 4)'), "Hard");
	assert.equal(run("UPPER([Region])", { Region: "West" }), "WEST");
	assert.equal(run("COALESCE([A], [B], 0)", { A: null, B: 7 }), 7);
	assert.equal(run("MOD(-1, 3)"), 2);
	assert.equal(run('YEAR("2026-03-04")'), 2026);
	assert.equal(run('DAYS("2026-03-01", "2026-03-11")'), 10);
	assert.equal(run('AND(TRUE, 1, "x" = "x")'), true);
	assert.equal(run("ISBLANK([A])", { A: "" }), true);
	assert.equal(String(run("ROUND(1, 2, 3)")), "#VALUE!");
});

test("reads syntax problems back in words", () => {
	assert.throws(() => parse("1 +"), FormulaSyntaxError);
	assert.throws(() => parse("[Revenue"), /not closed/);
	assert.throws(() => parse("Revenue * 2"), /square brackets/);
	assert.throws(() => parse('"open'), /quote/);
	assert.throws(() => parse(""), /empty/);
	assert.throws(() => parse("1 2"), /more after/);
});

test("lists what a formula reads", () => {
	assert.deepEqual(
		references(parse("IF([A] > 0, [B] / TOTAL([B]), [A])")).sort(),
		["A", "B"],
	);
});

const rows = [
	{ Region: "West", Revenue: 50 },
	{ Region: "East", Revenue: 30 },
	{ Region: "North", Revenue: 20 },
];

test("computes a sheet's formula columns, including ones that read each other and the column", () => {
	const out = computeColumns(
		rows,
		["Region", "Revenue"],
		[
			{ id: "a", name: "Share", formula: "SHARE([Revenue])" },
			{ id: "b", name: "Share pct", formula: "ROUND([share] * 100, 1)" },
			{ id: "c", name: "Rank", formula: "RANK([Revenue])" },
			{
				id: "d",
				name: "Change",
				formula: "[Revenue] - PREVIOUS([Revenue])",
			},
			{ id: "e", name: "Running", formula: "RUNNING([Revenue])" },
			{
				id: "f",
				name: "Of total",
				formula: "[Revenue] / TOTAL([Revenue])",
			},
		],
	);
	assert.deepEqual(out.problems, {});
	assert.deepEqual(
		out.values.map((v) => v["Share pct"]),
		[50, 30, 20],
	);
	assert.deepEqual(
		out.values.map((v) => v.Rank),
		[1, 2, 3],
	);
	assert.deepEqual(
		out.values.map((v) => v.Change),
		[50, -20, -10],
	);
	assert.deepEqual(
		out.values.map((v) => v.Running),
		[50, 80, 100],
	);
	assert.equal(out.values[0]["Of total"], 0.5);
});

test("a formula that reads itself, even through another, is a cycle", () => {
	const out = computeColumns(
		rows,
		["Revenue"],
		[
			{ id: "a", name: "A", formula: "[B] + 1" },
			{ id: "b", name: "B", formula: "[A] + 1" },
			{ id: "c", name: "C", formula: "[Revenue] * 2" },
		],
	);
	assert.ok(isError(out.values[0].A));
	assert.equal(String(out.values[0].A), "#CYCLE!");
	assert.equal(out.values[0].C, 100);
});

test("a formula that cannot be read is reported and filled with an error", () => {
	const out = computeColumns(
		rows,
		["Revenue"],
		[{ id: "a", name: "Bad", formula: "[Revenue] *" }],
	);
	assert.ok(out.problems.Bad);
	assert.ok(out.values[0].Bad instanceof FormulaError);
});

test("ranks, running totals and ties agree with a row by row count", () => {
	const values = [5, 3, 5, null, "", 8, "x", 1];
	const data = values.map((v) => ({ V: v }));
	const out = computeColumns(
		data,
		["V"],
		[
			{ id: "a", name: "Down", formula: "IFERROR(RANK([V]), -1)" },
			{ id: "b", name: "Up", formula: "IFERROR(RANK([V], TRUE), -1)" },
			{ id: "c", name: "Run", formula: "IFERROR(RUNNING([V]), -1)" },
		],
	);
	assert.deepEqual(
		out.values.map((v) => v.Down),
		[2, 4, 2, 6, 6, 1, -1, 5],
		"null and blank count as zero for the row itself, and blank is ranked",
	);
	assert.deepEqual(
		out.values.map((v) => v.Up),
		[4, 3, 4, 1, 1, 6, -1, 2],
	);
	assert.deepEqual(
		out.values.map((v) => v.Run),
		[5, 8, 13, 13, 13, 21, -1, -1],
		"a running total stops at the first value that is not a number",
	);
});

test("whole column functions stay linear on a large sheet", () => {
	const data = Array.from({ length: 50_000 }, (_, i) => ({ V: i % 997 }));
	const started = Date.now();
	const out = computeColumns(
		data,
		["V"],
		[
			{
				id: "a",
				name: "All",
				formula: "RANK([V]) + RUNNING([V]) + SHARE([V]) + TOTAL([V])",
			},
		],
	);
	const elapsed = Date.now() - started;
	assert.equal(out.values.length, 50_000);
	assert.ok(
		elapsed < 5000,
		`computing took ${elapsed}ms, which suggests a pass over the column per row`,
	);
});

test("joined text past the cell limit is an error rather than growing without end", () => {
	const repeat = Array.from({ length: 40 }, () => "[T]").join(" & ");
	const out = computeColumns(
		[{ T: "x".repeat(100) }],
		["T"],
		[
			{ id: "a", name: "A", formula: repeat },
			{ id: "b", name: "B", formula: repeat.replace(/\[T\]/g, "[A]") },
			{
				id: "c",
				name: "C",
				formula: "CONCAT([A], [A], [A], [A], [A], [A], [A], [A], [A])",
			},
		],
	);
	assert.equal(out.values[0].A, "x".repeat(4000));
	assert.ok(isError(out.values[0].B));
	assert.equal(String(out.values[0].B), "#VALUE!");
	assert.ok(isError(out.values[0].C));
});
