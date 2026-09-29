import assert from "node:assert/strict";
import { test } from "node:test";
import { compileQuery, nextDay } from "./builder";
import { canonicalizeSpec, type QuerySpec } from "./spec";
import type { SemanticField, SemanticSource } from "../semantic/types";
import { isValidObjectName, quoteName, quotedRef } from "../semantic/types";

// A calendar date against a timestamp column names a whole day. These tests
// hold the compiled SQL to that, and hold a date column to exact comparison.

function field(name: string, dataType: string | null): SemanticField {
	return {
		fieldId: name,
		sourceKey: "events",
		name,
		displayName: null,
		kind: "dimension",
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
	sourceKey: "events",
	title: "Events",
	description: null,
	catalog: "cat",
	schema: "sch",
	object: "events",
	kind: "metric_view",
	accessMode: "direct",
	hasRowFilter: false,
	cacheTtlSeconds: 300,
	isLive: false,
	defaultTimeField: "At",
	dimensions: [field("At", "timestamp"), field("Day", "date")],
	measures: [{ ...field("Count", "bigint"), kind: "measure" as const }],
};

function spec(overrides: Partial<QuerySpec>): QuerySpec {
	return {
		sourceKey: "events",
		dimensions: [],
		measures: ["Count"],
		filters: [],
		sort: [],
		limit: 100,
		offset: 0,
		transforms: [],
		...overrides,
	};
}

test("nextDay steps over month and year ends", () => {
	assert.equal(nextDay("2026-01-31"), "2026-02-01");
	assert.equal(nextDay("2026-12-31"), "2027-01-01");
	assert.equal(nextDay("2028-02-28"), "2028-02-29");
});

test("nextDay refuses anything that is not a real calendar date", () => {
	assert.equal(nextDay("2026-02-30"), null);
	assert.equal(nextDay("2026-01-31T10:00:00"), null);
	assert.equal(nextDay("yesterday"), null);
});

test("lte on a timestamp with a date keeps the whole last day", () => {
	const compiled = compileQuery(
		source,
		spec({ filters: [{ field: "At", op: "lte", value: "2026-03-31" }] }),
	);
	assert.match(compiled.sql, /`At` < CAST\(:f0 AS TIMESTAMP\)/);
	assert.equal(compiled.params.f0, "2026-04-01");
});

test("gt on a timestamp with a date starts after the whole day", () => {
	const compiled = compileQuery(
		source,
		spec({ filters: [{ field: "At", op: "gt", value: "2026-03-31" }] }),
	);
	assert.match(compiled.sql, /`At` >= CAST\(:f0 AS TIMESTAMP\)/);
	assert.equal(compiled.params.f0, "2026-04-01");
});

test("eq on a timestamp with a date matches the whole day", () => {
	const compiled = compileQuery(
		source,
		spec({ filters: [{ field: "At", op: "eq", value: "2026-03-31" }] }),
	);
	assert.match(
		compiled.sql,
		/\(`At` >= CAST\(:f0 AS TIMESTAMP\) AND `At` < CAST\(:f0_end AS TIMESTAMP\)\)/,
	);
	assert.equal(compiled.params.f0, "2026-03-31");
	assert.equal(compiled.params.f0_end, "2026-04-01");
});

test("neq on a timestamp with a date excludes the whole day", () => {
	const compiled = compileQuery(
		source,
		spec({ filters: [{ field: "At", op: "neq", value: "2026-03-31" }] }),
	);
	assert.match(
		compiled.sql,
		/\(`At` < CAST\(:f0 AS TIMESTAMP\) OR `At` >= CAST\(:f0_end AS TIMESTAMP\)\)/,
	);
});

test("a set of dates on a timestamp matches each whole day", () => {
	const compiled = compileQuery(
		source,
		spec({
			filters: [
				{ field: "At", op: "eq", values: ["2026-03-30", "2026-03-31"] },
			],
		}),
	);
	assert.match(compiled.sql, /CAST\(:f0_0_end AS TIMESTAMP\)/);
	assert.match(compiled.sql, /CAST\(:f0_1_end AS TIMESTAMP\)/);
	assert.equal(compiled.params.f0_1_end, "2026-04-01");
});

test("a full timestamp value is compared as given", () => {
	const compiled = compileQuery(
		source,
		spec({
			filters: [{ field: "At", op: "lte", value: "2026-03-31T12:00:00" }],
		}),
	);
	assert.match(compiled.sql, /`At` <= CAST\(:f0 AS TIMESTAMP\)/);
	assert.equal(compiled.params.f0, "2026-03-31T12:00:00");
});

test("a date column keeps an exact comparison", () => {
	const compiled = compileQuery(
		source,
		spec({ filters: [{ field: "Day", op: "lte", value: "2026-03-31" }] }),
	);
	assert.match(compiled.sql, /`Day` <= CAST\(:f0 AS TIMESTAMP\)/);
	assert.equal(compiled.params.f0, "2026-03-31");
});

test("two value lists that join to the same text keep separate keys", () => {
	const a = spec({
		filters: [{ field: "Day", op: "eq", values: ["ab", "c"] }],
	});
	const b = spec({
		filters: [{ field: "Day", op: "eq", values: ["a", "bc"] }],
	});
	assert.notEqual(canonicalizeSpec(a), canonicalizeSpec(b));
});

test("object names outside the identifier set are refused", () => {
	assert.equal(isValidObjectName("main"), true);
	assert.equal(isValidObjectName("my-catalog"), true);
	assert.equal(isValidObjectName("a.b"), false);
	assert.equal(isValidObjectName("x` ; DROP"), false);
	assert.equal(isValidObjectName(""), false);
});

test("object names are quoted when they are not plain identifiers", () => {
	assert.equal(quotedRef("cat", "sch", "orders"), "cat.sch.orders");
	assert.equal(quoteName("my-catalog"), "`my-catalog`");
	assert.equal(quoteName("we`ird"), "`we``ird`");
	assert.match(
		compileQuery({ ...source, catalog: "my-cat" }, spec({})).sql,
		/FROM `my-cat`\.sch\.events/,
	);
});
