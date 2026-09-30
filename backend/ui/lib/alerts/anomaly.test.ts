import assert from "node:assert/strict";
import { test } from "node:test";
import {
	baselineKeys,
	cleanAnomaly,
	defaultAnomaly,
	describeComparison,
	periodEnd,
	readAnomalies,
	spacingDays,
	targetPeriod,
	usualBand,
	windowStart,
} from "./anomaly";
import {
	AlertDefinitionError,
	cleanDefinition,
	describeFirings,
	describeRule,
	evaluate,
} from "./rule";

const day = 24 * 60 * 60 * 1000;

function key(t: number): string {
	return new Date(t).toISOString().slice(0, 10);
}

// 2026-09-28 was a Monday.
const monday = Date.UTC(2026, 8, 28);

// Daily rows for two regions over ten weeks, with Mondays busier than other
// days, and one last Monday to judge.
function rows(lastMondayEurope: number): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (let d = 70; d >= 1; d--) {
		const t = monday - d * day;
		const weekday = new Date(t).getUTCDay();
		const base = weekday === 1 ? 250 : 100;
		out.push({
			"Order Date": key(t),
			Region: "Europe",
			Revenue: base + (d % 3) * 4,
		});
		out.push({
			"Order Date": key(t),
			Region: "Asia",
			Revenue: base / 2 + (d % 2) * 3,
		});
	}
	out.push({
		"Order Date": key(monday),
		Region: "Europe",
		Revenue: lastMondayEurope,
	});
	out.push({ "Order Date": key(monday), Region: "Asia", Revenue: 126 });
	return out;
}

test("the period judged is the latest that has finished, never today", () => {
	const keys = [key(monday - day), key(monday), key(monday + day)];
	assert.equal(spacingDays(keys), 1);
	// On the Tuesday, Monday is the latest finished day.
	assert.equal(targetPeriod(keys, 1, key(monday + day)), key(monday));

	const months = ["2026-07-01", "2026-08-01", "2026-09-01"];
	assert.equal(spacingDays(months), 31);
	// Mid September, August is the latest finished month.
	assert.equal(targetPeriod(months, 31, "2026-09-15"), "2026-08-01");
});

test("a month is finished when the next one begins, whatever its length", () => {
	// Months learned as thirty days apart, where September and November
	// have thirty days and October thirty-one.
	const months = ["2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"];
	assert.equal(spacingDays(months), 30);
	// On the last day of December, December is still filling up.
	assert.equal(targetPeriod(months, 30, "2026-12-31"), "2026-11-01");
	assert.equal(targetPeriod(months, 30, "2027-01-01"), "2026-12-01");
	// A month starting on a day a shorter month lacks ends on its last day.
	assert.equal(periodEnd("2026-01-31", 31), Date.UTC(2026, 1, 28));
	// A quarter is three months.
	assert.equal(periodEnd("2026-01-01", 90), Date.UTC(2026, 3, 1));
	// A week is still counted in days.
	assert.equal(periodEnd("2026-01-01", 7), Date.UTC(2026, 0, 8));
});

test("the same weekday is compared with the same weekday, and a monthly field with the months before", () => {
	const settings = defaultAnomaly("Order Date");
	const available = Array.from({ length: 70 }, (_, i) =>
		key(monday - i * day),
	);
	const keys = baselineKeys(key(monday), available, settings, 1);
	assert.equal(keys.length, 8);
	for (const k of keys) {
		assert.equal(new Date(`${k}T00:00:00Z`).getUTCDay(), 1);
	}
	assert.equal(windowStart(settings, 1, key(monday)), key(monday - 56 * day));

	const months = [
		"2026-03-01",
		"2026-04-01",
		"2026-05-01",
		"2026-06-01",
		"2026-07-01",
	];
	assert.deepEqual(baselineKeys("2026-07-01", months, settings, 30), [
		"2026-03-01",
		"2026-04-01",
		"2026-05-01",
		"2026-06-01",
	]);
});

test("usual is the middle of the history, and a steady figure still needs a real move", () => {
	const medium = defaultAnomaly("d");
	const band = usualBand([100, 102, 98, 101, 99, 100, 250], medium);
	assert.ok(band);
	// One odd week does not drag usual up the way an average would.
	assert.equal(band?.usual, 100);

	// A figure never below zero is never usually below zero either.
	const noisy = usualBand([0, 5, 100, 0, 3], medium);
	assert.equal(noisy?.low, 0);

	const flat = usualBand([100, 100, 100, 100], medium);
	// No movement at all still leaves a tenth either side at medium.
	assert.equal(flat?.low, 90);
	assert.equal(flat?.high, 110);

	assert.equal(usualBand([100, 100], medium), null);

	const percent = cleanAnomaly({
		timeField: "d",
		sensitivity: "percent",
		percent: 20,
	});
	const wide = usualBand([100, 100, 100], percent);
	assert.equal(wide?.low, 80);
	assert.equal(wide?.high, 120);
});

test("a drop on a Monday is unusual against Mondays, and the other region is not", () => {
	const settings = defaultAnomaly("Order Date");
	const tuesday = key(monday + day);
	const read = readAnomalies(rows(150), {
		timeField: "Order Date",
		groupBy: "Region",
		measure: "Revenue",
		settings,
		today: tuesday,
	});
	assert.equal(read.period, key(monday));
	const europe = read.readings.find((r) => r.group === "Europe");
	const asia = read.readings.find((r) => r.group === "Asia");
	assert.equal(europe?.unusual, true);
	assert.equal(asia?.unusual, false);
	// Compared with Mondays, not with the quieter weekdays around it.
	assert.ok((europe?.usual ?? 0) > 240);
	// The unusual one is listed first.
	assert.equal(read.readings[0].group, "Europe");

	const normal = readAnomalies(rows(252), {
		timeField: "Order Date",
		groupBy: "Region",
		measure: "Revenue",
		settings,
		today: tuesday,
	});
	assert.equal(
		normal.readings.some((r) => r.unusual),
		false,
	);
});

test("direction and a minimum size narrow what is reported", () => {
	const tuesday = key(monday + day);
	const upOnly = cleanAnomaly({ timeField: "Order Date", direction: "up" });
	const read = readAnomalies(rows(150), {
		timeField: "Order Date",
		groupBy: "Region",
		measure: "Revenue",
		settings: upOnly,
		today: tuesday,
	});
	assert.equal(
		read.readings.some((r) => r.unusual),
		false,
	);

	const small = cleanAnomaly({ timeField: "Order Date", minimum: 1000 });
	const ignored = readAnomalies(rows(150), {
		timeField: "Order Date",
		groupBy: "Region",
		measure: "Revenue",
		settings: small,
		today: tuesday,
	});
	assert.equal(
		ignored.readings.some((r) => r.unusual),
		false,
	);
});

test("an unusual alert needs its date field, and names itself after the rule", () => {
	assert.throws(
		() =>
			cleanDefinition({
				sourceKey: "s",
				measure: "Revenue",
				condition: "unusual",
			}),
		AlertDefinitionError,
	);
	const definition = cleanDefinition({
		sourceKey: "s",
		measure: "Revenue",
		groupBy: "Region",
		condition: "unusual",
		anomaly: { timeField: "Order Date" },
	});
	assert.equal(definition.threshold, null);
	assert.equal(definition.anomaly?.compareTo, "same_weekday");
	assert.equal(definition.name, "Revenue is unusual");
	assert.match(
		describeRule({
			measure: "Revenue",
			groupBy: "Region",
			condition: "unusual",
			threshold: null,
			format: String,
			anomaly: definition.anomaly,
		}),
		/^Revenue for any Region is unusual, against the same weekday over the last 8 weeks, clear swings$/,
	);
	assert.match(
		describeComparison(
			cleanAnomaly({
				timeField: "d",
				compareTo: "recent",
				periods: 14,
				sensitivity: "low",
				direction: "down",
			}),
		),
		/the 14 periods before, only big swings, downward only/,
	);
});

test("an unusual period is reported once however often it is checked", () => {
	const definition = {
		condition: "unusual" as const,
		threshold: null,
		notifyRecover: false,
	};
	const reading = {
		group: "Europe",
		value: 150,
		period: "2026-09-28",
		usual: 250,
		low: 225,
		high: 275,
		unusual: true,
	};
	const first = evaluate(definition, [reading], {});
	assert.equal(first.firings.length, 1);
	const again = evaluate(definition, [reading], first.state);
	assert.equal(again.firings.length, 0);
	const nextDay = evaluate(
		definition,
		[{ ...reading, period: "2026-09-29" }],
		again.state,
	);
	assert.equal(nextDay.firings.length, 1);

	const message = describeFirings(
		"Revenue watch",
		{
			measure: "Revenue",
			groupBy: "Region",
			condition: "unusual",
			threshold: null,
			format: (v) => (v === null ? "" : `$${v}`),
		},
		first.firings,
	);
	assert.equal(
		message?.body,
		"Europe: Revenue was $150 on Mon 28 Sep, usually $225 to $275 (-40%)",
	);
});
