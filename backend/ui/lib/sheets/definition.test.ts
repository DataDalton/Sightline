import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildPivot,
	cleanDefinition,
	displayColumns,
	emptyDefinition,
	pivotGroupings,
	rowKey,
} from "./definition";

test("cleans what arrives and keeps only what a sheet can hold", () => {
	const def = cleanDefinition({
		sourceKey: "sales",
		mode: "pivot",
		columns: ["Region", "Revenue", 42],
		conditions: [
			{ field: "Category", op: "eq", value: "Hardware", join: "and" },
		],
		formulas: [
			{ id: "f1", name: "Margin", formula: "[Revenue] - [Cost]" },
			{ id: "f2", name: "margin", formula: "1" },
			{ id: "bad id!", name: "X", formula: "1" },
		],
		notes: [{ id: "n1", name: "Comment" }],
		settings: {
			"field:Revenue": { width: 5000, format: "currency" },
			x: { format: "weird" },
		},
		sort: { column: "Revenue", direction: "desc" },
		pivot: { rows: ["Region"], columns: "Year", values: ["Revenue"] },
		frozen: 99,
	});
	assert.equal(def.mode, "pivot");
	assert.deepEqual(def.columns, ["Region", "Revenue"]);
	assert.equal(def.conditions.length, 1);
	assert.deepEqual(
		def.formulas.map((f) => f.id),
		["f1"],
		"duplicate names and bad ids are dropped",
	);
	assert.deepEqual(def.settings, {
		"field:Revenue": { width: 800, format: "currency" },
	});
	assert.deepEqual(def.sort, { column: "Revenue", direction: "desc" });
	assert.equal(def.frozen, 10);
	assert.deepEqual(cleanDefinition(null), emptyDefinition());
});

test("display order follows the stored order and repairs itself", () => {
	const def = {
		...emptyDefinition("sales"),
		columns: ["Region", "Revenue"],
		formulas: [{ id: "f1", name: "Share", formula: "SHARE([Revenue])" }],
		notes: [{ id: "n1", name: "Comment" }],
		order: ["note:n1", "field:Revenue", "field:Gone"],
	};
	assert.deepEqual(
		displayColumns(def).map((c) => c.key),
		["note:n1", "field:Revenue", "field:Region", "formula:f1"],
	);
});

test("a row is keyed by its grouping values", () => {
	assert.equal(
		rowKey({ Region: "West", Year: 2026 }, ["Region", "Year"]),
		'["West","2026"]',
	);
	assert.equal(rowKey({ Region: null }, ["Region"]), "[null]");
	assert.equal(rowKey({ Revenue: 5 }, []), "*");
});

test("a pivot asks for cells, both totals and the grand total", () => {
	assert.deepEqual(
		pivotGroupings({
			rows: ["Region"],
			columns: "Year",
			values: ["Revenue"],
		}),
		{
			cells: ["Region", "Year"],
			rowTotals: ["Region"],
			colTotals: ["Year"],
			grand: [],
		},
	);
	assert.deepEqual(
		pivotGroupings({
			rows: ["Region"],
			columns: null,
			values: ["Revenue"],
		}),
		{
			cells: ["Region"],
			rowTotals: null,
			colTotals: null,
			grand: [],
		},
	);
	assert.deepEqual(
		pivotGroupings({ rows: [], columns: "Year", values: ["Revenue"] }),
		{
			cells: ["Year"],
			rowTotals: [],
			colTotals: null,
			grand: null,
		},
	);
});

test("lays out a pivot with totals taken from the warehouse, not summed", () => {
	const table = buildPivot(
		{ rows: ["Region"], columns: "Year", values: ["Avg Price"] },
		{
			cells: [
				{ Region: "West", Year: "2025", "Avg Price": 10 },
				{ Region: "West", Year: "2026", "Avg Price": 20 },
				{ Region: "East", Year: "2026", "Avg Price": 30 },
			],
			rowTotals: [
				{ Region: "West", "Avg Price": 16 },
				{ Region: "East", "Avg Price": 30 },
			],
			colTotals: [
				{ Year: "2025", "Avg Price": 10 },
				{ Year: "2026", "Avg Price": 24 },
			],
			grand: [{ "Avg Price": 21 }],
		},
	);
	assert.deepEqual(
		table.columns.map((c) => c.label),
		["2025", "2026", "Total"],
	);
	assert.deepEqual(
		table.rows.map((r) => [r.keys[0], ...r.cells]),
		[
			["East", null, 30, 30],
			["West", 10, 20, 16],
			[null, 10, 24, 21],
		],
	);
	assert.ok(table.rows[2].total);
	assert.equal(table.clipped, false);
});

test("several measures label their columns, and no across field is a summary", () => {
	const table = buildPivot(
		{ rows: ["Region"], columns: null, values: ["Revenue", "Units"] },
		{
			cells: [
				{ Region: "West", Revenue: 5, Units: 1 },
				{ Region: "East", Revenue: 7, Units: 2 },
			],
			grand: [{ Revenue: 12, Units: 3 }],
		},
	);
	assert.deepEqual(
		table.columns.map((c) => c.label),
		["Revenue", "Units"],
	);
	assert.deepEqual(table.rows.at(-1)?.cells, [12, 3]);
});
