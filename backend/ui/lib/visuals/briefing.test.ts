import { test } from "node:test";
import assert from "node:assert/strict";
import {
	judge,
	lastFullMonth,
	monthName,
	orderSections,
	planSections,
	readBriefingSettings,
	settledWindow,
	startsFolded,
	usualRange,
	whyLine,
	windowField,
	type JudgeInput,
} from "./briefing";

const base: JudgeInput = {
	label: "Revenue",
	hint: "currency",
	value: 100,
	target: null,
	targetBasis: null,
	earlier: [],
	previous: null,
	previousLabel: null,
	direction: null,
};

test("each measure on a KPI row is a section, with the charts showing it", () => {
	const plans = planSections(
		[
			{
				visualId: "k",
				visualType: "kpiRow",
				config: {
					measures: ["Revenue", "Orders"],
					options: { compareField: "order_date" },
				},
			},
			{
				visualId: "c1",
				visualType: "barChart",
				config: { dimensions: ["Region"], measures: ["Revenue"] },
			},
			{
				visualId: "c2",
				visualType: "lineChart",
				config: { dimensions: ["order_date"], measures: ["Orders"] },
			},
		],
		"sales",
	);
	assert.deepEqual(
		plans.map((p) => [p.measure, p.anchorId, p.supporting]),
		[
			["Revenue", "k", ["c1"]],
			["Orders", "k", ["c2"]],
		],
	);
	assert.equal(plans[0].compareField, "order_date");
	assert.deepEqual(plans[0].anchorMeasures, ["Revenue", "Orders"]);
});

test("a page without KPI tiles takes each chart's first measure", () => {
	const plans = planSections(
		[
			{
				visualId: "c1",
				visualType: "barChart",
				config: { measures: ["Revenue", "Cost"] },
			},
			{ visualId: "f", visualType: "dropdownFilter", config: {} },
		],
		"sales",
	);
	assert.deepEqual(
		plans.map((p) => [p.measure, p.anchorId]),
		[["Revenue", "c1"]],
	);
});

test("settings keep only what the Briefing can use", () => {
	const held = readBriefingSettings({
		directions: { Revenue: "higher", Cost: "sideways" },
		notes: { Revenue: "  Call sales  ", Cost: "" },
		hidden: ["Orders", 4],
	});
	assert.deepEqual(held.directions, { Revenue: "higher" });
	assert.deepEqual(held.notes, { Revenue: "Call sales" });
	assert.deepEqual(held.hidden, ["Orders"]);
	assert.deepEqual(readBriefingSettings(null).order, []);
});

test("the date field a window is bounded on", () => {
	assert.equal(
		windowField([
			{ field: "order_date", op: "gte", value: "2026-11-01" },
			{ field: "order_date", op: "lt", value: "2026-12-01" },
		]),
		"order_date",
	);
	assert.equal(
		windowField([{ field: "order_date", op: "gte", value: "2026-11-01" }]),
		null,
	);
});

test("a window running past today is cut at today", () => {
	const filters = [
		{ field: "d", op: "gte", value: "2026-11-01" },
		{ field: "d", op: "lt", value: "2026-12-01" },
	];
	assert.deepEqual(settledWindow(filters, "d", "2026-11-17")?.[1], {
		field: "d",
		op: "lt",
		value: "2026-11-18",
	});
	assert.equal(settledWindow(filters, "d", "2026-12-05"), null);
});

test("a target judges the figure and says which way is good", () => {
	const behind = judge({
		...base,
		value: 80,
		target: { value: 100, direction: "higher" },
	});
	assert.equal(behind.tone, "bad");
	assert.equal(behind.label, "Behind target");
	assert.match(behind.sentence, /20% below its target/);
	assert.match(behind.comparedWith, /higher is better/);
	assert.equal(behind.off, true);

	const under = judge({
		...base,
		label: "Cost",
		value: 80,
		target: { value: 100, direction: "lower" },
	});
	assert.equal(under.tone, "good");
	assert.equal(under.off, false);
});

test("without a target the usual range judges, neutrally until a direction is set", () => {
	const earlier = [100, 102, 98, 101, 99, 100];
	const high = judge({ ...base, value: 140, earlier });
	assert.equal(high.label, "Higher than usual");
	assert.equal(high.tone, "neutral");
	assert.equal(high.off, true);
	assert.match(high.comparedWith, /Nobody has said yet/);

	const known = judge({ ...base, value: 140, earlier, direction: "lower" });
	assert.equal(known.tone, "bad");

	const usual = judge({ ...base, value: 101, earlier });
	assert.match(
		judge({ ...base, value: 101, earlier, periodNoun: "month" })
			.comparedWith,
		/a month, normally between .* from the 6 months before/,
	);
	assert.equal(usual.label, "As usual");
	assert.equal(usual.off, false);
});

test("with too little history the earlier window is the comparison", () => {
	const verdict = judge({
		...base,
		value: 130,
		earlier: [100],
		previous: 100,
		previousLabel: "last month",
		direction: "higher",
	});
	assert.equal(verdict.basis, "previous");
	assert.equal(verdict.sentence, "Revenue is $130, up 30% on last month.");
	assert.equal(verdict.tone, "good");
});

test("a percentage measure is judged in points", () => {
	const verdict = judge({
		...base,
		label: "Margin",
		hint: "percent",
		value: 30,
		previous: 35,
		previousLabel: "last month",
	});
	assert.match(verdict.sentence, /down 5\.0 pts on last month/);
});

test("a page of all dates is briefed on its last full month", () => {
	const window = lastFullMonth(
		[{ field: "r", op: "eq", values: ["W"] }],
		"d",
		"2026-11-17",
	);
	assert.deepEqual(window.slice(1), [
		{ field: "d", op: "gte", value: "2026-10-01" },
		{ field: "d", op: "lt", value: "2026-11-01" },
	]);
	assert.equal(monthName(window, "d"), "October 2026");
	assert.equal(lastFullMonth([], "d", "2026-01-05")[0].value, "2025-12-01");
});

test("a section with nothing to compare stays open", () => {
	assert.equal(startsFolded(judge(base)), false);
});

test("the usual range needs a few earlier periods", () => {
	assert.equal(usualRange([1, 2]), null);
	const range = usualRange([100, 100, 100]);
	assert.ok(range && range.low < 100 && range.high > 100);
});

test("what needs attention comes first unless the author set an order", () => {
	const make = (
		measure: string,
		tone: "bad" | "good" | "neutral",
		off = false,
	) => ({
		measure,
		verdict: { ...judge(base), basis: "usual" as const, tone, off },
	});
	const sections = [
		make("A", "good"),
		make("B", "neutral", true),
		make("C", "bad"),
	];
	assert.deepEqual(
		orderSections(sections, []).map((s) => s.measure),
		["C", "B", "A"],
	);
	assert.deepEqual(
		orderSections(sections, ["A"]).map((s) => s.measure),
		["A", "B", "C"],
	);
	assert.equal(startsFolded(sections[0].verdict), true);
	assert.equal(startsFolded(sections[2].verdict), false);
});

test("the why line names the largest mover and its share", () => {
	assert.equal(
		whyLine(
			"Region",
			{ value: "West", change: 1_200_000, share: 0.7 },
			"currency",
		),
		"Mostly West (Region), up $1.2M, 70% of the change.",
	);
});
