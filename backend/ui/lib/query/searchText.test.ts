import { test } from "node:test";
import assert from "node:assert/strict";
import {
	columnKind,
	conditionClauses,
	conditionComplete,
	describeCondition,
	parseAmount,
	parseTypedCondition,
	searchTree,
} from "./searchText";

test("amounts are read the way people write them", () => {
	assert.equal(parseAmount("50k"), 50_000);
	assert.equal(parseAmount("1.2M"), 1_200_000);
	assert.equal(parseAmount("$3,000"), 3000);
	assert.equal(parseAmount("-4.5"), -4.5);
	assert.equal(parseAmount("12%"), 12);
	assert.equal(parseAmount("2b"), 2_000_000_000);
	assert.equal(parseAmount("abc"), null);
	assert.equal(parseAmount(""), null);
});

test("free text needs every word, each in any column", () => {
	assert.equal(searchTree("   ", ["A"]), null);
	assert.deepEqual(searchTree("north", ["Name"]), {
		field: "Name",
		op: "contains",
		value: "north",
	});
	assert.deepEqual(searchTree("texas ortho", ["Name", "State"]), {
		all: [
			{
				any: [
					{ field: "Name", op: "contains", value: "texas" },
					{ field: "State", op: "contains", value: "texas" },
				],
			},
			{
				any: [
					{ field: "Name", op: "contains", value: "ortho" },
					{ field: "State", op: "contains", value: "ortho" },
				],
			},
		],
	});
});

test("a condition becomes the clauses the query reads", () => {
	assert.deepEqual(
		conditionClauses("Revenue", { op: "gt", value: "50k" }, true),
		[{ field: "Revenue", op: "gt", value: "50000" }],
	);
	assert.deepEqual(
		conditionClauses(
			"Revenue",
			{ op: "between", value: "2m", value2: "1m" },
			true,
		),
		[
			{ field: "Revenue", op: "gte", value: "1000000" },
			{ field: "Revenue", op: "lte", value: "2000000" },
		],
	);
	assert.deepEqual(
		conditionClauses("Revenue", { op: "gt", value: "" }, true),
		[],
	);
	assert.deepEqual(conditionClauses("Name", { op: "is_empty" }, false), [
		{ field: "Name", op: "is_empty" },
	]);
	assert.deepEqual(
		conditionClauses(
			"Order Date",
			{ op: "gte", value: "2026-01-01" },
			false,
		),
		[{ field: "Order Date", op: "gte", value: "2026-01-01" }],
	);
	assert.equal(conditionComplete({ op: "between", value: "1" }, true), false);
});

test("a condition reads plainly on a chip", () => {
	assert.equal(
		describeCondition("Revenue 1yr", { op: "gt", value: "50k" }),
		"Revenue 1yr > 50K",
	);
	assert.equal(
		describeCondition("Orders", {
			op: "between",
			value: "10",
			value2: "20",
		}),
		"Orders 10 to 20",
	);
	assert.equal(
		describeCondition("State", { op: "is_empty" }),
		"State is blank",
	);
});

test("a typed condition finds its column, and plain text is left alone", () => {
	const fields = [
		{ name: "Revenue 1yr", label: "Revenue 1yr", numeric: true },
		{
			name: "Revenue On Contract 1yr",
			label: "Revenue on contract 1yr",
			numeric: true,
		},
		{ name: "Order Count", label: "Orders", numeric: true },
		{ name: "State", label: "State", numeric: false },
	];
	assert.deepEqual(parseTypedCondition("revenue > 50k", fields), {
		field: "Revenue 1yr",
		condition: { op: "gt", value: "50k" },
	});
	assert.deepEqual(parseTypedCondition("orders >= 10", fields), {
		field: "Order Count",
		condition: { op: "gte", value: "10" },
	});
	assert.equal(parseTypedCondition("texas", fields), null);
	assert.equal(parseTypedCondition("state > 5", fields), null);
	assert.equal(parseTypedCondition("revenue > lots", fields), null);
});

test("a column takes the filter its kind needs", () => {
	assert.equal(columnKind(null, true), "number");
	assert.equal(columnKind("DECIMAL(18,2)", false), "number");
	assert.equal(columnKind("bigint", false), "number");
	assert.equal(columnKind("DATE", false), "date");
	assert.equal(columnKind("timestamp", false), "date");
	assert.equal(columnKind("string", false), "text");
	assert.equal(columnKind(null, false), "text");
});
