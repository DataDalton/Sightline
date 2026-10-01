import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthored, isPresent, referencedColumns } from "./authoredFields";

const published = new Set([
	"Commence_Date",
	"Payment",
	"Flexforce_Contract_ID",
	"Capital",
]);

test("the columns an expression reads are its quoted names", () => {
	assert.deepEqual(
		referencedColumns("CAST(date_trunc('MONTH', `Commence_Date`) AS DATE)"),
		["Commence_Date"],
	);
	assert.deepEqual(referencedColumns("SUM(`a``b`) / SUM(`c`)"), ["a`b", "c"]);
	assert.deepEqual(referencedColumns("COUNT(*)"), []);
});

test("a calculation over columns that are all there is present", () => {
	assert.equal(
		isPresent(
			"Commence Month",
			"CAST(date_trunc('MONTH', `Commence_Date`) AS DATE)",
			published,
		),
		true,
	);
	assert.equal(
		isPresent(
			"Contract Count",
			"COUNT(DISTINCT `Flexforce_Contract_ID`)",
			published,
		),
		true,
	);
});

test("a calculation over a column that went away is missing", () => {
	assert.equal(isPresent("Average Term", "AVG(`Term`)", published), false);
});

test("a field registered for a column is judged by its own name", () => {
	assert.equal(isAuthored("Capital", "SUM(`Capital`)"), false);
	assert.equal(isAuthored("Region", "`Region`"), false);
	assert.equal(isPresent("Capital", "SUM(`Capital`)", published), true);
	assert.equal(isPresent("Region", "`Region`", published), false);
	// A metric view field carries no expression.
	assert.equal(isPresent("Bookings", null, published), false);
});

test("a calculation that reads no column is present", () => {
	assert.equal(isAuthored("Schedule Count", "COUNT(*)"), true);
	assert.equal(isPresent("Schedule Count", "COUNT(*)", published), true);
});
