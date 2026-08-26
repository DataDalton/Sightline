import { test } from "node:test";
import assert from "node:assert/strict";
import { rankTarget, scoreMatch } from "./searchMatch.js";

test("an empty query matches everything equally", () => {
	assert.equal(scoreMatch("Sales pipeline", ""), 0);
});

test("a name it starts with beats the same word further in", () => {
	const starts = scoreMatch("Sales pipeline", "sales");
	const inside = scoreMatch("Regional sales", "sales");
	assert.notEqual(starts, null);
	assert.notEqual(inside, null);
	assert.ok((starts ?? 0) > (inside ?? 0));
});

test("matching is case insensitive in both directions", () => {
	assert.equal(
		scoreMatch("Sales Pipeline", "SALES"),
		scoreMatch("sales pipeline", "sales"),
	);
});

test("characters spread through the text still match", () => {
	assert.notEqual(scoreMatch("Contract renewals", "ctr"), null);
});

test("characters out of order do not match", () => {
	assert.equal(scoreMatch("Contract renewals", "rtc"), null);
});

test("a character the text does not carry does not match", () => {
	assert.equal(scoreMatch("Contract renewals", "czz"), null);
});

// The ordering that matters: a whole word buried in a long title must still
// beat letters scattered across a short one, or searching a real word starts
// surfacing things that merely contain its letters.
test("a whole word beats a scattered match", () => {
	const whole = scoreMatch("Quarterly regional sales review", "sales");
	const scattered = scoreMatch("Sam also left early", "sales");
	assert.notEqual(whole, null);
	assert.ok((whole ?? 0) > (scattered ?? 0));
});

test("a title match outranks a description match", () => {
	const onTitle = rankTarget("Rebates", "quarterly figures", "rebates");
	const onDescription = rankTarget("Quarterly figures", "rebates", "rebates");
	assert.notEqual(onTitle, null);
	assert.notEqual(onDescription, null);
	assert.ok((onTitle ?? 0) > (onDescription ?? 0));
});

test("a title miss falls back to the rest rather than dropping the row", () => {
	assert.notEqual(
		rankTarget("Quarterly figures", "rebate detail", "rebate"),
		null,
	);
});

test("matching neither the title nor the rest is no match", () => {
	assert.equal(
		rankTarget("Quarterly figures", "rebate detail", "zzzz"),
		null,
	);
});
