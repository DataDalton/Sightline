import assert from "node:assert/strict";
import { test } from "node:test";
import {
	describeCondition,
	parseCondition,
	toFilterLogic,
	type Condition,
	type KnownField,
} from "./conditions";

const fields: KnownField[] = [
	{ name: "Division", kind: "dimension" },
	{ name: "Deal", kind: "dimension" },
	{ name: "Deal Status", kind: "dimension" },
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
		parseCondition("Deal Status is DRAFT", fields)?.condition.field,
		"Deal Status",
	);
	assert.equal(parseCondition("Deal = 12", fields)?.condition.field, "Deal");
	assert.equal(
		parseCondition("Revenue PY > 5", fields)?.condition.field,
		"Revenue PY",
	);
});

test("matching is case insensitive but keeps the field's own spelling", () => {
	assert.equal(
		parseCondition("division = Hardware", fields)?.condition.field,
		"Division",
	);
});

test("comparison operators are read longest first", () => {
	assert.equal(
		parseCondition("Revenue >= 10", fields)?.condition.op,
		"gte",
	);
	assert.equal(parseCondition("Revenue > 10", fields)?.condition.op, "gt");
	assert.equal(
		parseCondition("Revenue <= 10", fields)?.condition.op,
		"lte",
	);
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
	assert.equal(logic.anyOf?.length, 2);
	assert.equal(logic.anyOf?.[0].length, 2);
	assert.equal(logic.anyOf?.[1].length, 1);
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
