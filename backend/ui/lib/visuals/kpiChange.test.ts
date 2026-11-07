import { test } from "node:test";
import assert from "node:assert/strict";
import { isSigned, kpiChange, kpiChangeWords } from "./kpiChange";

test("a measure carrying its own sign shows no change of its own", () => {
	assert.equal(isSigned("Revenue Growth"), true);
	assert.equal(kpiChange("Revenue Growth", "decimal", 5, 3), null);
});

test("a figure's change is a share of the earlier one", () => {
	const held = kpiChange("Revenue", "currency", 110, 100);
	assert.ok(held);
	assert.equal(kpiChangeWords(held!), "+10.0%");
});

test("a percentage's change is in points", () => {
	const held = kpiChange("Margin", "percent", 42, 40);
	assert.ok(held);
	assert.equal(kpiChangeWords(held!), "+2.0 pts");
});

test("nothing to compare says nothing, and no movement says so", () => {
	assert.equal(kpiChange("Revenue", "currency", null, 100), null);
	assert.equal(kpiChange("Revenue", "currency", 100, null), null);
	assert.equal(
		kpiChangeWords(kpiChange("Revenue", "currency", 100, 100)!),
		"no change",
	);
});
