import assert from "node:assert/strict";
import { test } from "node:test";
import {
	needsWholeResult,
	pagedSpec,
	sliceWindow,
	wholeResultLimit,
} from "./paging";
import { canonicalizeSpec, maxLimit, type QuerySpec } from "./spec";
import { applyTransforms, type QueryTransform } from "./transform";

const spec = (overrides: Partial<QuerySpec> = {}): QuerySpec => ({
	sourceKey: "sales",
	dimensions: ["Region"],
	measures: ["Sales"],
	filters: [],
	sort: [{ field: "Sales", direction: "desc" }],
	limit: 2,
	offset: 0,
	transforms: [],
	...overrides,
});

const rank: QueryTransform = {
	kind: "rank",
	measure: "Sales",
	as: "Rank",
	direction: "desc",
};
const share: QueryTransform = {
	kind: "percentOfTotal",
	measure: "Sales",
	as: "Share",
};
const running: QueryTransform = {
	kind: "runningTotal",
	measure: "Sales",
	as: "Running",
};
const ratio: QueryTransform = {
	kind: "ratio",
	measure: "Sales",
	denominator: "Sales",
	as: "Self",
};

// The whole answer as the warehouse would return it, sorted by Sales.
const whole = () => [
	{ Region: "North", Sales: 40 },
	{ Region: "South", Sales: 30 },
	{ Region: "East", Sales: 20 },
	{ Region: "West", Sales: 10 },
];

// Runs a spec the way executeQuery does, against an in-memory answer.
const execute = (asked: QuerySpec) => {
	const { spec: run, window } = pagedSpec(asked);
	const fetched = whole().slice(run.offset, run.offset + run.limit);
	const derived = applyTransforms(
		fetched,
		["Region", "Sales"],
		run.transforms,
	);
	return sliceWindow(derived.rows, window);
};

test("only transforms that read other rows need the whole answer", () => {
	assert.equal(needsWholeResult(undefined), false);
	assert.equal(needsWholeResult([]), false);
	assert.equal(needsWholeResult([ratio]), false);
	assert.equal(needsWholeResult([ratio, rank]), true);
	assert.equal(needsWholeResult([share]), true);
	assert.equal(needsWholeResult([running]), true);
	assert.equal(
		needsWholeResult([{ kind: "indexTo", measure: "Sales", as: "Index" }]),
		true,
	);
});

test("a spec without whole-answer transforms is run as asked", () => {
	const asked = spec({ offset: 2, transforms: [ratio] });
	const paged = pagedSpec(asked);
	assert.equal(paged.spec, asked);
	assert.equal(paged.window, null);
});

test("a distribution is run as asked", () => {
	const asked = spec({
		offset: 2,
		transforms: [rank],
		distribution: { kind: "summary", detail: ["Order"] },
	});
	assert.equal(pagedSpec(asked).window, null);
});

test("a spec already asking for the whole answer is run as asked", () => {
	const asked = spec({ limit: maxLimit, transforms: [rank] });
	const paged = pagedSpec(asked);
	assert.equal(paged.spec, asked);
	assert.equal(paged.window, null);
});

test("a paged spec is widened to the whole answer from the first row", () => {
	const paged = pagedSpec(spec({ offset: 2, transforms: [rank] }));
	assert.equal(paged.spec.offset, 0);
	assert.equal(paged.spec.limit, maxLimit);
	assert.deepEqual(paged.window, { offset: 2, limit: 2 });
});

test("every page of one question shares one cache key", () => {
	const first = pagedSpec(spec({ offset: 0, transforms: [rank] })).spec;
	const second = pagedSpec(spec({ offset: 2, transforms: [rank] })).spec;
	assert.equal(canonicalizeSpec(first), canonicalizeSpec(second));
});

test("the widened key still tells transforms apart", () => {
	const ranked = pagedSpec(spec({ offset: 2, transforms: [rank] })).spec;
	const shared = pagedSpec(spec({ offset: 2, transforms: [share] })).spec;
	assert.notEqual(canonicalizeSpec(ranked), canonicalizeSpec(shared));
});

test("a window past the largest request widens to the next multiple", () => {
	assert.equal(wholeResultLimit({ offset: 0, limit: 200 }), maxLimit);
	assert.equal(
		wholeResultLimit({ offset: maxLimit - 200, limit: 200 }),
		maxLimit,
	);
	assert.equal(
		wholeResultLimit({ offset: maxLimit, limit: 200 }),
		maxLimit * 2,
	);
	const paged = pagedSpec(
		spec({ offset: maxLimit + 10, transforms: [rank] }),
	);
	assert.equal(paged.spec.limit, maxLimit * 2);
});

test("rank carries on across pages", () => {
	const second = execute(spec({ offset: 2, transforms: [rank] }));
	assert.deepEqual(
		second.map((row) => [row.Region, row.Rank]),
		[
			["East", 3],
			["West", 4],
		],
	);
});

test("shares are of the whole answer, not of the page", () => {
	const first = execute(spec({ offset: 0, transforms: [share] }));
	const second = execute(spec({ offset: 2, transforms: [share] }));
	assert.deepEqual(
		[...first, ...second].map((row) => row.Share),
		[40, 30, 20, 10],
	);
});

test("a running total carries on across pages", () => {
	const second = execute(spec({ offset: 2, transforms: [running] }));
	assert.deepEqual(
		second.map((row) => row.Running),
		[90, 100],
	);
});

test("a page past the end is empty", () => {
	assert.deepEqual(execute(spec({ offset: 4, transforms: [rank] })), []);
});

test("no window returns the same rows", () => {
	const rows = whole();
	assert.equal(sliceWindow(rows, null), rows);
});
