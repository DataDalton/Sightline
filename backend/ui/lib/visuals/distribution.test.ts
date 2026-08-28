import assert from "node:assert/strict";
import { test } from "node:test";
import { binValues, fiveNumber, suggestBinCount } from "./distribution";

test("values are spread across the bins they fall in", () => {
	const bins = binValues([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
	assert.equal(bins.length, 5);
	assert.deepEqual(
		bins.map((b) => b.count),
		[2, 2, 2, 2, 2],
	);
});

test("bins are half open, so a boundary value goes to the upper bin", () => {
	// Bins span the lowest value to the highest, so two of them over 0 to 10
	// put the edge at 5. Five belongs above it, not below.
	const bins = binValues([0, 4.9, 5, 10], 2);
	assert.equal(bins[0].to, 5);
	assert.deepEqual(
		bins.map((b) => b.count),
		[2, 2],
	);
});

test("the largest value lands in the last bin rather than past the end", () => {
	const bins = binValues([1, 2, 3, 10], 3);
	assert.equal(bins[bins.length - 1].count, 1);
	assert.equal(
		bins.reduce((sum, b) => sum + b.count, 0),
		4,
	);
});

test("bins cover the whole range from lowest to highest", () => {
	const bins = binValues([2, 8], 3);
	assert.equal(bins[0].from, 2);
	assert.equal(bins[bins.length - 1].to, 8);
});

test("values that are all identical make one bin holding all of them", () => {
	const bins = binValues([7, 7, 7], 5);
	assert.equal(bins.length, 1);
	assert.equal(bins[0].count, 3);
});

test("nothing to bin produces no bins", () => {
	assert.deepEqual(binValues([]), []);
	assert.deepEqual(binValues([Number.NaN, Number.POSITIVE_INFINITY]), []);
});

test("every value is counted exactly once", () => {
	const values = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 100);
	const bins = binValues(values, 12);
	assert.equal(
		bins.reduce((sum, b) => sum + b.count, 0),
		200,
	);
});

test("the suggested bin count grows with the data and stays bounded", () => {
	assert.equal(suggestBinCount(1), 1);
	assert.ok(suggestBinCount(100) >= 5);
	assert.ok(suggestBinCount(100) < suggestBinCount(100000));
	assert.ok(suggestBinCount(10_000_000) <= 50);
});

// --- Five number summary ---------------------------------------------------

test("the quartiles of an even spread are where they should be", () => {
	const box = fiveNumber([1, 2, 3, 4, 5])!;
	assert.equal(box.q1, 2);
	assert.equal(box.median, 3);
	assert.equal(box.q3, 4);
});

test("a quartile falling between two values is interpolated", () => {
	// Four values, so the lower quartile sits a quarter of the way between the
	// first and the second, which is the method percentile_cont uses.
	const box = fiveNumber([10, 20, 30, 40])!;
	assert.equal(box.q1, 17.5);
	assert.equal(box.median, 25);
	assert.equal(box.q3, 32.5);
});

test("a value far outside the box is reported as an outlier", () => {
	const box = fiveNumber([1, 2, 3, 4, 5, 100])!;
	assert.deepEqual(box.outliers, [100]);
	// The whisker reaches the furthest value still inside the fence, not the
	// fence itself, so it never claims a value the data does not have.
	assert.equal(box.max, 5);
});

test("a set with no outliers has whiskers at its own extremes", () => {
	const box = fiveNumber([1, 2, 3, 4, 5])!;
	assert.deepEqual(box.outliers, []);
	assert.equal(box.min, 1);
	assert.equal(box.max, 5);
});

test("one value is its own box", () => {
	const box = fiveNumber([42])!;
	assert.equal(box.min, 42);
	assert.equal(box.median, 42);
	assert.equal(box.max, 42);
	assert.deepEqual(box.outliers, []);
});

test("nothing to summarise has no summary", () => {
	assert.equal(fiveNumber([]), null);
	assert.equal(fiveNumber([Number.NaN]), null);
});

test("outliers below the box are found too", () => {
	const box = fiveNumber([-100, 10, 11, 12, 13, 14])!;
	assert.deepEqual(box.outliers, [-100]);
	assert.equal(box.min, 10);
});
