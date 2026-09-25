import assert from "node:assert/strict";
import { cleanState } from "./state";
import { test } from "node:test";
import {
	bracketProblem,
	describeCondition,
	openDepth,
	parseCondition,
	toFilterLogic,
	withoutBracket,
	withoutCondition,
	type Condition,
	type KnownField,
} from "./conditions";

const fields: KnownField[] = [
	{ name: "Division", kind: "dimension" },
	{ name: "Order", kind: "dimension" },
	{ name: "Order Status", kind: "dimension" },
	{ name: "Region", kind: "dimension" },
	{ name: "Revenue", kind: "measure" },
	{ name: "Revenue PY", kind: "measure" },
];

const kinds = new Map(fields.map((f) => [f.name, f.kind]));

test("a simple equality is read", () => {
	const parsed = parseCondition("Division = Hardware", fields);
	assert.deepEqual(parsed?.condition, {
		field: "Division",
		op: "eq",
		value: "Hardware",
		negate: false,
		join: "and",
	});
	assert.equal(parsed?.partial, false);
});

// Field names contain spaces and prefix one another, so the longest match wins.
test("the longest matching field name is chosen", () => {
	assert.equal(
		parseCondition("Order Status is DRAFT", fields)?.condition.field,
		"Order Status",
	);
	assert.equal(
		parseCondition("Order = 12", fields)?.condition.field,
		"Order",
	);
	assert.equal(
		parseCondition("Revenue PY > 5", fields)?.condition.field,
		"Revenue PY",
	);
});

test("matching is case insensitive but keeps the field's own spelling", () => {
	assert.equal(
		parseCondition("division = hardware", fields)?.condition.field,
		"Division",
	);
});

test("comparison operators are read longest first", () => {
	assert.equal(parseCondition("Revenue >= 10", fields)?.condition.op, "gte");
	assert.equal(parseCondition("Revenue > 10", fields)?.condition.op, "gt");
	assert.equal(parseCondition("Revenue <= 10", fields)?.condition.op, "lte");
	assert.equal(parseCondition("Region != West", fields)?.condition.op, "neq");
	assert.equal(parseCondition("Region <> West", fields)?.condition.op, "neq");
	assert.equal(
		parseCondition("Region contains We", fields)?.condition.op,
		"contains",
	);
});

test("word operators need a word boundary", () => {
	assert.equal(parseCondition("Region isolated", fields), null);
	assert.equal(parseCondition("Region is West", fields)?.condition.op, "eq");
	assert.equal(
		parseCondition("Region is not West", fields)?.condition.op,
		"neq",
	);
});

test("in takes a comma separated list", () => {
	const parsed = parseCondition("Region in West, East, 'North'", fields);
	assert.deepEqual(parsed?.condition.values, ["West", "East", "North"]);
	assert.equal(parsed?.condition.op, "eq");
	assert.equal(
		parseCondition("Region not in West", fields)?.condition.op,
		"neq",
	);
});

test("empty checks need no value", () => {
	const parsed = parseCondition("Region is empty", fields);
	assert.equal(parsed?.condition.op, "is_empty");
	assert.equal(parsed?.partial, false);
	assert.equal(
		parseCondition("Region is not empty", fields)?.condition.op,
		"is_not_empty",
	);
});

test("or and not prefixes are read", () => {
	const parsed = parseCondition("or not Region = West", fields);
	assert.equal(parsed?.condition.join, "or");
	assert.equal(parsed?.condition.negate, true);
	assert.equal(parsed?.condition.field, "Region");
});

test("a field with an operator and no value yet is partial", () => {
	const parsed = parseCondition("Division = ", fields);
	assert.equal(parsed?.partial, true);
	assert.equal(parsed?.typedValue, "");
});

test("a field name alone is not a condition", () => {
	assert.equal(parseCondition("Division", fields), null);
	assert.equal(parseCondition("Nothing = 1", fields), null);
});

const c = (over: Partial<Condition>): Condition => ({
	field: "Region",
	op: "eq",
	value: "West",
	negate: false,
	join: "and",
	...over,
});

test("conditions with no OR are plain filters", () => {
	const logic = toFilterLogic(
		[c({}), c({ field: "Division", value: "Hardware" })],
		kinds,
	);
	assert.equal(logic.filters.length, 2);
	assert.equal(logic.anyOf, undefined);
});

test("AND binds tighter than OR", () => {
	const logic = toFilterLogic(
		[
			c({ value: "West" }),
			c({ field: "Division", value: "Hardware" }),
			c({ value: "East", join: "or" }),
		],
		kinds,
	);
	assert.equal(logic.filters.length, 0);
	const where = logic.where as { any: unknown[] } | undefined;
	assert.equal(where?.any.length, 2);
	assert.equal((where?.any[0] as { all: unknown[] }).all.length, 2);
});

test("an OR across a dimension and a measure is reported, not sent", () => {
	const logic = toFilterLogic(
		[c({}), c({ field: "Revenue", op: "gt", value: "1", join: "or" })],
		kinds,
	);
	assert.ok(logic.problem);
	assert.equal(logic.anyOf, undefined);
});

test("negation is carried into the filter only when set", () => {
	const logic = toFilterLogic([c({ negate: true }), c({})], kinds);
	assert.equal(logic.filters[0].negate, true);
	assert.equal("negate" in logic.filters[1], false);
});

test("a condition reads back the way it was typed", () => {
	assert.equal(describeCondition(c({ negate: true })), "not Region is West");
	assert.equal(
		describeCondition(c({ values: ["West", "East"], value: undefined })),
		"Region in West, East",
	);
});

// A chip clicked to edit is put back in the box as this text, so it has to
// parse into the same condition.
test("every described condition parses back into itself", () => {
	for (const condition of [
		c({}),
		c({ op: "neq" }),
		c({ negate: true }),
		c({ field: "Revenue", op: "gte", value: "1000" }),
		c({ field: "Revenue", op: "lt", value: "5" }),
		c({ op: "contains", value: "We" }),
		c({ op: "starts_with", value: "No" }),
		c({ op: "is_empty", value: undefined }),
		c({ op: "is_not_empty", value: undefined }),
		c({ values: ["West", "East"], value: undefined }),
		c({ op: "neq", values: ["West", "East"], value: undefined }),
	]) {
		const text = describeCondition(condition);
		const back = parseCondition(text, fields)?.condition;
		// Compared as written out, where a missing value and an undefined
		// one are the same thing.
		const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
		assert.deepEqual(plain(back), plain(condition), text);
	}
});

// Brackets. Typed around conditions, read into a tree with brackets first and
// AND before OR, and refused in words when they do not pair up.

test("brackets typed around a condition are read off it", () => {
	const open = parseCondition("(Division = Hardware", fields)?.condition;
	assert.equal(open?.open, 1);
	assert.equal(open?.value, "Hardware");

	const close = parseCondition("or Division = Software)", fields)?.condition;
	assert.equal(close?.close, 1);
	assert.equal(close?.value, "Software");
	assert.equal(close?.join, "or");

	const both = parseCondition(
		"not ((Region in West, East))",
		fields,
	)?.condition;
	assert.equal(both?.open, 2);
	assert.equal(both?.close, 2);
	assert.equal(both?.negate, true);
	assert.deepEqual(both?.values, ["West", "East"]);
});

// A value can hold brackets of its own, and those are part of the value.
test("brackets that belong to the value stay in it", () => {
	const c = parseCondition("Region = ACME (US)", fields)?.condition;
	assert.equal(c?.value, "ACME (US)");
	assert.equal(c?.close, undefined);

	const closing = parseCondition("Region = ACME (US))", fields)?.condition;
	assert.equal(closing?.value, "ACME (US)");
	assert.equal(closing?.close, 1);
});

test("a bracketed condition reads back as typed", () => {
	const typed = "(not Region = West))";
	const c = parseCondition(typed, fields)?.condition;
	assert.ok(c);
	assert.equal(describeCondition(c, true), "(not Region is West))");
	assert.equal(describeCondition(c), "not Region is West");
});

const leaf = (value: string, over: Partial<Condition> = {}): Condition =>
	c({ value, ...over });

test("a bracket groups an OR inside an AND", () => {
	const logic = toFilterLogic(
		[
			leaf("West"),
			leaf("Hardware", { field: "Division", open: 1 }),
			leaf("Software", { field: "Division", join: "or", close: 1 }),
		],
		kinds,
	);
	assert.deepEqual(logic.where, {
		all: [
			{ field: "Region", op: "eq", value: "West" },
			{
				any: [
					{ field: "Division", op: "eq", value: "Hardware" },
					{ field: "Division", op: "eq", value: "Software" },
				],
			},
		],
	});
});

test("without brackets AND still binds tighter than OR", () => {
	const logic = toFilterLogic(
		[
			leaf("West"),
			leaf("Hardware", { field: "Division" }),
			leaf("East", { join: "or" }),
		],
		kinds,
	);
	assert.deepEqual(logic.where, {
		any: [
			{
				all: [
					{ field: "Region", op: "eq", value: "West" },
					{ field: "Division", op: "eq", value: "Hardware" },
				],
			},
			{ field: "Region", op: "eq", value: "East" },
		],
	});
});

test("brackets nest, and one condition can close several", () => {
	const logic = toFilterLogic(
		[
			leaf("A", { open: 2 }),
			leaf("B", { join: "or", close: 1 }),
			leaf("C", { close: 1 }),
			leaf("D", { join: "or" }),
		],
		kinds,
	);
	// ((A or B) and C) or D
	assert.deepEqual(logic.where, {
		any: [
			{
				all: [
					{
						any: [
							{ field: "Region", op: "eq", value: "A" },
							{ field: "Region", op: "eq", value: "B" },
						],
					},
					{ field: "Region", op: "eq", value: "C" },
				],
			},
			{ field: "Region", op: "eq", value: "D" },
		],
	});
});

test("a bracket around one condition is just that condition", () => {
	const logic = toFilterLogic(
		[leaf("A", { open: 1, close: 1 }), leaf("B")],
		kinds,
	);
	assert.deepEqual(logic.where, {
		all: [
			{ field: "Region", op: "eq", value: "A" },
			{ field: "Region", op: "eq", value: "B" },
		],
	});
});

test("unpaired brackets are reported, not sent", () => {
	for (const row of [
		[leaf("A", { open: 1 }), leaf("B")],
		[leaf("A"), leaf("B", { close: 1 })],
		[leaf("A", { close: 1 }), leaf("B", { open: 1 })],
	]) {
		const logic = toFilterLogic(row, kinds);
		assert.ok(logic.problem, JSON.stringify(row));
		assert.equal(logic.where, undefined);
	}
});

// The case brackets exist for: a row condition beside a choice between totals.
test("a bracketed OR of totals beside a row condition is allowed", () => {
	const logic = toFilterLogic(
		[
			leaf("West"),
			c({ field: "Revenue", op: "gt", value: "1", open: 1 }),
			c({
				field: "Revenue PY",
				op: "gt",
				value: "1",
				join: "or",
				close: 1,
			}),
		],
		kinds,
	);
	assert.equal(logic.problem, undefined);
	assert.ok(logic.where);
});

test("an OR mixing kinds inside a bracket is reported", () => {
	const logic = toFilterLogic(
		[
			c({ open: 1 }),
			c({
				field: "Revenue",
				op: "gt",
				value: "1",
				join: "or",
				close: 1,
			}),
		],
		kinds,
	);
	assert.ok(logic.problem);
});

test("a row with no brackets and no OR stays a plain list", () => {
	const logic = toFilterLogic(
		[leaf("West"), leaf("Hardware", { field: "Division" })],
		kinds,
	);
	assert.equal(logic.where, undefined);
	assert.equal(logic.filters.length, 2);
});

// Editing a bracketed row. Removing a chip or a bracket must never leave the
// row with a bracket that does not pair, or the table stops loading on a click.

const row = () => [
	leaf("West"),
	leaf("Hardware", { field: "Division", open: 1 }),
	leaf("Software", { field: "Division", join: "or", close: 1 }),
];

test("removing the chip that opened a bracket hands it to the next", () => {
	const after = withoutCondition(row(), 1);
	assert.equal(bracketProblem(after), null);
	assert.equal(after[1].open, 1);
	// The group still joins what came before the way it did.
	assert.equal(after[1].join, "and");
});

test("removing the chip that closed a bracket hands it to the one before", () => {
	const after = withoutCondition(row(), 2);
	assert.equal(bracketProblem(after), null);
	assert.equal(after[1].close, 1);
});

test("a bracket around a single chip goes with it", () => {
	const after = withoutCondition(
		[leaf("A", { open: 1, close: 1 }), leaf("B")],
		0,
	);
	assert.equal(bracketProblem(after), null);
	assert.equal(after[0].open, undefined);
});

test("removing a bracket removes its pair", () => {
	for (const [i, side] of [
		[1, "open"],
		[2, "close"],
	] as const) {
		const after = withoutBracket(row(), i, side);
		assert.equal(bracketProblem(after), null);
		assert.equal(openDepth(after), 0);
		assert.ok(after.every((c) => !c.open && !c.close));
	}
});

test("removing an outer bracket leaves the inner pair", () => {
	const nested = [
		leaf("A", { open: 2 }),
		leaf("B", { join: "or", close: 1 }),
		leaf("C", { close: 1 }),
	];
	const after = withoutBracket(nested, 0, "open", 0);
	assert.equal(bracketProblem(after), null);
	assert.equal(after[0].open, 1);
	assert.equal(after[1].close, 1);
	assert.equal(after[2].close, undefined);

	// The second "(" is the inner one, and pairs with B.
	const inner = withoutBracket(nested, 0, "open", 1);
	assert.equal(bracketProblem(inner), null);
	assert.equal(inner[1].close, undefined);
	assert.equal(inner[2].close, 1);
});

test("brackets survive a saved view and a link", () => {
	const kept = cleanState({
		sourceKey: "s",
		columns: [],
		conditions: row(),
	});
	assert.equal(kept?.conditions[1].open, 1);
	assert.equal(kept?.conditions[2].close, 1);
	assert.equal(kept?.conditions[0].open, undefined);
});
