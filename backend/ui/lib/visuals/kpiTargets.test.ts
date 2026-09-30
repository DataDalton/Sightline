import assert from "node:assert/strict";
import { test } from "node:test";
import {
	describeBasis,
	readTargets,
	resolveTarget,
	targetProgress,
} from "./kpiTargets";

const higher = (value: number) => ({ value, direction: "higher" as const });
const lower = (value: number) => ({ value, direction: "lower" as const });

test("a figure short of a higher target reports its share, rounded down", () => {
	const progress = targetProgress(82, higher(100), "decimal");
	assert.equal(progress?.text, "82% of target");
	assert.equal(progress?.status, "bad");
	assert.equal(progress?.fill, 0.82);

	// Just short is never rounded up to the target.
	assert.equal(
		targetProgress(99.9, higher(100), "decimal")?.text,
		"99% of target",
	);
});

test("within a tenth of a higher target is close rather than off", () => {
	assert.equal(targetProgress(95, higher(100), "decimal")?.status, "warn");
	assert.equal(targetProgress(89, higher(100), "decimal")?.status, "bad");
});

test("beating a higher target is good and the bar is full", () => {
	const progress = targetProgress(112, higher(100), "currency");
	assert.equal(progress?.text, "12% over target");
	assert.equal(progress?.status, "good");
	assert.equal(progress?.fill, 1);
});

test("a lower target reads the same words with the judgement reversed", () => {
	const under = targetProgress(82, lower(100), "currency");
	assert.equal(under?.text, "82% of target");
	assert.equal(under?.status, "good");

	const over = targetProgress(112, lower(100), "currency");
	assert.equal(over?.text, "12% over target");
	assert.equal(over?.status, "bad");

	assert.equal(targetProgress(105, lower(100), "currency")?.status, "warn");
});

test("hitting the target exactly is on target and good either way", () => {
	assert.equal(
		targetProgress(100, higher(100), "integer")?.text,
		"On target",
	);
	assert.equal(targetProgress(100, lower(100), "integer")?.status, "good");
});

test("a percentage measure is compared in points, never scaled", () => {
	const short = targetProgress(42.5, higher(45), "percent");
	assert.equal(short?.text, "-2.5 pts vs target");
	assert.equal(short?.status, "warn");

	const ahead = targetProgress(48, higher(45), "percent");
	assert.equal(ahead?.text, "+3.0 pts vs target");
	assert.equal(ahead?.status, "good");

	// A lower-is-better rate above its ceiling is the bad direction.
	assert.equal(targetProgress(12, lower(8), "percent")?.status, "bad");
	assert.equal(
		targetProgress(45.01, higher(45), "percent")?.text,
		"On target",
	);
});

test("a target of zero falls back to the signed gap", () => {
	const progress = targetProgress(-30, higher(0), "integer");
	assert.equal(progress?.text, "-30 vs target");
	assert.equal(progress?.status, "bad");
	assert.equal(progress?.fill, 0);
});

test("no figure means no progress to show", () => {
	assert.equal(targetProgress(null, higher(100), "decimal"), null);
});

test("stored targets keep only usable entries", () => {
	assert.deepEqual(
		readTargets({
			Sales: { value: 100, direction: "higher" },
			Cost: { value: "50", direction: "lower" },
			Blank: { value: "", direction: "higher" },
			Broken: "nope",
			Unsure: { value: 3 },
			Growth: {
				kind: "period",
				period: "year",
				change: 10,
				changeUnit: "percent",
				direction: "higher",
			},
			Plan: { kind: "measure", measure: "Budget", change: "-5" },
			Nowhere: { kind: "period", period: "decade" },
			Nameless: { kind: "measure", measure: " " },
		}),
		{
			Sales: {
				basis: { kind: "fixed", value: 100 },
				change: 0,
				changeUnit: "percent",
				direction: "higher",
			},
			Cost: {
				basis: { kind: "fixed", value: 50 },
				change: 0,
				changeUnit: "percent",
				direction: "lower",
			},
			Unsure: {
				basis: { kind: "fixed", value: 3 },
				change: 0,
				changeUnit: "percent",
				direction: "higher",
			},
			Growth: {
				basis: { kind: "period", period: "year" },
				change: 10,
				changeUnit: "percent",
				direction: "higher",
			},
			Plan: {
				basis: { kind: "measure", measure: "Budget" },
				change: -5,
				changeUnit: "percent",
				direction: "higher",
			},
		},
	);
	assert.deepEqual(readTargets(null), {});
	assert.deepEqual(readTargets([1, 2]), {});
});

test("a relative target moves its basis by a percentage or an amount", () => {
	const targets = readTargets({
		A: { kind: "period", period: "year", change: 10 },
		B: {
			kind: "period",
			period: "year",
			change: 500,
			changeUnit: "amount",
		},
		C: { kind: "measure", measure: "Budget", change: -5 },
		D: { value: 80, direction: "lower" },
	});
	assert.equal(resolveTarget(targets.A, 1000)?.value, 1100);
	assert.equal(resolveTarget(targets.B, 1000)?.value, 1500);
	assert.equal(resolveTarget(targets.C, 2000)?.value, 1900);
	// A fixed target needs no basis figure.
	assert.deepEqual(resolveTarget(targets.D, null), {
		value: 80,
		direction: "lower",
	});
	// Without its basis figure a relative target has nothing to show.
	assert.equal(resolveTarget(targets.A, null), null);
});

test("a relative target says where it comes from", () => {
	const targets = readTargets({
		A: { kind: "period", period: "year", change: 10 },
		B: { kind: "measure", measure: "Budget" },
		C: {
			kind: "period",
			period: "previous",
			change: -2,
			changeUnit: "amount",
		},
		D: { value: 5 },
	});
	assert.equal(describeBasis(targets.A, "currency"), "last year +10%");
	assert.equal(describeBasis(targets.B, "currency"), "Budget");
	assert.equal(
		describeBasis(targets.C, "percent"),
		"the period before -2 pts",
	);
	assert.equal(describeBasis(targets.D, "currency"), null);
});
