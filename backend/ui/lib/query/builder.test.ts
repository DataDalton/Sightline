import assert from "node:assert/strict";
import { test } from "node:test";
import { compileQuery } from "./builder";
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
	measures: [field("Accounts", "measure", "COUNT(DISTINCT customer_id)", "int")],
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
	assert.match(
		compiled.sql,
		/COUNT\(DISTINCT customer_id\) AS `Accounts`/,
	);
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
				{ field: "Category", op: "eq", values: ["North", "South", "West"] },
			],
		}),
	);

	assert.match(compiled.sql, /`Category` IN \(:f0_0, :f0_1, :f0_2\)/);
	assert.equal(compiled.params.f0_0, "North");
	assert.equal(compiled.params.f0_2, "West");
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
			filters: [
				{ field: "Month", op: "gte", value: "2026-01-01" },
			],
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
