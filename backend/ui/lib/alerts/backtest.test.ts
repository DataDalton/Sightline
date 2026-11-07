import { test } from "node:test";
import assert from "node:assert/strict";
import { aftermathOf, backtest } from "./backtest";

const days = (values: (number | null)[]) =>
	values.map((value, index) => ({
		period: `2026-01-${String(index + 1).padStart(2, "0")}`,
		group: null,
		value,
	}));

test("an above alert fires on crossing, not on every day past the line", () => {
	const result = backtest(
		{ condition: "above", threshold: 10, notifyRecover: false },
		days([5, 12, 13, 14, 5, 12]),
	);
	assert.equal(result.fired, 2);
	assert.equal(result.firstOn, "2026-01-02");
	assert.equal(result.lastOn, "2026-01-06");
	assert.equal(result.checked, 6);
});

test("a line never crossed never fires", () => {
	const result = backtest(
		{ condition: "above", threshold: 100, notifyRecover: false },
		days([1, 2, 3]),
	);
	assert.equal(result.fired, 0);
	assert.equal(result.firstOn, null);
});

test("an unusual alert looks for what stands out", () => {
	const result = backtest(
		{ condition: "unusual", threshold: null, notifyRecover: false },
		days([10, 11, 9, 10, 400, 11, 10, 9, 10]),
	);
	assert.equal(result.fired, 1);
	assert.equal(result.lastOn, "2026-01-05");
});

test("groups are followed separately", () => {
	const result = backtest(
		{ condition: "above", threshold: 10, notifyRecover: false },
		[
			{ period: "2026-01-01", group: "W", value: 5 },
			{ period: "2026-01-01", group: "E", value: 5 },
			{ period: "2026-01-02", group: "W", value: 20 },
			{ period: "2026-01-02", group: "E", value: 5 },
		],
	);
	assert.equal(result.fired, 1);
});

const fired = (recoveredOn: string | null = null) => ({
	firedOn: "2026-01-01",
	recoveredOn,
});

test("aftermath says how it recovered", () => {
	const result = aftermathOf([
		fired("2026-01-03"),
		fired("2026-01-05"),
		fired(),
	]);
	assert.equal(result.fired, 3);
	assert.equal(result.recovered, 2);
	assert.equal(result.typicalDaysToRecover, 4);
	assert.equal(result.verdict, "useful");
});

test("an alert that fires constantly says so", () => {
	assert.equal(
		aftermathOf(Array.from({ length: 20 }, () => fired())).verdict,
		"noisy",
	);
	assert.equal(aftermathOf([]).verdict, "quiet");
});
