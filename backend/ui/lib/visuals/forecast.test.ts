import assert from "node:assert/strict";
import { test } from "node:test";
import {
	defaultHorizon,
	describeForecast,
	forecastRows,
	forecastSeries,
	inferSpacing,
	isFinished,
	looksAdditive,
	maxHorizonByUnit,
	periodKey,
	placeForecast,
	shiftPeriod,
} from "./forecast";

// A repeatable wobble, so the synthetic series are noisy the same way on
// every run.
function noise(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648 - 0.5;
	};
}

function monthStarts(from: string, count: number): string[] {
	const spacing = { unit: "month" as const, monthEnd: false };
	return Array.from({ length: count }, (_, i) =>
		shiftPeriod(from, spacing, i),
	);
}

// --- Periods -----------------------------------------------------------------

test("periods are read as plain dates and times of day are refused", () => {
	assert.equal(periodKey("2026-03-01"), "2026-03-01");
	assert.equal(periodKey("2026-03-01T00:00:00.000Z"), "2026-03-01");
	assert.equal(periodKey("2026-03-01 00:00:00"), "2026-03-01");
	assert.equal(periodKey("2026-03-01T13:00:00"), null);
	assert.equal(periodKey("2026-02-30"), null);
	assert.equal(periodKey("North"), null);
	assert.equal(periodKey(null), null);
});

test("spacing is inferred from the typical gap", () => {
	assert.deepEqual(inferSpacing(["2026-01-01", "2026-01-02", "2026-01-03"]), {
		unit: "day",
		monthEnd: false,
	});
	assert.equal(
		inferSpacing(["2026-01-05", "2026-01-12", "2026-01-19"])?.unit,
		"week",
	);
	assert.equal(
		inferSpacing(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"])
			?.unit,
		"month",
	);
	assert.equal(
		inferSpacing(["2025-01-01", "2025-04-01", "2025-07-01", "2025-10-01"])
			?.unit,
		"quarter",
	);
	assert.equal(
		inferSpacing(["2023-01-01", "2024-01-01", "2025-01-01"])?.unit,
		"year",
	);
	// One missing month does not turn the series into something else.
	assert.equal(
		inferSpacing(["2026-01-01", "2026-02-01", "2026-04-01", "2026-05-01"])
			?.unit,
		"month",
	);
	assert.equal(
		inferSpacing(["2026-01-01", "2026-01-04", "2026-01-07"]),
		null,
	);
	assert.equal(inferSpacing(["2026-01-01"]), null);
});

test("month ends stay on month ends, including leap years", () => {
	const spacing = inferSpacing(["2027-11-30", "2027-12-31", "2028-01-31"]);
	assert.deepEqual(spacing, { unit: "month", monthEnd: true });
	if (!spacing) return;
	assert.equal(shiftPeriod("2028-01-31", spacing, 1), "2028-02-29");
	assert.equal(shiftPeriod("2028-01-31", spacing, 2), "2028-03-31");
	assert.equal(shiftPeriod("2028-01-31", spacing, 3), "2028-04-30");
	assert.equal(shiftPeriod("2027-01-31", spacing, 1), "2027-02-28");
	assert.equal(shiftPeriod("2028-02-29", spacing, 1), "2028-03-31");
});

test("a fixed day of the month is clamped rather than rolled over", () => {
	const spacing = { unit: "month" as const, monthEnd: false };
	assert.equal(shiftPeriod("2026-01-31", spacing, 1), "2026-02-28");
	assert.equal(shiftPeriod("2026-01-31", spacing, 2), "2026-03-31");
	assert.equal(shiftPeriod("2026-11-15", spacing, 3), "2027-02-15");
	// Dates on the 28th are not month ends, even when February's is.
	assert.equal(
		inferSpacing(["2026-01-28", "2026-02-28", "2026-03-28"])?.monthEnd,
		false,
	);
});

test("quarters, years and weeks step on the calendar", () => {
	const quarter = { unit: "quarter" as const, monthEnd: false };
	assert.equal(shiftPeriod("2026-01-01", quarter, 1), "2026-04-01");
	assert.equal(shiftPeriod("2026-10-01", quarter, 1), "2027-01-01");
	assert.equal(shiftPeriod("2026-10-01", quarter, 5), "2028-01-01");
	const year = { unit: "year" as const, monthEnd: false };
	assert.equal(shiftPeriod("2024-02-29", year, 1), "2025-02-28");
	assert.equal(shiftPeriod("2024-02-29", year, 4), "2028-02-29");
	const week = { unit: "week" as const, monthEnd: false };
	assert.equal(shiftPeriod("2026-12-28", week, 1), "2027-01-04");
	const day = { unit: "day" as const, monthEnd: false };
	assert.equal(shiftPeriod("2028-02-28", day, 1), "2028-02-29");
});

test("a period is finished once the next one has started", () => {
	const month = { unit: "month" as const, monthEnd: false };
	assert.equal(isFinished("2026-08-01", month, "2026-09-29"), true);
	assert.equal(isFinished("2026-09-01", month, "2026-09-29"), false);
	assert.equal(isFinished("2026-09-01", month, "2026-10-01"), true);
});

test("the default horizon covers a season where the history allows", () => {
	assert.equal(defaultHorizon("day", 760), 90);
	assert.equal(defaultHorizon("day", 200), 40);
	assert.equal(defaultHorizon("week", 120), 13);
	assert.equal(defaultHorizon("month", 24), 12);
	assert.equal(defaultHorizon("month", 18), 6);
	assert.equal(defaultHorizon("quarter", 12), 4);
	assert.equal(defaultHorizon("year", 2), 1);
	// Never more periods than the chart shows.
	assert.equal(defaultHorizon("week", 9), 9);
	assert.ok(defaultHorizon("day", 100_000) <= maxHorizonByUnit.day);
});

test("measures are read as totals or averages from their names", () => {
	assert.equal(looksAdditive("Revenue", "currency"), true);
	assert.equal(looksAdditive("Orders", null), true);
	assert.equal(looksAdditive("Average Headcount", "integer"), false);
	assert.equal(looksAdditive("Attrition Pct", "percent"), false);
	assert.equal(looksAdditive("conversionRate", null), false);
	assert.equal(looksAdditive("Engagement Score", "decimal"), false);
	// Unsure means an average.
	assert.equal(looksAdditive("Temperature", "decimal"), false);
});

// --- Rows --------------------------------------------------------------------

test("an unfinished last period is left out of the fit and forecast", () => {
	const periods = monthStarts("2025-01-01", 21);
	const rows = periods.map((p, i) => ({
		month: p,
		// The last month is only partly in, so its total is low.
		sales: i === periods.length - 1 ? 5 : 100 + i * 2,
	}));
	const result = forecastRows(rows, "month", ["sales"], {
		horizon: 3,
		today: "2026-09-15",
	});
	assert.ok(result);
	assert.equal(result.anchorPeriod, "2026-08-01");
	assert.deepEqual(result.periods, [
		"2026-09-01",
		"2026-10-01",
		"2026-11-01",
		"2026-12-01",
	]);
	assert.equal(result.horizon, 3);
	const [series] = result.series;
	assert.equal(series.anchor, 138);
	// A partial month in the fit would pull the next value well under the
	// last full one.
	assert.ok(series.values[0] > 130);
});

test("forecast periods land on the chart's categories and extend them", () => {
	const periods = monthStarts("2025-01-01", 21);
	const rows = periods.map((p, i) => ({ month: p, sales: 100 + i }));
	const result = forecastRows(rows, "month", ["sales"], {
		horizon: 2,
		today: "2026-09-15",
	});
	assert.ok(result);
	const categories = periods.map((p) => `${p}T00:00:00`);
	const placed = placeForecast(categories, result);
	assert.ok(placed);
	assert.equal(placed.anchorIndex, 19);
	assert.deepEqual(placed.indices, [20, 21, 22]);
	assert.deepEqual(placed.appended, [
		"2026-10-01T00:00:00",
		"2026-11-01T00:00:00",
	]);
	// Categories out of date order, such as bars sorted by value, are not
	// somewhere a forecast can continue from.
	assert.equal(placeForecast([...categories].reverse(), result), null);
});

test("duplicate dates, too many measures and short series give nothing", () => {
	const periods = monthStarts("2024-01-01", 20);
	const doubled = periods.flatMap((p) => [
		{ month: p, region: "North", sales: 1 },
		{ month: p, region: "South", sales: 2 },
	]);
	const opts = { horizon: 3, today: "2026-09-15" };
	assert.equal(forecastRows(doubled, "month", ["sales"], opts), null);

	const wide = periods.map((p) => ({
		month: p,
		a: 1,
		b: 2,
		c: 3,
		d: 4,
		e: 5,
		f: 6,
		g: 7,
	}));
	assert.equal(
		forecastRows(wide, "month", ["a", "b", "c", "d", "e", "f", "g"], opts),
		null,
	);

	const short = periods.slice(0, 7).map((p, i) => ({ month: p, sales: i }));
	assert.equal(forecastRows(short, "month", ["sales"], opts), null);
	assert.equal(forecastRows([], "month", ["sales"], opts), null);
	assert.equal(
		forecastRows(
			[{ month: "not a date", sales: 1 }],
			"month",
			["sales"],
			opts,
		),
		null,
	);
});

test("values that are not numbers are treated as gaps", () => {
	const periods = monthStarts("2024-01-01", 20);
	const rows = periods.map((p, i) => ({
		month: p,
		sales: i === 5 ? null : i === 9 ? "n/a" : String(50 + i),
	}));
	const result = forecastRows(rows, "month", ["sales"], {
		horizon: 3,
		today: "2026-09-15",
	});
	assert.ok(result);
	for (const value of result.series[0].values) {
		assert.ok(Number.isFinite(value));
	}
});

// --- Models ------------------------------------------------------------------

test("a clearly seasonal series keeps its yearly shape", () => {
	const wobble = noise(7);
	const values = Array.from(
		{ length: 48 },
		(_, t) =>
			200 +
			1.5 * t +
			40 * Math.sin((2 * Math.PI * t) / 12) +
			3 * wobble(),
	);
	const fit = forecastSeries(values, "month", 12);
	assert.ok(fit);
	assert.ok(
		fit.model === "holtWinters" || fit.model === "seasonalRegression",
		fit.model,
	);
	// The forecast keeps the shape, peaking a quarter of the way into the
	// next cycle rather than running flat.
	const peak = fit.values.indexOf(Math.max(...fit.values));
	assert.ok(peak >= 1 && peak <= 5, `peak at ${peak}`);
	assert.ok(fit.typicalError !== null && fit.typicalError < 0.1);
});

test("a monthly trend keeps its slope rather than flattening", () => {
	const wobble = noise(11);
	const values = Array.from(
		{ length: 36 },
		(_, t) => 50 + 4 * t + 2 * wobble(),
	);
	const fit = forecastSeries(values, "month", 12);
	assert.ok(fit);
	assert.equal(fit.trend, "up");
	assert.ok(fit.values[0] > values[35]);
	const slope = (fit.values[11] - fit.values[0]) / 11;
	assert.ok(Math.abs(slope - 4) <= 0.8, `slope ${slope}`);
});

test("the band widens with the horizon", () => {
	const wobble = noise(3);
	const values = Array.from(
		{ length: 40 },
		(_, t) => 500 + 5 * t + 30 * wobble(),
	);
	const fit = forecastSeries(values, "quarter", 8);
	assert.ok(fit);
	const widths = fit.upper.map((u, i) => u - fit.lower[i]);
	for (let i = 1; i < widths.length; i++) {
		assert.ok(widths[i] >= widths[i - 1] - 1e-9);
	}
	assert.ok(widths[widths.length - 1] > widths[0]);
	for (let i = 0; i < fit.values.length; i++) {
		assert.ok(
			fit.lower[i] <= fit.values[i] && fit.values[i] <= fit.upper[i],
		);
	}
});

test("a history that never goes below zero is never forecast below it", () => {
	const wobble = noise(5);
	const values = Array.from({ length: 24 }, (_, t) =>
		Math.max(0, 60 - 3 * t + 8 * wobble()),
	);
	const fit = forecastSeries(values, "month", 12);
	assert.ok(fit);
	for (let i = 0; i < fit.values.length; i++) {
		assert.ok(fit.values[i] >= 0);
		assert.ok(fit.lower[i] >= 0);
	}
});

test("constant and all zero series give a flat forecast with no band", () => {
	for (const level of [0, 42]) {
		const fit = forecastSeries(new Array(12).fill(level), "month", 4);
		assert.ok(fit);
		assert.equal(fit.model, "flat");
		assert.deepEqual(fit.values, [level, level, level, level]);
		assert.deepEqual(fit.lower, fit.upper);
		assert.equal(fit.typicalError, null);
	}
});

test("fewer than the minimum finished points gives nothing", () => {
	assert.equal(forecastSeries([1, 2, 3, 4, 5, 6, 7], "month", 3), null);
	// Mostly gaps is not a history either.
	assert.equal(
		forecastSeries(
			[
				1,
				null,
				null,
				2,
				null,
				null,
				3,
				null,
				null,
				4,
				5,
				6,
				7,
				8,
				null,
				null,
				null,
				null,
			],
			"month",
			3,
		),
		null,
	);
});

test("Holt-Winters needs two full seasons of history", () => {
	const values = Array.from(
		{ length: 20 },
		(_, t) => 100 + 30 * Math.sin((2 * Math.PI * t) / 12),
	);
	const fit = forecastSeries(values, "month", 3);
	assert.ok(fit);
	assert.notEqual(fit.model, "holtWinters");
});

test("percentages near zero leave the accuracy note off", () => {
	const wobble = noise(9);
	const values = Array.from({ length: 30 }, (_, t) =>
		t % 2 === 0 ? 0 : 5 + wobble(),
	);
	const fit = forecastSeries(values, "day", 5);
	assert.ok(fit);
	assert.equal(fit.typicalError, null);
});

test("the caption names the horizon, the pattern and the typical error", () => {
	const wobble = noise(7);
	const periods = monthStarts("2022-01-01", 48);
	const rows = periods.map((p, t) => ({
		month: p,
		sales:
			200 +
			1.5 * t +
			40 * Math.sin((2 * Math.PI * t) / 12) +
			3 * wobble(),
	}));
	const result = forecastRows(rows, "month", ["sales"], {
		horizon: 6,
		today: "2026-09-15",
	});
	assert.ok(result);
	assert.match(
		describeForecast(result),
		/^Forecast 6 months ahead from (the growth trend and yearly pattern \(busiest [A-Z][a-z]{2}( to [A-Z][a-z]{2})?\)|the recent trend and yearly pattern), typically within ±\d+% for the period total\.$/,
	);
	const flat = forecastRows(
		periods.map((p) => ({ month: p, sales: 3 })),
		"month",
		["sales"],
		{ horizon: 1, today: "2026-09-15" },
	);
	assert.ok(flat);
	assert.equal(
		describeForecast(flat),
		"Forecast 1 month ahead by holding the last value.",
	);
});

// --- Daily history with growth and a yearly shape ------------------------------

// Two years of daily figures shaped like the demo's orders. Steady growth,
// busier in November and December and a little busier from May to July, with
// heavy day to day noise and no weekday effect.
function demoDays(until: string): { day: string; revenue: number }[] {
	const spacing = { unit: "day" as const, monthEnd: false };
	const start = "2024-09-01";
	const wobble = noise(21);
	const out: { day: string; revenue: number }[] = [];
	for (let i = 0; ; i++) {
		const day = shiftPeriod(start, spacing, i);
		if (day > until) break;
		const month = Number(day.slice(5, 7));
		const season = month >= 11 ? 1.4 : month >= 5 && month <= 7 ? 1.15 : 1;
		const growth = 1 + 0.35 * (i / 730);
		out.push({
			day,
			revenue: 1000 * growth * season * (1 + 0.8 * wobble()),
		});
	}
	return out;
}

function average(values: number[]): number {
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

test("daily history is forecast with its growth and busy season", () => {
	const rows = demoDays("2026-09-29");
	const result = forecastRows(rows, "day", ["revenue"], {
		today: "2026-09-29",
	});
	assert.ok(result);
	assert.equal(result.horizon, 90);
	const [series] = result.series;
	assert.equal(series.model, "seasonalRegression");
	assert.equal(series.trend, "up");
	assert.deepEqual(series.yearlyPeak, [10, 11]);

	const ahead = (prefix: string) =>
		average(
			series.values.filter((_, i) =>
				result.periods[i].startsWith(prefix),
			),
		);
	const october = ahead("2026-10");
	const busy = average([ahead("2026-11"), ahead("2026-12")]);
	assert.ok(busy >= 1.25 * october, `busy ${busy} against ${october}`);

	const lastYear = average(
		rows
			.filter((r) => r.day >= "2025-11-01" && r.day <= "2025-12-31")
			.map((r) => r.revenue),
	);
	assert.ok(busy > lastYear, `busy ${busy} against last year ${lastYear}`);

	assert.match(
		describeForecast(result),
		/^Forecast 90 days ahead from the growth trend and yearly pattern \(busiest Nov to Dec\), typically within ±\d+% for the period total\.$/,
	);
	// Judged on the total, which daily noise barely moves.
	assert.ok(series.totalError !== null && series.totalError < 0.15);
	assert.ok(
		series.typicalError !== null && series.typicalError > series.totalError,
	);
});

test("the forecast continues from the last finished period", () => {
	const periods = monthStarts("2024-10-01", 24);
	const rows = periods.map((p, i) => ({
		month: p,
		headcount: i === periods.length - 1 ? 40 : 800 + 6 * i,
	}));
	const result = forecastRows(rows, "month", ["headcount"], {
		today: "2026-09-29",
	});
	assert.ok(result);
	assert.equal(result.anchorPeriod, "2026-08-01");
	// The unfinished month is forecast too, before the twelve months ahead.
	assert.equal(result.periods[0], "2026-09-01");
	assert.equal(result.periods.length, 13);
	assert.equal(result.horizon, 12);
	const [series] = result.series;
	assert.equal(series.anchor, 800 + 6 * 22);
	// No step between the last value and the first forecast, and the trend
	// carries on at its own pace.
	assert.ok(Math.abs(series.values[0] - (series.anchor + 6)) < 1.5);
	const slope = (series.values[12] - series.values[0]) / 12;
	assert.ok(Math.abs(slope - 6) <= 1.2, `slope ${slope}`);
});

test("the range never narrows further out", () => {
	const wobble = noise(13);
	const values = Array.from(
		{ length: 30 },
		(_, t) => 300 + 5 * t + 20 * wobble(),
	);
	const fit = forecastSeries(values, "month", 12);
	assert.ok(fit);
	const widths = fit.upper.map((u, i) => u - fit.lower[i]);
	for (let i = 1; i < widths.length; i++) {
		assert.ok(widths[i] >= widths[i - 1] - 1e-9);
	}
	assert.ok(widths[0] > 0);
});

test("two years of daily points are forecast quickly", () => {
	const rows = demoDays("2026-11-10");
	assert.ok(rows.length >= 800);
	const started = performance.now();
	const result = forecastRows(rows, "day", ["revenue"], {
		today: "2026-11-11",
	});
	const took = performance.now() - started;
	assert.ok(result);
	assert.ok(took < 300, `took ${took} ms`);
});
