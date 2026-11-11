import assert from "node:assert/strict";
import { test } from "node:test";
import {
	withForecastChanges,
	withGoalValues,
	withLastSeen,
	type ReaderReport,
} from "./readerRows";

const held: ReaderReport = {
	forecasts: [],
	goalProgress: [
		{ goal_id: "a", day: "2026-11-08", value: 1 },
		{ goal_id: "a", day: "2026-11-09", value: 2 },
		{ goal_id: "b", day: "2026-11-09", value: 5 },
	],
	deckSeen: [],
	lastSeen: [
		{
			page_id: "p1",
			figures: { sales: 1 },
			seen_on: "2026-11-08T00:00:00.000Z",
		},
		{
			page_id: "p2",
			figures: { sales: 2 },
			seen_on: "2026-11-08T00:00:00.000Z",
		},
	],
};

test("a page's new figures replace only that page's", () => {
	const next = withLastSeen(held, {
		page_id: "p1",
		figures: { sales: 9 },
		seen_on: "2026-11-10T00:00:00.000Z",
	});
	assert.deepEqual(
		next.lastSeen.map((row) => [row.page_id, row.figures.sales]).sort(),
		[
			["p1", 9],
			["p2", 2],
		],
	);
	assert.equal(held.lastSeen.length, 2);
	assert.equal(held.lastSeen[0].figures.sales, 1);
});

test("a day's written values replace that day and keep the rest in day order", () => {
	const next = withGoalValues(held, [
		{ goal_id: "a", day: "2026-11-09", value: 3 },
		{ goal_id: "a", day: "2026-11-10", value: 4 },
	]);
	assert.deepEqual(
		next.goalProgress.filter((row) => row.goal_id === "a"),
		[
			{ goal_id: "a", day: "2026-11-08", value: 1 },
			{ goal_id: "a", day: "2026-11-09", value: 3 },
			{ goal_id: "a", day: "2026-11-10", value: 4 },
		],
	);
	assert.deepEqual(
		next.goalProgress.filter((row) => row.goal_id === "b"),
		[{ goal_id: "b", day: "2026-11-09", value: 5 }],
	);
	assert.equal(held.goalProgress.length, 3);
});

test("saved forecasts join what is held and filled actuals replace only that card's", () => {
	const start: ReaderReport = {
		...held,
		forecasts: [
			{
				visual_id: "v1",
				measure: "m",
				period: "2026-10",
				predicted: 1,
				low: 0,
				high: 2,
				actual: null,
			},
			{
				visual_id: "v2",
				measure: "m",
				period: "2026-10",
				predicted: 5,
				low: 4,
				high: 6,
				actual: null,
			},
		],
	};
	const next = withForecastChanges(
		start,
		"v1",
		"m",
		[
			{
				visual_id: "v1",
				measure: "m",
				period: "2026-11",
				predicted: 3,
				low: 2,
				high: 4,
				actual: null,
			},
			{
				visual_id: "v1",
				measure: "m",
				period: "2026-10",
				predicted: 9,
				low: 9,
				high: 9,
				actual: null,
			},
		],
		[
			{ period: "2026-10", actual: 1.5 },
			{ period: "2026-11", actual: 3.5 },
		],
	);
	assert.deepEqual(
		next.forecasts.map((row) => [
			row.visual_id,
			row.period,
			row.predicted,
			row.actual,
		]),
		[
			["v1", "2026-10", 1, 1.5],
			["v2", "2026-10", 5, null],
			["v1", "2026-11", 3, 3.5],
		],
	);
	assert.equal(start.forecasts[0].actual, null);
});
