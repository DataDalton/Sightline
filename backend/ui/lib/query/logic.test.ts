import assert from "node:assert/strict";
import { test } from "node:test";
import { compileQuery } from "./builder";
import {
	canonicalizeSpec,
	parseQuerySpec,
	QuerySpecError,
	type QuerySpec,
} from "./spec";
import type { SemanticField, SemanticSource } from "../semantic/types";

// NOT and OR, which a hand-built query needs and a report never did.
//
// The two properties that matter: a negated condition keeps the rows whose
// value is blank, because that is what excluding a value means to the person
// excluding it, and a query that uses neither is spelled and cached exactly as
// it was before either existed.

function field(
	name: string,
	kind: SemanticField["kind"],
	dataType = "string",
): SemanticField {
	return {
		fieldId: name,
		sourceKey: "orders",
		name,
		displayName: null,
		kind,
		sqlExpr: null,
		dataType,
		description: null,
		formatHint: null,
		tags: {},
		folder: null,
		sortOrder: 0,
		isDefault: false,
	};
}

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
	cacheTtlSeconds: 0,
	defaultTimeField: null,
	dimensions: [field("Category", "dimension"), field("Region", "dimension")],
	measures: [
		field("Revenue", "measure", "double"),
		field("Units", "measure", "int"),
	],
};

function spec(overrides: Partial<QuerySpec> = {}): QuerySpec {
	return {
		sourceKey: "orders",
		dimensions: ["Category"],
		measures: ["Revenue"],
		filters: [],
		sort: [],
		limit: 100,
		offset: 0,
		transforms: [],
		...overrides,
	};
}

test("a negated condition keeps rows whose value is blank", () => {
	const { sql } = compileQuery(
		source,
		spec({
			filters: [
				{ field: "Region", op: "eq", value: "West", negate: true },
			],
		}),
	);
	assert.match(sql, /IS NOT TRUE/);
	assert.doesNotMatch(sql, /WHERE NOT /);
});

test("alternatives between dimensions are ORed in WHERE", () => {
	const { sql, params } = compileQuery(
		source,
		spec({
			anyOf: [
				[{ field: "Region", op: "eq", value: "West" }],
				[
					{ field: "Region", op: "eq", value: "East" },
					{ field: "Category", op: "eq", value: "Hardware" },
				],
			],
		}),
	);
	assert.match(sql, /WHERE[\s\S]*\) OR \(/);
	assert.match(sql, / AND /);
	// Every value bound, none inlined.
	assert.equal(Object.keys(params).length, 3);
	assert.doesNotMatch(sql, /West|East|Hardware/);
});

test("alternatives between measures are ORed in HAVING", () => {
	const { sql } = compileQuery(
		source,
		spec({
			anyOf: [
				[{ field: "Revenue", op: "gt", value: "1000" }],
				[{ field: "Units", op: "gt", value: "50" }],
			],
		}),
	);
	assert.match(sql, /HAVING[\s\S]* OR /);
});

test("plain filters and alternatives apply together", () => {
	const { sql, params } = compileQuery(
		source,
		spec({
			filters: [{ field: "Category", op: "eq", value: "Hardware" }],
			anyOf: [
				[{ field: "Region", op: "eq", value: "West" }],
				[{ field: "Region", op: "eq", value: "East" }],
			],
		}),
	);
	// Three distinct markers, so the plain filter and the alternatives cannot
	// overwrite each other's values.
	assert.equal(new Set(Object.keys(params)).size, 3);
	assert.match(sql, /WHERE [\s\S]* AND \(\(/);
});

// A dimension is tested before grouping and a measure after it, so an OR
// between the two has nowhere to go that means anything.
test("an OR mixing a dimension and a measure is refused", () => {
	assert.throws(
		() =>
			compileQuery(
				source,
				spec({
					anyOf: [
						[{ field: "Region", op: "eq", value: "West" }],
						[{ field: "Revenue", op: "gt", value: "1000" }],
					],
				}),
			),
		QuerySpecError,
	);
});

test("negate and anyOf survive parsing", () => {
	const parsed = parseQuerySpec({
		sourceKey: "orders",
		dimensions: ["Category"],
		measures: ["Revenue"],
		filters: [{ field: "Region", op: "eq", value: "West", negate: true }],
		anyOf: [[{ field: "Category", op: "eq", value: "Hardware" }]],
	});
	assert.equal(parsed.filters[0].negate, true);
	assert.equal(parsed.anyOf?.length, 1);
});

test("a negate that is not literally true is not a negation", () => {
	const parsed = parseQuerySpec({
		sourceKey: "orders",
		filters: [{ field: "Region", op: "eq", value: "West", negate: "yes" }],
	});
	assert.equal(parsed.filters[0].negate, undefined);
});

test("an empty alternative group is refused", () => {
	assert.throws(
		() => parseQuerySpec({ sourceKey: "orders", anyOf: [[]] }),
		QuerySpecError,
	);
});

test("groups count toward the filter limit", () => {
	const many = Array.from({ length: 30 }, () => ({
		field: "Region",
		op: "eq",
		value: "x",
	}));
	assert.throws(
		() =>
			parseQuerySpec({
				sourceKey: "orders",
				filters: many,
				anyOf: [many],
			}),
		QuerySpecError,
	);
});

// Adding NOT and OR must not move a single existing cache entry.
test("a query using neither keeps the key it had before", () => {
	const plain = spec({
		filters: [{ field: "Region", op: "eq", value: "West" }],
	});
	const key = canonicalizeSpec(plain);
	assert.doesNotMatch(key, /"a":/);
	assert.doesNotMatch(key, /!Region/);
});

test("negation and alternatives change the key", () => {
	const plain = spec({
		filters: [{ field: "Region", op: "eq", value: "West" }],
	});
	const negated = spec({
		filters: [{ field: "Region", op: "eq", value: "West", negate: true }],
	});
	const either = spec({
		anyOf: [[{ field: "Region", op: "eq", value: "West" }]],
	});
	assert.notEqual(canonicalizeSpec(plain), canonicalizeSpec(negated));
	assert.notEqual(canonicalizeSpec(plain), canonicalizeSpec(either));
});

// Brackets. A condition tree nests to any depth, and the one rule it has to
// keep is where each part lands: rows are filtered before grouping and totals
// after, so a bracket is only valid when everything under an OR or NOT inside
// it is one kind.

test("a bracketed OR under AND keeps both sides of the AND", () => {
	const { sql } = compileQuery(
		source,
		spec({
			where: {
				all: [
					{ field: "Region", op: "eq", value: "West" },
					{
						any: [
							{ field: "Category", op: "eq", value: "Hardware" },
							{ field: "Category", op: "eq", value: "Software" },
						],
					},
				],
			},
		}),
	);
	assert.match(sql, /WHERE [\s\S]*AND \([\s\S]* OR [\s\S]*\)/);
});

// The case one level of alternatives could not express at all.
test("a top-level AND splits a row condition from a bracket of totals", () => {
	const { sql } = compileQuery(
		source,
		spec({
			where: {
				all: [
					{ field: "Region", op: "eq", value: "West" },
					{
						any: [
							{ field: "Revenue", op: "gt", value: "1000000" },
							{ field: "Units", op: "gt", value: "50" },
						],
					},
				],
			},
		}),
	);
	assert.match(sql, /WHERE [\s\S]*GROUP BY[\s\S]*HAVING \([\s\S]* OR /);
});

test("an OR mixing kinds inside a bracket is refused", () => {
	assert.throws(
		() =>
			compileQuery(
				source,
				spec({
					where: {
						any: [
							{ field: "Region", op: "eq", value: "West" },
							{ field: "Revenue", op: "gt", value: "1" },
						],
					},
				}),
			),
		QuerySpecError,
	);
});

test("a negated bracket keeps rows the whole bracket does not match", () => {
	const { sql } = compileQuery(
		source,
		spec({
			where: {
				not: {
					any: [
						{ field: "Region", op: "eq", value: "West" },
						{ field: "Region", op: "eq", value: "East" },
					],
				},
			},
		}),
	);
	assert.match(sql, /\(\([\s\S]* OR [\s\S]*\)\) IS NOT TRUE/);
});

test("every value in a tree is bound, none inlined", () => {
	const { sql, params } = compileQuery(
		source,
		spec({
			filters: [{ field: "Category", op: "eq", value: "Base" }],
			where: {
				all: [
					{ field: "Region", op: "eq", value: "West" },
					{ any: [{ field: "Region", op: "eq", value: "East" }] },
				],
			},
		}),
	);
	assert.equal(Object.keys(params).length, 3);
	assert.doesNotMatch(sql, /West|East|Base/);
});

test("a tree survives parsing and counts toward the filter limit", () => {
	const parsed = parseQuerySpec({
		sourceKey: "orders",
		where: {
			all: [
				{ field: "Region", op: "eq", value: "West" },
				{ not: { any: [{ field: "Category", op: "eq", value: "x" }] } },
			],
		},
	});
	assert.ok(parsed.where && "all" in parsed.where);

	const many = Array.from({ length: 41 }, () => ({
		field: "Region",
		op: "eq",
		value: "x",
	}));
	assert.throws(
		() => parseQuerySpec({ sourceKey: "orders", where: { any: many } }),
		QuerySpecError,
	);
});

test("nesting past the limit is refused rather than recursed", () => {
	let node: unknown = { field: "Region", op: "eq", value: "x" };
	for (let i = 0; i < 20; i++) node = { not: node };
	assert.throws(
		() => parseQuerySpec({ sourceKey: "orders", where: node }),
		QuerySpecError,
	);
});

test("an empty group is refused", () => {
	assert.throws(
		() => parseQuerySpec({ sourceKey: "orders", where: { any: [] } }),
		QuerySpecError,
	);
});

test("child order does not change a tree's key, grouping does", () => {
	const a = { field: "Region", op: "eq" as const, value: "West" };
	const b = { field: "Region", op: "eq" as const, value: "East" };
	const c = { field: "Category", op: "eq" as const, value: "Hardware" };
	const key = (where: QuerySpec["where"]) =>
		canonicalizeSpec(spec({ where }));
	assert.equal(key({ any: [a, b] }), key({ any: [b, a] }));
	assert.notEqual(
		key({ all: [a, { any: [b, c] }] }),
		key({ any: [{ all: [a, b] }, c] }),
	);
});
