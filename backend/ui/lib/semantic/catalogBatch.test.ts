import assert from "node:assert/strict";
import { test } from "node:test";
import {
	chunk,
	groupByCatalog,
	pairKey,
	pairPredicate,
	routineRef,
	splitTable,
} from "./catalogBatch";

test("splitTable takes the first three parts and refuses a short name", () => {
	assert.deepEqual(splitTable("main.sales.orders"), {
		catalog: "main",
		schema: "sales",
		name: "orders",
	});
	assert.equal(splitTable("sales.orders"), null);
	assert.equal(splitTable("main..orders"), null);
});

test("routineRef takes its own catalogue when it names one", () => {
	assert.deepEqual(routineRef("main", "security.filters.by_region"), {
		catalog: "security",
		schema: "filters",
		name: "by_region",
	});
	assert.deepEqual(routineRef("main", "filters.by_region"), {
		catalog: "main",
		schema: "filters",
		name: "by_region",
	});
	assert.equal(routineRef("main", "by_region"), null);
});

test("groupByCatalog drops repeats regardless of case", () => {
	const grouped = groupByCatalog([
		{ catalog: "main", schema: "sales", name: "orders" },
		{ catalog: "main", schema: "Sales", name: "Orders" },
		{ catalog: "main", schema: "sales", name: "returns" },
		{ catalog: "other", schema: "sales", name: "orders" },
	]);
	assert.equal(grouped.get("main")?.length, 2);
	assert.equal(grouped.get("other")?.length, 1);
	assert.equal(pairKey("Sales", "Orders"), pairKey("sales", "orders"));
});

test("pairPredicate binds every value and joins the pairs with OR", () => {
	const { clause, params } = pairPredicate(
		[
			{ schema: "sales", name: "orders" },
			{ schema: "hr", name: "people'; DROP" },
		],
		"table_schema",
		"table_name",
	);
	assert.equal(
		clause,
		"(table_schema = :s0 AND table_name = :n0) OR " +
			"(table_schema = :s1 AND table_name = :n1)",
	);
	assert.deepEqual(params, {
		s0: "sales",
		n0: "orders",
		s1: "hr",
		n1: "people'; DROP",
	});
	assert.equal(pairPredicate([], "a", "b").clause, "FALSE");
});

test("chunk splits into pieces of at most the given size", () => {
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(chunk([], 3), []);
});
