import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAt, decideTheme } from "./themes";

const before = { dimensions: ["Region"], measures: ["Revenue"] };
const asLine = {
	visualType: "lineChart",
	title: "Revenue by region",
	dimensions: ["Region"],
	measures: ["Revenue"],
};
const base = {
	changeKind: "presentation",
	confident: true,
	contradicted: false,
	people: applyAt,
	unanswered: true,
	protectedPage: false,
	before,
	proposal: asLine,
};

test("a sure presentation fix enough people asked for is made", () => {
	assert.deepEqual(decideTheme(base), {
		act: "apply",
		changeKind: "presentation",
	});
});

test("anything short of sure, agreed and enough goes to the maintainers", () => {
	assert.equal(decideTheme({ ...base, confident: false }).act, "suggest");
	assert.equal(decideTheme({ ...base, contradicted: true }).act, "suggest");
	assert.equal(decideTheme({ ...base, people: applyAt - 1 }).act, "suggest");
	assert.equal(decideTheme({ ...base, protectedPage: true }).act, "suggest");
});

test("one person alone is waited on", () => {
	assert.equal(decideTheme({ ...base, people: 1 }).act, "wait");
});

test("a proposal that changes the fields is meaning, whatever it was called", () => {
	const decided = decideTheme({
		...base,
		proposal: { ...asLine, dimensions: ["Region", "Channel"] },
	});
	assert.deepEqual(decided, { act: "suggest", changeKind: "meaning" });
});

test("reordered fields are still presentation", () => {
	const decided = decideTheme({
		...base,
		before: { dimensions: ["Region", "Channel"], measures: ["Revenue"] },
		proposal: { ...asLine, dimensions: ["Channel", "Region"] },
	});
	assert.equal(decided.act, "apply");
});

test("figures that look wrong go to the maintainers only if nobody was answered", () => {
	assert.equal(
		decideTheme({ ...base, changeKind: "data", people: 1 }).act,
		"escalate",
	);
	assert.equal(
		decideTheme({ ...base, changeKind: "data", unanswered: false }).act,
		"wait",
	);
});

test("no change, or no proposal, waits", () => {
	assert.equal(decideTheme({ ...base, changeKind: "none" }).act, "wait");
	assert.equal(decideTheme({ ...base, proposal: null }).act, "wait");
});
