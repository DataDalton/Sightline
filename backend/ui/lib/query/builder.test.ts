import assert from "node:assert/strict";
import { test } from "node:test";
import { compileQuery } from "./builder";
import { distributionColumns } from "./visualSpec";
import { QuerySpecError, type QuerySpec } from "./spec";
import type { SemanticField, SemanticSource } from "../semantic/types";

// The builder turns client input into SQL, so these tests exist to prove two
// properties hold: an unknown field name never reaches the output, and a
// client-supplied value is never concatenated into the SQL string.

function field(
	name: string,
	kind: SemanticField["kind"],
	sqlExpr: string | null,
	dataType: string | null = "string",
): SemanticField {
	return {
		fieldId: name,
		sourceKey: "orders",
		name,
		displayName: null,
		kind,
		sqlExpr,
		dataType,
		description: null,
		formatHint: null,
		tags: {},
		folder: null,
		sortOrder: 0,
		isDefault: false,
	};
}

// A metric view: fields are referenced by name and measures read with
// MEASURE(), because the view owns its aggregation.
const source: SemanticSource = {
	sourceKey: "orders",
	title: "Orders",
	description: null,
	catalog: "cat",
	schema: "sch",
	object: "orders",
	kind: "metric_view",
	accessMode: "direct",
	hasRowFilter: true,
	cacheTtlSeconds: 300,
	defaultTimeField: "Month",
	dimensions: [
		field("Category", "dimension", null),
		field("Month", "dimension", null, "date"),
		field("Order Count", "dimension", null, "int"),
	],
	measures: [
		field("Revenue", "measure", null, "double"),
		field("Units", "measure", null, "int"),
	],
};

// A plain table: no semantic layer, so each field carries its expression.
const tableSource: SemanticSource = {
	...source,
	sourceKey: "directory",
	object: "customer_directory",
	kind: "table",
	dimensions: [field("Region", "dimension", "region")],
	measures: [
		field("Accounts", "measure", "COUNT(DISTINCT customer_id)", "int"),
	],
};

// A table carrying a boolean, which is what a flag toggle filters on.
const flagSource: SemanticSource = {
	...source,
	sourceKey: "flags",
	object: "schedules",
	kind: "table",
	dimensions: [field("Latest", "dimension", "`Latest`", "boolean")],
	measures: [],
};

function spec(overrides: Partial<QuerySpec> = {}): QuerySpec {
	return {
		sourceKey: "orders",
		dimensions: [],
		measures: [],
		filters: [],
		sort: [],
		limit: 1000,
		offset: 0,
		transforms: [],
		...overrides,
	};
}

test("aggregates measures and groups by dimensions", () => {
	const compiled = compileQuery(
		source,
		spec({ dimensions: ["Category"], measures: ["Revenue"] }),
	);

	assert.match(
		compiled.sql,
		/SELECT `Category`, MEASURE\(`Revenue`\) AS `Revenue`/,
	);
	assert.match(compiled.sql, /FROM cat\.sch\.orders/);
	assert.match(compiled.sql, /GROUP BY `Category`/);
	assert.deepEqual(compiled.columns, ["Category", "Revenue"]);
});

test("a metric view groups even with no measure selected", () => {
	// The view resolves the grain, so a dimension-only read is still an
	// aggregate over it rather than a raw row scan.
	const compiled = compileQuery(source, spec({ dimensions: ["Category"] }));
	assert.match(compiled.sql, /GROUP BY `Category`/);
});

test("a table omits GROUP BY when no measure is selected", () => {
	const compiled = compileQuery(
		tableSource,
		spec({ sourceKey: "directory", dimensions: ["Region"] }),
	);
	assert.ok(!compiled.sql.includes("GROUP BY"));
	assert.match(compiled.sql, /SELECT region AS `Region`/);
});

test("a table uses its own aggregate expression, not MEASURE()", () => {
	const compiled = compileQuery(
		tableSource,
		spec({
			sourceKey: "directory",
			dimensions: ["Region"],
			measures: ["Accounts"],
		}),
	);
	assert.match(compiled.sql, /COUNT\(DISTINCT customer_id\) AS `Accounts`/);
	assert.ok(!compiled.sql.includes("MEASURE("));
});

test("rejects an unknown dimension instead of interpolating it", () => {
	assert.throws(
		() => compileQuery(source, spec({ dimensions: ["Injected"] })),
		QuerySpecError,
	);
});

test("rejects a measure used as a dimension", () => {
	assert.throws(
		() => compileQuery(source, spec({ dimensions: ["Revenue"] })),
		QuerySpecError,
	);
});

test("binds filter values rather than concatenating them", () => {
	const hostile = "'; DROP TABLE orders; --";
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			measures: ["Revenue"],
			filters: [{ field: "Category", op: "eq", value: hostile }],
		}),
	);

	// The value appears only in the parameter map, never in the SQL text.
	assert.ok(!compiled.sql.includes("DROP TABLE"));
	assert.equal(compiled.params.f0, hostile);
	assert.match(
		compiled.sql,
		/WHERE LOWER\(COALESCE\(CAST\(`Category` AS STRING\), ''\)\) = LOWER\(:f0\)/,
	);
});

test("binds every value in a multi-value filter separately", () => {
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			filters: [
				{
					field: "Category",
					op: "eq",
					values: ["North", "South", "West"],
				},
			],
		}),
	);

	assert.match(
		compiled.sql,
		/IN \(LOWER\(:f0_0\), LOWER\(:f0_1\), LOWER\(:f0_2\)\)/,
	);
	assert.equal(compiled.params.f0_0, "North");
	assert.equal(compiled.params.f0_2, "West");
});

// A set of values is compared the same way a single value is. It used to be
// matched against the column as it stands, which is the only case-sensitive
// comparison this module ever made and a type error on anything that is not
// text.

test("a value set matches text without regard to casing", () => {
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			filters: [
				{ field: "Category", op: "eq", values: ["north", "SOUTH"] },
			],
		}),
	);
	assert.match(
		compiled.sql,
		/LOWER\(COALESCE\(CAST\(`Category` AS STRING\), ''\)\) IN \(LOWER\(:f0_0\), LOWER\(:f0_1\)\)/,
	);
});

test("a value set on a flag compares as text rather than as itself", () => {
	// A boolean column against a bound string is a type mismatch the warehouse
	// refuses outright, which is what a flag toggle sends.
	const compiled = compileQuery(
		flagSource,
		spec({
			sourceKey: "flags",
			dimensions: ["Latest"],
			filters: [{ field: "Latest", op: "eq", values: ["true"] }],
		}),
	);
	assert.match(
		compiled.sql,
		/LOWER\(COALESCE\(CAST\(`Latest` AS STRING\), ''\)\) IN \(LOWER\(:f0_0\)\)/,
	);
});

test("a value set on a number stays a number", () => {
	// Casting a number to text to compare it would give up every partition and
	// file skip the warehouse can do on it.
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			filters: [{ field: "Order Count", op: "eq", values: ["3", "7"] }],
		}),
	);
	assert.match(compiled.sql, /`Order Count` IN \(:f0_0, :f0_1\)/);
	assert.equal(compiled.params.f0_0, 3);
	assert.equal(compiled.params.f0_1, 7);
});

test("a value set on a date is read as a date", () => {
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			filters: [{ field: "Month", op: "eq", values: ["2026-01-01"] }],
		}),
	);
	assert.match(compiled.sql, /`Month` IN \(CAST\(:f0_0 AS TIMESTAMP\)\)/);
});

test("excluding a value set keeps the rows that have no value", () => {
	// NOT IN against NULL is NULL, which is not a match, so a row with nothing
	// in the column was dropped by both including and excluding.
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			filters: [{ field: "Category", op: "neq", values: ["North"] }],
		}),
	);
	assert.match(
		compiled.sql,
		/LOWER\(COALESCE\(CAST\(`Category` AS STRING\), ''\)\) NOT IN \(LOWER\(:f0_0\)\)/,
	);
});

test("routes a measure filter to HAVING and a dimension filter to WHERE", () => {
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			measures: ["Revenue"],
			filters: [
				{ field: "Category", op: "eq", value: "North" },
				{ field: "Revenue", op: "gt", value: "1000" },
			],
		}),
	);

	assert.match(compiled.sql, /WHERE LOWER\(COALESCE/);
	assert.match(compiled.sql, /HAVING MEASURE\(`Revenue`\) > :f1/);
	// A numeric measure binds as a number, not a string.
	assert.equal(compiled.params.f1, 1000);
});

test("rejects a measure filter on a table with no measure selected", () => {
	assert.throws(
		() =>
			compileQuery(
				tableSource,
				spec({
					sourceKey: "directory",
					dimensions: ["Region"],
					filters: [{ field: "Accounts", op: "gt", value: "10" }],
				}),
			),
		QuerySpecError,
	);
});

test("casts a bound value for a date comparison", () => {
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			filters: [{ field: "Month", op: "gte", value: "2026-01-01" }],
		}),
	);

	assert.match(compiled.sql, /CAST\(:f0 AS TIMESTAMP\)/);
});

test("valueless operators bind nothing", () => {
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			filters: [{ field: "Category", op: "is_empty" }],
		}),
	);

	assert.deepEqual(compiled.params, {});
	assert.match(compiled.sql, /`Category` IS NULL OR/);
});

test("orders by the output alias and escapes backticks in it", () => {
	const tricky: SemanticSource = {
		...source,
		dimensions: [field("Weird`Name", "dimension", null)],
	};
	const compiled = compileQuery(
		tricky,
		spec({
			dimensions: ["Weird`Name"],
			sort: [{ field: "Weird`Name", direction: "desc" }],
		}),
	);

	assert.match(compiled.sql, /SELECT `Weird``Name`/);
	assert.match(compiled.sql, /ORDER BY `Weird``Name` DESC/);
});

test("rejects a query with neither dimensions nor measures", () => {
	assert.throws(() => compileQuery(source, spec()), QuerySpecError);
});

test("applies limit and offset", () => {
	const compiled = compileQuery(
		source,
		spec({ dimensions: ["Category"], limit: 250, offset: 500 }),
	);
	assert.match(compiled.sql, /LIMIT 250/);
	assert.match(compiled.sql, /OFFSET 500/);
});

// --- Distributions ---------------------------------------------------------
//
// The shape of a measure is summarised where the values are, because the
// values behind one box run to tens of millions of rows. These prove the inner
// query takes the measure at the detail grain and that nothing but the summary
// comes back.

test("a summary takes the measure at the detail grain", () => {
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			measures: ["Revenue"],
			distribution: { kind: "summary", detail: ["Month"] },
		}),
	);

	// The inner query groups by the box and by what the box is taken over, so
	// there is one value per month within each category.
	assert.match(
		compiled.sql,
		/SELECT `Category`, MEASURE\(`Revenue`\) AS `__value`/,
	);
	assert.match(compiled.sql, /GROUP BY `Category`, `Month`/);
	assert.match(compiled.sql, /approx_percentile\(`__value`, 0\.5, 10000\)/);
});

test("a summary answers in the shared column names", () => {
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			measures: ["Revenue"],
			distribution: { kind: "summary", detail: ["Month"] },
		}),
	);

	assert.deepEqual(compiled.columns, [
		"Category",
		distributionColumns.count,
		distributionColumns.lowerWhisker,
		distributionColumns.lowerQuartile,
		distributionColumns.median,
		distributionColumns.upperQuartile,
		distributionColumns.upperWhisker,
		distributionColumns.outliers,
	]);
});

test("an ungrouped summary is one box and needs no join key", () => {
	const compiled = compileQuery(
		source,
		spec({
			measures: ["Revenue"],
			distribution: { kind: "summary", detail: ["Month"] },
		}),
	);

	assert.match(compiled.sql, /CROSS JOIN detail d/);
	// One row has nothing to order. The ORDER BY inside percentile_cont is a
	// different clause, so the check is anchored to a line of its own.
	assert.doesNotMatch(compiled.sql, /^ORDER BY/m);
	assert.deepEqual(compiled.columns[0], distributionColumns.count);
});

test("a grouped summary joins null safely", () => {
	// A grouping field with no value is a group like any other, and an
	// equality join would drop it.
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			measures: ["Revenue"],
			distribution: { kind: "summary", detail: ["Month"] },
		}),
	);
	assert.match(compiled.sql, /ON d\.`Category` <=> q\.`Category`/);
});

test("a summary sorted by its measure ranks on the median", () => {
	const compiled = compileQuery(
		source,
		spec({
			dimensions: ["Category"],
			measures: ["Revenue"],
			sort: [{ field: "Revenue", direction: "desc" }],
			limit: 12,
			distribution: { kind: "summary", detail: ["Month"] },
		}),
	);
	assert.match(compiled.sql, /ORDER BY `Median` DESC/);
	assert.match(compiled.sql, /LIMIT 12/);
});

test("a summary refuses to sort by anything it does not answer with", () => {
	assert.throws(
		() =>
			compileQuery(
				source,
				spec({
					dimensions: ["Category"],
					measures: ["Revenue"],
					sort: [{ field: "Units", direction: "desc" }],
					distribution: { kind: "summary", detail: ["Month"] },
				}),
			),
		QuerySpecError,
	);
});

test("a summary groups by at most one field", () => {
	assert.throws(
		() =>
			compileQuery(
				source,
				spec({
					dimensions: ["Category", "Month"],
					measures: ["Revenue"],
					distribution: { kind: "summary", detail: ["Order Count"] },
				}),
			),
		QuerySpecError,
	);
});

test("a distribution describes exactly one measure", () => {
	assert.throws(
		() =>
			compileQuery(
				source,
				spec({
					measures: ["Revenue", "Units"],
					distribution: { kind: "summary", detail: ["Month"] },
				}),
			),
		QuerySpecError,
	);
});

test("a distribution rejects a detail field the source does not define", () => {
	assert.throws(
		() =>
			compileQuery(
				source,
				spec({
					measures: ["Revenue"],
					distribution: { kind: "summary", detail: ["Nonsense"] },
				}),
			),
		QuerySpecError,
	);
});

test("bins are counted over the trimmed range with every bin listed", () => {
	const compiled = compileQuery(
		source,
		spec({
			measures: ["Revenue"],
			distribution: { kind: "bins", detail: ["Month"], bins: 12 },
		}),
	);

	assert.match(compiled.sql, /approx_percentile\(`__value`, 0\.01, 10000\)/);
	assert.match(compiled.sql, /approx_percentile\(`__value`, 0\.99, 10000\)/);
	// Bins nothing fell into still come back, so a gap in the bars is a gap in
	// the data rather than a missing row.
	assert.match(compiled.sql, /explode\(sequence\(1, 12\)\)/);
	assert.match(compiled.sql, /LEFT JOIN placed/);
	assert.deepEqual(compiled.columns, [
		distributionColumns.binStart,
		distributionColumns.binEnd,
		distributionColumns.count,
	]);
});

test("a value outside the trimmed range lands in an end bin", () => {
	const compiled = compileQuery(
		source,
		spec({
			measures: ["Revenue"],
			distribution: { kind: "bins", detail: ["Month"], bins: 12 },
		}),
	);
	// Clamped rather than filtered, so the bars still account for every value.
	assert.match(compiled.sql, /LEAST\(12, GREATEST\(1,/);
});

test("a binned distribution takes no grouping", () => {
	assert.throws(
		() =>
			compileQuery(
				source,
				spec({
					dimensions: ["Category"],
					measures: ["Revenue"],
					distribution: { kind: "bins", detail: ["Month"], bins: 8 },
				}),
			),
		QuerySpecError,
	);
});

test("a distribution filters rows before it summarises them", () => {
	const compiled = compileQuery(
		source,
		spec({
			measures: ["Revenue"],
			filters: [{ field: "Category", op: "eq", value: "Trauma" }],
			distribution: { kind: "summary", detail: ["Month"] },
		}),
	);

	// Inside the CTE, so the summary describes the filtered population rather
	// than being taken over everything and narrowed afterwards.
	const inner = compiled.sql.slice(
		compiled.sql.indexOf("WITH detail AS ("),
		compiled.sql.indexOf("quartiles AS ("),
	);
	assert.match(inner, /WHERE LOWER\(COALESCE\(CAST\(`Category`/);
	assert.equal(compiled.params.f0, "Trauma");
});

test("a distribution over a table uses the field expressions", () => {
	const compiled = compileQuery(
		tableSource,
		spec({
			sourceKey: "directory",
			measures: ["Accounts"],
			distribution: { kind: "summary", detail: ["Region"] },
		}),
	);
	assert.match(
		compiled.sql,
		/SELECT COUNT\(DISTINCT customer_id\) AS `__value`/,
	);
	assert.match(compiled.sql, /GROUP BY region/);
});
