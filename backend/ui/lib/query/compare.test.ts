import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeChange, shiftDateFilters, type DateClause } from "./compare";

const window = (from: string, to: string): DateClause[] => [
	{ field: "Order Date", op: "gte", value: from },
	{ field: "Order Date", op: "lte", value: to },
];

test("a year earlier moves both ends back twelve months", () => {
	const shifted = shiftDateFilters(
		window("2026-03-01", "2026-03-31"),
		"Order Date",
		"year",
	);
	assert.deepEqual(shifted, window("2025-03-01", "2025-03-31"));
});

test("a quarter earlier moves back three months", () => {
	const shifted = shiftDateFilters(
		window("2026-07-01", "2026-09-30"),
		"Order Date",
		"quarter",
	);
	assert.deepEqual(shifted, window("2026-04-01", "2026-06-30"));
});

test("the period before is the window immediately preceding it", () => {
	// Thirty one days in March, so the window before it ends the day before it
	// starts and is the same length.
	const shifted = shiftDateFilters(
		window("2026-03-01", "2026-03-31"),
		"Order Date",
		"previous",
	);
	assert.deepEqual(shifted, window("2026-01-29", "2026-02-28"));
});

test("the period before counts no day twice and skips none", () => {
	const shifted = shiftDateFilters(
		window("2026-03-10", "2026-03-19"),
		"Order Date",
		"previous",
	)!;
	// Ten days, so the earlier window ends the day before the current starts.
	assert.equal(shifted[0].value, "2026-02-28");
	assert.equal(shifted[1].value, "2026-03-09");
});

test("a month back from the 31st lands on the last day of a shorter month", () => {
	const shifted = shiftDateFilters(
		window("2026-03-31", "2026-03-31"),
		"Order Date",
		"month",
	);
	// Not the 3rd of March, which is where rolling forward would put it.
	assert.equal(shifted?.[0].value, "2026-02-28");
});

test("a year back from a leap day lands on the last day of February", () => {
	const shifted = shiftDateFilters(
		window("2028-02-29", "2028-02-29"),
		"Order Date",
		"year",
	);
	assert.equal(shifted?.[0].value, "2027-02-28");
});

test("a shift crossing a year boundary moves the year too", () => {
	const shifted = shiftDateFilters(
		window("2026-01-15", "2026-01-31"),
		"Order Date",
		"quarter",
	);
	assert.equal(shifted?.[0].value, "2025-10-15");
	assert.equal(shifted?.[1].value, "2025-10-31");
});

test("filters on other fields are carried across untouched", () => {
	const filters: DateClause[] = [
		{ field: "Region", op: "eq", value: "EMEA" },
		...window("2026-03-01", "2026-03-31"),
	];
	const shifted = shiftDateFilters(filters, "Order Date", "year")!;
	assert.deepEqual(shifted[0], { field: "Region", op: "eq", value: "EMEA" });
	assert.equal(shifted.length, 3);
});

test("no date window means there is nothing to compare against", () => {
	assert.equal(
		shiftDateFilters(
			[{ field: "Region", op: "eq", value: "EMEA" }],
			"Order Date",
			"year",
		),
		null,
	);
});

test("an open ended window can be shifted by a fixed period", () => {
	const shifted = shiftDateFilters(
		[{ field: "Order Date", op: "gte", value: "2026-01-01" }],
		"Order Date",
		"year",
	);
	assert.equal(shifted?.[0].value, "2025-01-01");
});

test("an open ended window has no length, so the period before is refused", () => {
	assert.equal(
		shiftDateFilters(
			[{ field: "Order Date", op: "gte", value: "2026-01-01" }],
			"Order Date",
			"previous",
		),
		null,
	);
});

test("a value that is not a date is refused rather than guessed at", () => {
	assert.equal(
		shiftDateFilters(
			[{ field: "Order Date", op: "gte", value: "last tuesday" }],
			"Order Date",
			"year",
		),
		null,
	);
});

test("a date the calendar does not have is refused", () => {
	assert.equal(
		shiftDateFilters(
			[{ field: "Order Date", op: "gte", value: "2026-04-31" }],
			"Order Date",
			"year",
		),
		null,
	);
});

test("a window whose end precedes its start is refused", () => {
	assert.equal(
		shiftDateFilters(
			window("2026-03-31", "2026-03-01"),
			"Order Date",
			"previous",
		),
		null,
	);
});

test("a timestamp is shifted by its date part", () => {
	const shifted = shiftDateFilters(
		[{ field: "Order Date", op: "gte", value: "2026-03-01T09:30:00Z" }],
		"Order Date",
		"year",
	);
	assert.equal(shifted?.[0].value, "2025-03-01");
});

// --- Relative change -------------------------------------------------------

test("change is reported as a fraction of the earlier figure", () => {
	assert.equal(relativeChange(120, 100), 0.2);
	assert.equal(relativeChange(80, 100), -0.2);
});

test("growth from zero is not a percentage", () => {
	assert.equal(relativeChange(50, 0), null);
});

test("a missing figure is not a flat one", () => {
	assert.equal(relativeChange(null, 100), null);
	assert.equal(relativeChange(100, null), null);
});

test("change against a negative figure is measured by its size", () => {
	// A loss of 100 becoming a loss of 50 is a 50 percent improvement, not a
	// 50 percent fall, which is what dividing by the signed value would say.
	assert.equal(relativeChange(-50, -100), 0.5);
});
