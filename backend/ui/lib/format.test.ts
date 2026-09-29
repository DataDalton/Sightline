import assert from "node:assert/strict";
import { test } from "node:test";
import { groupLabel, plainDates } from "./format";

test("a midnight date reads as the day itself", () => {
	const rows = plainDates([
		{ Month: new Date("2026-01-01T00:00:00.000Z"), Revenue: 5 },
	]);
	assert.deepEqual(rows, [{ Month: "2026-01-01", Revenue: 5 }]);
});

test("a moment in the day keeps its time", () => {
	const rows = plainDates([{ At: new Date("2026-01-01T09:30:00.000Z") }]);
	assert.deepEqual(rows, [{ At: "2026-01-01T09:30:00.000Z" }]);
});

test("rows without dates come back untouched", () => {
	const rows = [{ Month: "2026-01-01", Revenue: 5 }];
	assert.equal(plainDates(rows), rows);
});

test("an empty group has one label", () => {
	assert.equal(groupLabel(null), "(blank)");
	assert.equal(groupLabel(""), "(blank)");
	assert.equal(groupLabel("Europe"), "Europe");
});
