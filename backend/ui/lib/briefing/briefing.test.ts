import assert from "node:assert/strict";
import { test } from "node:test";
import type { SemanticSource } from "../semantic/types";
import {
	buildCard,
	chooseShown,
	historyStart,
	latestFinished,
	previousOf,
	readProbe,
	splitWindows,
	standingOf,
	windowOf,
	worthExplaining,
	type Card,
} from "./card";
import { cardKey, cardScope } from "./keys";
import { orderReports } from "./order";
import { timeFieldFor, watchList, type WatchReport } from "./watch";
import {
	driverText,
	headline,
	movementText,
	periodLabel,
	toneOf,
	waitingText,
} from "./words";

function field(name: string, extra: Record<string, unknown> = {}) {
	return {
		fieldId: name,
		name,
		displayName: null,
		kind: "dimension",
		sqlExpr: null,
		dataType: null,
		description: null,
		formatHint: null,
		tags: {},
		folder: null,
		sortOrder: 0,
		isDefault: false,
		...extra,
	};
}

const sales = {
	sourceKey: "sales",
	title: "Sales",
	defaultTimeField: "databricksTimestamp",
	dimensions: [
		field("Order Date", { dataType: "date", formatHint: "date" }),
		field("databricksTimestamp", { dataType: "timestamp" }),
		field("Division"),
		field("Region"),
	],
	measures: [
		field("Net Sales", { kind: "measure", formatHint: "currency" }),
		field("Units", { kind: "measure", formatHint: "integer" }),
		field("Orders", { kind: "measure", formatHint: "integer" }),
	],
} as unknown as SemanticSource;

const report: WatchReport = {
	reportId: "r1",
	slug: "sales",
	title: "Sales Overview",
	sourceKey: "sales",
	pages: [
		{
			sourceKey: null,
			visuals: [
				{
					visualType: "kpiRow",
					sourceKey: null,
					config: {
						measures: ["Net Sales", "Units", "Orders"],
						options: {
							targets: { "Net Sales": { direction: "higher" } },
						},
					},
				},
				{
					visualType: "barChart",
					sourceKey: null,
					config: { dimensions: ["Division"] },
				},
				{
					visualType: "donutChart",
					sourceKey: null,
					config: { dimensions: ["Division"] },
				},
				{
					visualType: "barChart",
					sourceKey: null,
					config: { dimensions: ["Region", "<selected>"] },
				},
				{
					visualType: "table",
					sourceKey: null,
					config: { dimensions: ["Order Date"] },
				},
			],
		},
	],
};

test("a pipeline timestamp is never the time field", () => {
	assert.equal(timeFieldFor(sales, "Net Sales", "r1", []), null);
	assert.equal(
		timeFieldFor(sales, "Net Sales", "r1", [
			{
				reportId: "r1",
				sourceKey: "sales",
				measure: "Net Sales",
				timeField: "Order Date",
			},
		]),
		"Order Date",
	);
});

test("headline figures come from the scorecard, split by what the page charts", () => {
	const sources = new Map([["sales", sales]]);
	const alerts = [
		{
			reportId: "r9",
			sourceKey: "sales",
			measure: "Units",
			timeField: "Order Date",
		},
	];
	const items = watchList(
		[report, { ...report, reportId: "r2", slug: "copy" }],
		sources,
		alerts,
		10,
	);
	assert.deepEqual(
		items.map((i) => i.measure),
		["Net Sales", "Units"],
	);
	assert.deepEqual(items[0].splitBy, ["Division", "Region"]);
	assert.equal(items[0].better, "higher");
	assert.equal(items[1].better, null);
	assert.equal(items[0].hint, "currency");
});

const daily = (values: number[], last: string) => {
	const end = Date.parse(`${last}T00:00:00Z`);
	return values.map((value, i) => ({
		"Order Date": new Date(end - (values.length - 1 - i) * 86_400_000)
			.toISOString()
			.slice(0, 10),
		"Net Sales": value,
	}));
};

test("the latest finished day is judged against the same weekday", () => {
	const rows = daily(
		Array.from({ length: 63 }, (_, i) => (i === 62 ? 400 : 100 + (i % 3))),
		"2026-09-29",
	);
	const latest = latestFinished(
		rows.map((r) => r["Order Date"]),
		"2026-09-30",
	);
	assert.deepEqual(latest, { target: "2026-09-29", spacing: 1 });
	const card = buildCard("x", rows, {
		timeField: "Order Date",
		measure: "Net Sales",
		target: "2026-09-29",
		spacing: 1,
		today: "2026-09-30",
	});
	assert.ok(card);
	assert.equal(card.value, 400);
	assert.equal(card.unusual, true);
	assert.equal(card.previousPeriod, "2026-09-22");
	assert.ok(card.series.length <= 42);
	assert.deepEqual(card.window, { gte: "2026-09-29", lt: "2026-09-30" });
	assert.ok(worthExplaining(card));
});

test("a month is compared with the month before", () => {
	assert.equal(
		previousOf("2026-08-01", 31, [
			"2026-06-01",
			"2026-07-01",
			"2026-08-01",
		]),
		"2026-07-01",
	);
	assert.deepEqual(windowOf("2026-08-01", 31), {
		gte: "2026-08-01",
		lt: "2026-09-01",
	});
	// Enough months behind the latest for the sparkline and the usual range.
	assert.ok(historyStart("2026-08-01", 31) <= "2025-07-01");
});

test("tone needs a target to say which way is good", () => {
	assert.equal(toneOf({ againstUsual: 0.2 }, null), "neutral");
	assert.equal(toneOf({ againstUsual: 0.2 }, "higher"), "good");
	assert.equal(toneOf({ againstUsual: 0.2 }, "lower"), "bad");
	assert.equal(toneOf({ againstUsual: 0.01 }, "lower"), "neutral");
});

test("the briefing in words", () => {
	assert.equal(
		movementText({ againstUsual: 0.183, usual: 10 }),
		"18% above usual",
	);
	assert.equal(
		movementText({ againstUsual: -0.005, usual: 10 }),
		"In line with usual",
	);
	assert.equal(
		movementText({ againstUsual: 11.64, usual: 10 }),
		"12.6× usual",
	);
	assert.equal(
		driverText(
			{ dimension: "Region", member: "Europe", change: -840, share: 0.7 },
			"integer",
		),
		"Mostly Europe (Region), -840, 70% of the change",
	);
	assert.equal(
		driverText(
			{ dimension: "Source", member: "Search", change: 148, share: 0.19 },
			"integer",
		),
		"Led by Search (Source), +148, 19% of the change",
	);
	assert.equal(periodLabel("2026-09-01", 30), "September 2026");
	assert.equal(periodLabel("2026-09-29", 1), "Tue 29 Sep");
	assert.equal(
		headline({ unusual: 2, moving: 1, late: 1, fired: 0, reading: false }),
		"2 figures are outside their usual range and one source is running late",
	);
	assert.equal(
		headline({ unusual: 1, moving: 0, late: 1, fired: 3, reading: false }),
		"One figure is outside its usual range, 3 alerts fired and one source is running late",
	);
	assert.equal(
		headline({ unusual: 0, moving: 0, late: 0, fired: 0, reading: false }),
		"Everything is within its usual range",
	);
});

test("a pinned figure is kept and a hidden one is left out", () => {
	const sources = new Map([["sales", sales]]);
	const alerts = [
		{
			reportId: "r1",
			sourceKey: "sales",
			measure: "Net Sales",
			timeField: "Order Date",
		},
	];
	const items = watchList([report], sources, alerts, 0, [
		{ reportId: "r1", measure: "Orders", choice: "pin" },
	]);
	// Every pin is kept whatever the limit, and any measure the report shows
	// can be pinned.
	assert.deepEqual(
		items.map((i) => [i.measure, i.pinned]),
		[["Orders", true]],
	);
	const shown = watchList([report], sources, alerts, 10, [
		{ reportId: "r1", measure: "Net Sales", choice: "hide" },
	]);
	assert.deepEqual(
		shown.map((i) => i.measure),
		["Units", "Orders"],
	);
});

test("pinning a figure leaves the rest of the selection as it was", () => {
	const sources = new Map([["sales", sales]]);
	const alerts = [
		{
			reportId: "r1",
			sourceKey: "sales",
			measure: "Net Sales",
			timeField: "Order Date",
		},
	];
	const before = watchList([report], sources, alerts, 2).map(
		(i) => i.measure,
	);
	const after = watchList([report], sources, alerts, 2, [
		{ reportId: "r1", measure: "Units", choice: "pin" },
	]);
	assert.deepEqual(before, ["Net Sales", "Units"]);
	assert.deepEqual(
		after.map((i) => [i.measure, i.pinned]),
		[
			["Units", true],
			["Net Sales", false],
		],
	);
});

test("reports are read in the order of the reader's own marks, then use", () => {
	const r = (id: string) => ({
		reportId: id,
		slug: id,
		title: id,
		categoryId: null,
	});
	const ordered = orderReports([r("a"), r("b"), r("c"), r("d"), r("e")], {
		favourites: ["c"],
		yours: ["e"],
		frequent: ["c", "b"],
		popular: ["d", "x"],
	});
	assert.deepEqual(
		ordered.map((x) => [x.reportId, x.why]),
		[
			["c", "favourite"],
			["e", "yours"],
			["b", "frequent"],
			["d", "popular"],
			["a", null],
		],
	);
});

// --- One read for the latest period and its history -----------------------

function dailyRows(days: number, endKey: string) {
	const end = Date.parse(`${endKey}T00:00:00Z`);
	return Array.from({ length: days }, (_, i) => ({
		day: new Date(end - i * 86_400_000).toISOString().slice(0, 10),
		sales: 100 + i,
	}));
}

test("one read holds the latest finished day and its history", () => {
	const rows = dailyRows(64, "2026-09-30");
	const reading = readProbe(rows, "day", "2026-09-30", 64);
	assert.equal(reading.kind, "ready");
	if (reading.kind !== "ready") return;
	assert.equal(reading.target, "2026-09-29");
	assert.equal(reading.spacing, 1);
	// Oldest first, from the start of the history to the finished day.
	assert.equal(reading.rows[0].day, historyStart("2026-09-29", 1));
	assert.equal(reading.rows.at(-1)?.day, "2026-09-29");
});

test("a read that filled its limit short of the history asks for it", () => {
	const rows = dailyRows(20, "2026-09-30");
	assert.equal(readProbe(rows, "day", "2026-09-30", 20).kind, "short");
	// The same rows under the limit are all there is.
	assert.equal(readProbe(rows, "day", "2026-09-30", 64).kind, "ready");
});

test("nothing finished yet reads as no card", () => {
	const rows = [{ day: "2026-09-30", sales: 1 }];
	assert.equal(readProbe(rows, "day", "2026-09-30", 64).kind, "none");
});

// --- Both windows of a breakdown from one read -----------------------------

test("a breakdown read across both periods splits back into each", () => {
	const rows = [
		{ region: "East", day: "2026-09-22", sales: 5 },
		{ region: "East", day: "2026-09-25", sales: 9 },
		{ region: "East", day: "2026-09-29", sales: 7 },
		{ region: "West", day: "2026-09-29", sales: 3 },
	];
	const split = splitWindows(
		rows,
		"day",
		"region",
		"sales",
		{ gte: "2026-09-29", lt: "2026-09-30" },
		{ gte: "2026-09-22", lt: "2026-09-23" },
	);
	assert.deepEqual(split, {
		current: [
			{ region: "East", sales: 7 },
			{ region: "West", sales: 3 },
		],
		previous: [{ region: "East", sales: 5 }],
	});
});

test("a window holding several periods is asked for on its own", () => {
	const rows = [
		{ region: "East", day: "2026-09-01", sales: 5 },
		{ region: "East", day: "2026-09-15", sales: 9 },
	];
	const split = splitWindows(
		rows,
		"day",
		"region",
		"sales",
		{ gte: "2026-09-01", lt: "2026-10-01" },
		{ gte: "2026-08-01", lt: "2026-09-01" },
	);
	assert.equal(split, null);
});

// --- Who a stored card may be handed to ------------------------------------

const watched = {
	id: "r1:Sales",
	reportId: "r1",
	slug: "sales",
	reportTitle: "Sales",
	sourceKey: "orders",
	measure: "Sales",
	hint: "decimal" as const,
	timeField: "Day",
	splitBy: ["Region"],
	better: null,
	pinned: false,
};

test("an unfiltered dataset's card is held once for everyone", () => {
	assert.equal(
		cardScope({ shareable: true, filtered: false }, "p1", "A@x.com"),
		"unfiltered",
	);
});

test("a filtered dataset's card is held per policy class", () => {
	assert.equal(
		cardScope({ shareable: true, filtered: true }, "p1", "A@x.com"),
		"p1",
	);
});

test("a dataset whose filters are unread holds a card per reader", () => {
	assert.equal(
		cardScope({ shareable: false, filtered: true }, "p1", "A@x.com"),
		"person:a@x.com:p1",
	);
});

test("the same figure on two reports is one card, scopes never meet", () => {
	const other = { ...watched, id: "r2:Sales", reportId: "r2", slug: "b" };
	assert.equal(cardKey("p1", watched), cardKey("p1", other));
	assert.notEqual(cardKey("p1", watched), cardKey("p2", watched));
	assert.ok(cardKey("unfiltered", watched).startsWith("unfiltered:"));
	// A different breakdown says something different about what moved it.
	assert.notEqual(
		cardKey("p1", watched),
		cardKey("p1", { ...watched, splitBy: ["Product"] }),
	);
});

// --- Choosing what the page shows once figures are read ---------------------

function read(
	id: string,
	unusual: boolean,
	againstUsual: number,
	weight: number,
) {
	return { id, card: { unusual, againstUsual, weight } as Card };
}

test("a figure far from usual is shown however far down its report sits", () => {
	const entries = [
		read("first", false, 0.01, 0.1),
		read("second", false, 0.02, 0.2),
		read("third", false, 0.15, 1.5),
		read("last", true, 27, 19),
	];
	assert.deepEqual(
		chooseShown(entries, 2).map((e) => e.id),
		["third", "last"],
	);
});

test("steady figures fill what is left in the order given", () => {
	const entries = [
		read("a", false, 0.01, 0.1),
		read("b", false, 0.05, 0.5),
		read("c", false, 0.02, 0.2),
	];
	assert.deepEqual(
		chooseShown(entries, 2).map((e) => e.id),
		["a", "b"],
	);
});

test("an early signal comes after confirmed figures and before moving ones", () => {
	const entries = [
		read("moving", false, 0.5, 5),
		{
			id: "early",
			card: {
				unusual: false,
				early: true,
				againstUsual: -0.9,
				weight: 9.5,
			} as Card,
		},
		read("confirmed", true, 0.3, 13),
	];
	assert.deepEqual(
		chooseShown(entries, 2).map((e) => e.id),
		["early", "confirmed"],
	);
	assert.equal(standingOf(entries[1].card), "early");
	// Low only as far as a young period usually is reads as steady.
	assert.equal(
		standingOf({
			unusual: false,
			againstUsual: -0.4,
			settling: { reason: "fillingIn" },
		} as Card),
		"steady",
	);
});

test("with room for everything nothing is left out", () => {
	const entries = [read("a", true, 1, 15), read("b", false, 0, 0)];
	assert.equal(chooseShown(entries, 16).length, 2);
});

test("a load past its usual time is called late", () => {
	const at = Date.parse("2026-10-01T06:00:00Z");
	const waiting = {
		period: "2026-09-30",
		through: "2026-09-30",
		expectedBy: at,
	};
	assert.match(
		waitingText(waiting, 1, at - 3_600_000, "UTC"),
		/usually arrives by .*\.$/,
	);
	assert.match(
		waitingText(waiting, 1, at + 3_600_000, "UTC"),
		/running late\.$/,
	);
});
