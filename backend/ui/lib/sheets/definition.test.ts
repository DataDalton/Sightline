import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildPivot,
	cleanDefinition,
	displayColumns,
	emptyDefinition,
	parseRowKey,
	pivotGroupings,
	queryFingerprint,
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

test("a row key reads back as the values it was made from", () => {
	const row = { Region: "West", Year: 2024, Code: null };
	const key = rowKey(row, ["Region", "Year", "Code"]);
	assert.deepEqual(parseRowKey(key, 3), ["West", "2024", null]);
	assert.deepEqual(parseRowKey("*", 0), []);
	// The wrong number of fields, text that is not a key, and values that are
	// not text are all refused.
	assert.equal(parseRowKey(key, 2), null);
	assert.equal(parseRowKey("not json", 1), null);
	assert.equal(parseRowKey("[1]", 1), null);
	assert.equal(parseRowKey('{"a":1}', 1), null);
	assert.equal(parseRowKey("*", 1), null);
});

test("the data fingerprint follows only what the rows are read from", () => {
	const base = cleanDefinition({
		sourceKey: "sales",
		columns: ["Region", "Revenue"],
		conditions: [{ field: "Region", op: "eq", value: "West", join: "and" }],
		formulas: [{ id: "f1", name: "Double", formula: "[Revenue] * 2" }],
		notes: [{ id: "n1", name: "Comment" }],
		sort: { column: "Revenue", direction: "desc" },
	});
	const print = queryFingerprint(base);
	assert.match(print, /^[0-9a-f]{16}$/);

	// Layout, formulas and notes leave the rows alone.
	assert.equal(
		queryFingerprint({
			...base,
			settings: { "field:Region": { width: 300 } },
			frozen: 2,
			order: ["field:Revenue", "field:Region"],
			formulas: [],
			notes: [],
		}),
		print,
	);
	// A sort on a formula column is applied in the page.
	const onFormula = {
		...base,
		sort: { column: "Double", direction: "asc" as const },
	};
	assert.equal(
		queryFingerprint(onFormula),
		queryFingerprint({ ...base, sort: null }),
	);

	// The fields, the conditions, a sort on a field and the mode all change
	// the rows.
	assert.notEqual(queryFingerprint({ ...base, columns: ["Region"] }), print);
	assert.notEqual(queryFingerprint({ ...base, conditions: [] }), print);
	assert.notEqual(
		queryFingerprint({
			...base,
			sort: { column: "Revenue", direction: "asc" },
		}),
		print,
	);
	assert.notEqual(queryFingerprint({ ...base, mode: "pivot" }), print);
});

test("a pivot's fingerprint follows its layout rather than its columns", () => {
	const base = cleanDefinition({
		sourceKey: "sales",
		mode: "pivot",
		columns: ["Region"],
		pivot: { rows: ["Region"], columns: null, values: ["Revenue"] },
	});
	assert.equal(
		queryFingerprint({ ...base, columns: ["Region", "Year"] }),
		queryFingerprint(base),
	);
	assert.notEqual(
		queryFingerprint({
			...base,
			pivot: { rows: ["Region"], columns: "Year", values: ["Revenue"] },
		}),
		queryFingerprint(base),
	);
});
