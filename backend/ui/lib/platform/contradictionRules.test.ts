import { test } from "node:test";
import assert from "node:assert/strict";
import {
	differencesBetween,
	disagree,
	collapseCandidates,
	findCandidates,
	pairKey,
	totalOf,
	type ComparedVisual,
} from "./contradictionRules";

const visual = (extra: Partial<ComparedVisual>): ComparedVisual => ({
	visualId: "v1",
	reportId: "r1",
	reportTitle: "Sales",
	reportSlug: "sales",
	pageTitle: "One",
	title: "Revenue",
	sourceKey: "orders",
	measure: "Revenue",
	dimensions: [],
	filters: [],
	options: {},
	...extra,
});

const west = { field: "Region", op: "eq", values: ["West"] };

test("a filter one has and the other lacks is named", () => {
	const left = visual({ filters: [west] });
	const right = visual({ reportId: "r2", reportTitle: "Finance" });
	assert.deepEqual(differencesBetween(left, right), [
		"Sales only counts Region is West",
	]);
});

test("the same filter in a different order is no difference", () => {
	const left = visual({
		filters: [{ field: "Region", op: "eq", values: ["West", "East"] }],
	});
	const right = visual({
		reportId: "r2",
		filters: [{ field: "Region", op: "eq", values: ["East", "West"] }],
	});
	assert.deepEqual(differencesBetween(left, right), []);
});

test("keeping only the top rows is named", () => {
	const left = visual({ options: { topN: 10 } });
	const right = visual({ reportId: "r2", reportTitle: "Finance" });
	assert.match(differencesBetween(left, right)[0], /only the top 10/);
});

test("pairs need the same measure and breakdown on different reports", () => {
	const base = visual({ filters: [west] });
	const pair = (other: Partial<ComparedVisual>) =>
		findCandidates([
			base,
			visual({ visualId: "v2", reportId: "r2", ...other }),
		]);
	assert.equal(pair({}).length, 1);
	assert.equal(pair({ measure: "Cost" }).length, 0);
	assert.equal(pair({ sourceKey: "other" }).length, 0);
	assert.equal(pair({ dimensions: ["Region"] }).length, 0);
	assert.equal(pair({ reportId: "r1" }).length, 0);
	assert.equal(pair({ filters: [west] }).length, 0);
});

test("totals add up what came back and ignore what is not a number", () => {
	assert.equal(totalOf([{ m: 1 }, { m: "2" }, { m: "x" }, {}], "m"), 3);
});

test("rounding is not a disagreement", () => {
	assert.equal(disagree(100, 100.01), false);
	assert.equal(disagree(100, 110), true);
	assert.equal(disagree(0, 0), false);
	assert.equal(disagree(0, 5), true);
});

test("a page's opening filter counts as a difference and matches the same visual filter", () => {
	const base = {
		visualId: "a",
		reportId: "r1",
		reportTitle: "Sales",
		reportSlug: "sales",
		pageTitle: "One",
		title: null,
		sourceKey: "orders",
		measure: "Revenue",
		dimensions: [],
		filters: [],
		options: {},
	};
	const clause = { field: "Region", op: "eq", value: "West" };
	assert.deepEqual(
		differencesBetween(
			{ ...base, pageFilters: [clause] },
			{ ...base, reportId: "r2", reportTitle: "Finance" },
		),
		["Sales opens showing only Region is West"],
	);
	assert.deepEqual(
		differencesBetween(
			{ ...base, pageFilters: [clause] },
			{
				...base,
				reportId: "r2",
				reportTitle: "Finance",
				filters: [clause],
			},
		),
		[],
	);
});

test("a pair has one name whichever way round it was found", () => {
	assert.equal(pairKey("a", "b", "Revenue"), pairKey("b", "a", "Revenue"));
	assert.notEqual(pairKey("a", "b", "Revenue"), pairKey("a", "b", "Cost"));
});

test("two reports differing the same way on many visuals are one thing to fix", () => {
	const side = (visualId: string, reportId: string) => ({
		visualId,
		reportId,
		reportTitle: reportId,
		reportSlug: reportId,
		pageTitle: "One",
		title: null,
		sourceKey: "orders",
		measure: "Revenue",
		dimensions: [],
		filters: [],
		options: {},
	});
	const candidate = (left: string, right: string, differences: string[]) => ({
		key: `${left}:${right}`,
		sourceKey: "orders",
		measure: "Revenue",
		left: side(left, "r1"),
		right: side(right, "r2"),
		differences,
	});
	const collapsed = collapseCandidates([
		candidate("a", "b", ["x", "y"]),
		candidate("c", "d", ["y", "x"]),
		candidate("e", "f", ["z"]),
	]);
	assert.equal(collapsed.length, 2);
	assert.equal(collapsed[0].alsoOn, 1);
	assert.equal(collapsed[1].alsoOn, 0);
});

test("a date filter is said in words", () => {
	const base = {
		visualId: "a",
		reportId: "r1",
		reportTitle: "Sales",
		reportSlug: "sales",
		pageTitle: "One",
		title: null,
		sourceKey: "orders",
		measure: "Revenue",
		dimensions: [],
		filters: [],
		options: {},
	};
	assert.deepEqual(
		differencesBetween(
			{
				...base,
				pageFilters: [
					{ field: "Order Date", op: "gte", value: "2026-01-01" },
				],
			},
			{ ...base, reportId: "r2", reportTitle: "Finance" },
		),
		["Sales opens showing only Order Date from 2026-01-01"],
	);
});
