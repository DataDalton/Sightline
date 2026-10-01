import assert from "node:assert/strict";
import { test } from "node:test";
import { alongside, buildCard, settleCard, type Card } from "../briefing/card";
import { headline, settlingText, waitingText } from "../briefing/words";
import type { ArrivalPattern } from "../freshness/arrivals";
import { isAdditiveExpression } from "../semantic/aggregation";
import {
	ageOf,
	decideLoad,
	defaultSettleHours,
	dueAfter,
	evenness,
	expectedShare,
	judgeSettling,
	learnSettling,
	nextLoadAfter,
	observedBucket,
	zoneMidnight,
	type LoadEvidence,
	type Observation,
	type SettlingInput,
} from "./completeness";
import { evaluate, settlingNote, type Reading } from "./rule";

const hour = 3_600_000;
const day = 24 * hour;
const at = (iso: string) => Date.parse(iso);

// A table that loads once a day, landing by six in the morning.
const dailyLoad: ArrivalPattern = {
	kind: "regular",
	arrivals: 30,
	activeDays: [0, 1, 2, 3, 4, 5, 6],
	usualGapMs: day,
	lateAfterMs: day + 2 * hour,
	usualMinute: 6 * 60,
	stream: false,
	setBy: "learned",
};

function loads(newest: string | null, pattern = dailyLoad): LoadEvidence {
	return {
		checked: true,
		tables: [
			{
				table: "main.sales.orders",
				newest: newest ? at(newest) : null,
				pattern,
			},
		],
	};
}

// Every day of September, the last one partly loaded.
const september = Array.from(
	{ length: 30 },
	(_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`,
);

function rows(last: number): Record<string, unknown>[] {
	return september.map((d, i) => ({
		day: d,
		sales: i === september.length - 1 ? last : 21_000 + (i % 3) * 300,
	}));
}

// Earlier periods read while they filled in. Nothing at three hours, most of
// it by nine, all of it from a day and a quarter on.
function history(): Observation[] {
	const out: Observation[] = [];
	for (const period of september.slice(5, 12)) {
		for (const [ageHours, share] of [
			[3, 0],
			[9, 0.6],
			[20, 0.9],
			[30, 1],
			[60, 1],
		]) {
			out.push({ period, ageHours, value: 21_000 * share });
		}
	}
	return out;
}

const base: Omit<SettlingInput, "value" | "unusual" | "ageHours"> = {
	usual: 21_000,
	low: 18_900,
	additive: true,
	spacing: 1,
	landed: true,
	learned: null,
	evenness: null,
};

// --- The September 30 partial load -------------------------------------------

test("a day whose load has not landed waits, and the day before is judged", () => {
	// The newest load ran in the evening of the 30th, before the day ended.
	const now = at("2026-10-01T03:00:00Z");
	const decision = decideLoad(
		loads("2026-09-30T23:00:00Z"),
		september,
		"2026-09-30",
		1,
		"UTC",
		"2026-10-01",
	);
	assert.equal(decision.judged, "2026-09-29");
	assert.equal(decision.known, true);
	assert.deepEqual(decision.waiting, {
		period: "2026-09-30",
		through: "2026-09-30",
		expectedBy: at("2026-10-01T06:00:00Z"),
	});
	assert.equal(
		waitingText(decision.waiting!, 1, now, "UTC"),
		"Wed 30 Sep has not loaded yet. It usually arrives by 6:00 AM.",
	);

	// The card judges the 29th and is not unusual, and the 30th is drawn as
	// still to come.
	const card = buildCard("x", rows(2), {
		timeField: "day",
		measure: "sales",
		target: decision.judged!,
		spacing: 1,
		today: "2026-10-01",
		through: "2026-09-30",
	});
	assert.ok(card);
	assert.equal(card.period, "2026-09-29");
	assert.equal(card.unusual, false);
	const settled = settleCard(card, {
		settling: judgeSettling({
			...base,
			value: card.value,
			usual: card.usual,
			low: card.low,
			unusual: card.unusual,
			ageHours: ageOf(card.period, 1, "UTC", now),
		}),
		waiting: decision.waiting,
		settleHours: defaultSettleHours(1),
		timeZone: "UTC",
		now,
	});
	assert.equal(settled.unusual, false);
	assert.equal(settled.early, false);
	const last = settled.series[settled.series.length - 1];
	assert.deepEqual(last, { period: "2026-09-30", value: 2, pending: true });
});

test("a day with no rows yet and no load waits too", () => {
	const decision = decideLoad(
		loads("2026-09-30T06:00:00Z"),
		september.slice(0, 29),
		"2026-09-29",
		1,
		"UTC",
		"2026-10-01",
	);
	assert.deepEqual(dueAfter("2026-09-29", 1, "2026-10-01"), ["2026-09-30"]);
	assert.equal(decision.judged, "2026-09-29");
	assert.equal(decision.waiting?.period, "2026-09-30");
});

test("a load that landed but is far below where it usually is by now is an early signal", () => {
	const now = at("2026-10-01T09:00:00Z");
	const decision = decideLoad(
		loads("2026-10-01T06:10:00Z"),
		september,
		"2026-09-30",
		1,
		"UTC",
		"2026-10-01",
	);
	assert.equal(decision.judged, "2026-09-30");
	assert.equal(decision.waiting, null);

	const learned = learnSettling(history());
	assert.ok(learned);
	assert.equal(learned.settleHours, 30);
	const ageHours = ageOf("2026-09-30", 1, "UTC", now);
	assert.equal(ageHours, 9);
	assert.equal(expectedShare(learned, ageHours), 0.6);

	const early = judgeSettling({
		...base,
		value: 2_000,
		unusual: true,
		ageHours,
		learned,
	});
	assert.equal(early.level, "early");
	assert.equal(early.reason, "belowExpected");
	assert.equal(early.young, true);

	// Where a day usually is by nine hours in is not unusual at all.
	const filling = judgeSettling({
		...base,
		value: 13_000,
		unusual: true,
		ageHours,
		learned,
	});
	assert.equal(filling.level, null);
	assert.equal(filling.reason, "fillingIn");
});

test("the same day is confirmed once it has settled", () => {
	const learned = learnSettling(history());
	const settled = judgeSettling({
		...base,
		value: 2_000,
		unusual: true,
		ageHours: 40,
		learned,
	});
	assert.equal(settled.level, "confirmed");
	assert.equal(settled.reason, "settled");
	assert.equal(settled.young, false);
});

// --- Real problems are judged at once ------------------------------------------

test("a drop one member carries is confirmed at once on a loaded day", () => {
	const spread = evenness(
		new Map([
			["East", 0],
			["West", 7_000],
			["North", 7_000],
		]),
		new Map([
			["East", 7_000],
			["West", 7_000],
			["North", 7_000],
		]),
	);
	assert.equal(spread?.kind, "led");
	assert.equal(spread?.top, "East");
	const learned = learnSettling(history());
	for (const known of [null, learned]) {
		const judged = judgeSettling({
			...base,
			value: 2_000,
			unusual: true,
			ageHours: 9,
			learned: known,
			evenness: spread,
		});
		assert.equal(judged.level, "confirmed");
		assert.equal(judged.reason, "ledByOne");
	}
});

test("a drop spread evenly over every member is an early signal", () => {
	const spread = evenness(
		new Map([
			["East", 700],
			["West", 690],
			["North", 710],
		]),
		new Map([
			["East", 7_000],
			["West", 7_000],
			["North", 7_000],
		]),
	);
	assert.equal(spread?.kind, "even");
	const judged = judgeSettling({
		...base,
		value: 2_100,
		unusual: true,
		ageHours: 9,
		evenness: spread,
	});
	assert.equal(judged.level, "early");
	assert.equal(judged.reason, "evenDrop");
});

test("a spike above usual is confirmed at once", () => {
	const judged = judgeSettling({
		...base,
		value: 40_000,
		unusual: true,
		ageHours: 2,
		landed: false,
		learned: learnSettling(history()),
	});
	assert.equal(judged.level, "confirmed");
	assert.equal(judged.reason, "rose");
});

test("a rate is judged at once, since missing rows can move it either way", () => {
	const judged = judgeSettling({
		...base,
		additive: false,
		usual: 0.42,
		low: 0.38,
		value: 0.1,
		unusual: true,
		ageHours: 2,
		landed: false,
	});
	assert.equal(judged.level, "confirmed");
	assert.equal(judged.reason, "notAdditive");
});

test("only a plain sum or count counts as adding up", () => {
	assert.equal(isAdditiveExpression("SUM(`net_sales`)"), true);
	assert.equal(isAdditiveExpression("count(*)"), true);
	assert.equal(isAdditiveExpression("COUNT(DISTINCT order_id)"), true);
	assert.equal(
		isAdditiveExpression("SUM(CASE WHEN a > 0 THEN 1 ELSE 0 END)"),
		true,
	);
	assert.equal(
		isAdditiveExpression("SUM(amount) FILTER (WHERE status = 'paid')"),
		true,
	);
	assert.equal(isAdditiveExpression("SUM(a) / SUM(b)"), false);
	assert.equal(isAdditiveExpression("AVG(price)"), false);
	assert.equal(isAdditiveExpression("SUM(DISTINCT price)"), false);
	assert.equal(
		isAdditiveExpression("SUM(x) OVER (PARTITION BY region)"),
		false,
	);
	assert.equal(isAdditiveExpression("SUM(')') + 1"), false);
	assert.equal(isAdditiveExpression(null), false);
});

// --- Without history ---------------------------------------------------------

test("with no readings learned the other signals decide", () => {
	assert.equal(learnSettling([]), null);
	// Too few periods, or periods not read long enough after they ended.
	assert.equal(learnSettling(history().filter((o) => o.ageHours < 30)), null);

	const input = { ...base, value: 2_000, unusual: true, ageHours: 9 };
	// The load is known to have landed, and nothing points to a gap.
	assert.deepEqual(
		[judgeSettling(input).level, judgeSettling(input).reason],
		["confirmed", "landed"],
	);
	// Nothing known about the load.
	const unknown = judgeSettling({ ...input, landed: false });
	assert.equal(unknown.level, "early");
	assert.equal(unknown.reason, "noHistory");
	// A move inside the usual range is nothing, young or not.
	assert.equal(
		judgeSettling({ ...input, value: 20_000, unusual: false }).level,
		null,
	);
});

test("a source on a timer falls back to the settling rules", () => {
	const timer: LoadEvidence = { checked: false, tables: [] };
	const decision = decideLoad(
		timer,
		september,
		"2026-09-30",
		1,
		"UTC",
		"2026-10-01",
	);
	assert.deepEqual(decision, {
		judged: "2026-09-30",
		waiting: null,
		known: false,
	});
	const young = judgeSettling({
		...base,
		value: 2,
		unusual: true,
		ageHours: 9,
		landed: decision.known,
	});
	assert.equal(young.level, "early");
	const old = judgeSettling({
		...base,
		value: 2,
		unusual: true,
		ageHours: 30,
		landed: decision.known,
	});
	assert.equal(old.level, "confirmed");
	assert.equal(old.reason, "settled");
});

test("tables that load rarely or irregularly say nothing about a day", () => {
	const weekly = { ...dailyLoad, usualGapMs: 7 * day, usualMinute: null };
	const irregular = { ...dailyLoad, kind: "irregular" as const };
	for (const pattern of [weekly, irregular]) {
		const decision = decideLoad(
			loads("2026-09-20T06:00:00Z", pattern),
			september,
			"2026-09-30",
			1,
			"UTC",
			"2026-10-01",
		);
		assert.equal(decision.known, false);
		assert.equal(decision.judged, "2026-09-30");
	}
});

test("the alert direction and minimum still apply to an early signal", () => {
	const input = { ...base, value: 2_000, unusual: false, ageHours: 9 };
	const learned = learnSettling(history());
	assert.equal(
		judgeSettling({
			...input,
			learned,
			settings: { direction: "up", minimum: null },
		}).level,
		null,
	);
	assert.equal(
		judgeSettling({
			...input,
			learned,
			settings: { direction: "either", minimum: 50_000 },
		}).level,
		null,
	);
});

// --- Time ----------------------------------------------------------------------

test("a period ends at midnight where the reader is", () => {
	assert.equal(
		zoneMidnight("2026-10-01", "America/New_York"),
		at("2026-10-01T04:00:00Z"),
	);
	assert.equal(zoneMidnight("2026-10-01", "UTC"), at("2026-10-01T00:00:00Z"));
	assert.equal(zoneMidnight("2026-10-01", "Not/AZone"), at("2026-10-01"));
});

test("a weekday load expected over a weekend lands on Monday", () => {
	const weekdays = { ...dailyLoad, activeDays: [1, 2, 3, 4, 5] };
	// Saturday 3 October 2026 at midnight.
	assert.equal(
		nextLoadAfter(weekdays, at("2026-10-03T00:00:00Z"), null),
		at("2026-10-05T06:00:00Z"),
	);
	assert.equal(
		nextLoadAfter(
			{ ...dailyLoad, stream: true },
			at("2026-10-03T00:00:00Z"),
			null,
		),
		null,
	);
});

test("readings are kept by the hour while young and by the day after", () => {
	const t = at("2026-10-01T09:35:00Z");
	assert.equal(observedBucket(t, 9), at("2026-10-01T09:00:00Z"));
	assert.equal(observedBucket(t, 72), at("2026-10-01T00:00:00Z"));
});

// --- Across the briefing -------------------------------------------------------

function youngCard(id: string, reason: "landed" | "ledByOne"): Card {
	return {
		id,
		period: "2026-09-30",
		spacing: 1,
		value: 100,
		usual: 1_000,
		low: 900,
		high: 1_100,
		unusual: true,
		early: false,
		settling: {
			level: "confirmed",
			reason,
			ageHours: 9,
			young: true,
			additive: true,
			expectedShare: null,
			settleHours: null,
		},
		waiting: null,
		againstUsual: -0.9,
		previousPeriod: null,
		previous: null,
		series: [],
		driver: null,
		window: { gte: "2026-09-30", lt: "2026-10-01" },
		previousWindow: null,
		weight: 19,
	};
}

test("every figure on a dataset falling together reads as data still loading", () => {
	const entries = [
		{ sourceKey: "sales", card: youngCard("a", "landed") },
		{ sourceKey: "sales", card: youngCard("b", "ledByOne") },
		{ sourceKey: "other", card: youngCard("c", "landed") },
	];
	const judged = alongside(entries);
	assert.equal(judged[0].card.early, true);
	assert.equal(judged[0].card.unusual, false);
	assert.equal(judged[0].card.settling?.reason, "together");
	// One part carries it, so it stays confirmed.
	assert.equal(judged[1].card.unusual, true);
	// Alone on its dataset.
	assert.equal(judged[2].card.unusual, true);
	assert.equal(
		settlingText(judged[0].card),
		"Early signal. Every figure on this dataset fell together, which is how data still loading looks.",
	);
});

test("the headline counts confirmed figures and mentions early ones softly", () => {
	assert.equal(
		headline({
			unusual: 1,
			early: 2,
			moving: 0,
			late: 0,
			fired: 0,
			reading: false,
		}),
		"One figure is outside its usual range. 2 figures look low but may still be loading",
	);
	assert.equal(
		headline({
			unusual: 0,
			early: 1,
			moving: 3,
			late: 0,
			fired: 0,
			reading: false,
		}),
		"Nothing unusual so far. One figure looks low but may still be loading",
	);
});

// --- Alerts ------------------------------------------------------------------------

const unusualRule = (earlySignals: boolean) => ({
	condition: "unusual" as const,
	threshold: null,
	notifyRecover: false,
	anomaly: {
		timeField: "day",
		compareTo: "same_weekday" as const,
		periods: 8,
		sensitivity: "medium" as const,
		percent: null,
		direction: "either" as const,
		minimum: null,
		earlySignals,
	},
});

function reading(period: string, level: "confirmed" | "early"): Reading {
	return {
		group: null,
		value: 2_000,
		period,
		usual: 21_000,
		low: 18_900,
		high: 23_100,
		unusual: level === "confirmed",
		early: level === "early",
		reason: level === "early" ? "belowExpected" : "settled",
		ageHours: 9,
	};
}

test("an early signal is held back, then sent once it is confirmed", () => {
	const rule = unusualRule(false);
	const first = evaluate(rule, [reading("2026-09-30", "early")], {});
	assert.equal(first.firings.length, 0);
	assert.deepEqual(first.state[""].pending, ["2026-09-30"]);

	// The next day's check judges the 30th again, then the 1st.
	const second = evaluate(
		rule,
		[
			{ ...reading("2026-09-30", "confirmed"), again: true },
			{ ...reading("2026-10-01", "early"), value: 20_000, early: false },
		],
		first.state,
	);
	assert.equal(second.firings.length, 1);
	assert.equal(second.firings[0].period, "2026-09-30");
	assert.equal(second.firings[0].again, true);
	assert.equal(second.state[""].period, "2026-09-30");
	assert.equal(second.state[""].pending, undefined);
	assert.equal(second.state[""].value, 20_000);
	assert.equal(
		settlingNote({ groupBy: null }, second.firings[0]),
		"Confirmed now that more of its data has arrived.",
	);
});

test("an early signal sent is not sent again when it is confirmed", () => {
	const rule = unusualRule(true);
	const first = evaluate(rule, [reading("2026-09-30", "early")], {});
	assert.equal(first.firings.length, 1);
	assert.equal(first.firings[0].early, true);
	assert.equal(
		settlingNote({ groupBy: null }, first.firings[0]),
		"Early signal. It is far below where it usually is by now. Data may still be loading.",
	);
	const later = evaluate(
		rule,
		[reading("2026-09-30", "confirmed")],
		first.state,
	);
	assert.equal(later.firings.length, 0);
});

test("an early signal that clears is let go", () => {
	const rule = unusualRule(false);
	const first = evaluate(rule, [reading("2026-09-30", "early")], {});
	const cleared: Reading = {
		...reading("2026-09-30", "early"),
		early: false,
		value: 21_000,
		again: true,
	};
	const second = evaluate(
		rule,
		[cleared, reading("2026-10-01", "confirmed")],
		first.state,
	);
	assert.deepEqual(
		second.firings.map((f) => f.period),
		["2026-10-01"],
	);
	assert.equal(second.state[""].pending, undefined);
});
