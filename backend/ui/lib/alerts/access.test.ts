import { test } from "node:test";
import assert from "node:assert/strict";
import { accessFields, filterColumns } from "./access";
import type { ViewCalculations } from "../semantic/metricViewCalculations";

test("reads column names out of a filter's arguments and drops the literals", () => {
	assert.deepEqual(filterColumns("REGION"), ["REGION"]);
	assert.deepEqual(filterColumns("CATEGORY, REGION_ID, `STORE`"), [
		"CATEGORY",
		"REGION_ID",
		"STORE",
	]);
	assert.deepEqual(
		filterColumns(
			'"config", "test", "store_map", "NULL", region, "x,y", 42, NULL',
		),
		["region"],
	);
	assert.deepEqual(filterColumns(""), []);
});

const table = {
	kind: "table" as const,
	catalog: "c",
	schema: "s",
	object: "orders",
	dimensions: [
		{ name: "Region", sqlExpr: "region" },
		{ name: "Category", sqlExpr: "`category`" },
		{ name: "Region Upper", sqlExpr: "upper(region)" },
	],
};

test("a table's filter columns map to the fields that are exactly them", () => {
	assert.deepEqual(
		accessFields(
			table,
			[{ table: "c.s.orders", columns: ["REGION", "category"] }],
			null,
		),
		["Category", "Region"],
	);
});

test("a column no field holds as it is leaves nothing to restrict on", () => {
	assert.equal(
		accessFields(
			table,
			[{ table: "c.s.orders", columns: ["store"] }],
			null,
		),
		null,
	);
	assert.equal(accessFields(table, [], null), null);
});

const view: ViewCalculations = {
	source: "c.s.order_lines",
	filter: null,
	joins: [{ name: "customer", source: "c.s.customers", on: "..." }],
	fields: new Map([
		["Region", { expr: "source.region", window: null }],
		["Category", { expr: "category", window: null }],
		["Customer Region", { expr: "customer.region", window: null }],
		["Revenue", { expr: "SUM(amount)", window: null }],
	]),
};

const metricView = {
	kind: "metric_view" as const,
	catalog: "c",
	schema: "s",
	object: "sales",
	dimensions: [
		{ name: "Region", sqlExpr: null },
		{ name: "Category", sqlExpr: null },
		{ name: "Customer Region", sqlExpr: null },
	],
};

test("a metric view follows filters on the table it reads, through the field expressions", () => {
	assert.deepEqual(
		accessFields(
			metricView,
			[{ table: "c.s.order_lines", columns: ["region", "category"] }],
			view,
		),
		["Category", "Region"],
	);
});

test("a filter on a joined table keeps the alert to signed-in checks", () => {
	assert.equal(
		accessFields(
			metricView,
			[{ table: "c.s.customers", columns: ["region"] }],
			view,
		),
		null,
	);
});

test("a filter on the view itself names its fields directly", () => {
	assert.deepEqual(
		accessFields(
			metricView,
			[{ table: "c.s.sales", columns: ["Region"] }],
			view,
		),
		["Region"],
	);
});

test("a metric view with no readable definition cannot be mapped", () => {
	assert.equal(
		accessFields(
			metricView,
			[{ table: "c.s.order_lines", columns: ["region"] }],
			null,
		),
		null,
	);
});
