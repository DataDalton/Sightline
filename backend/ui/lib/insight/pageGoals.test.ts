import { test } from "node:test";
import assert from "node:assert/strict";
import { goalBelongsOnPage, measuresOnPage } from "./pageGoals";

const visual = (sourceKey: string | null, measures: unknown[]) => ({
	visualType: "barChart",
	sourceKey,
	config: { measures },
});

test("a visual with no source reads the page's", () => {
	assert.deepEqual(measuresOnPage([visual(null, ["Revenue"])], "sales"), [
		{ sourceKey: "sales", measure: "Revenue" },
	]);
});

test("a measure on two visuals is listed once", () => {
	assert.equal(
		measuresOnPage(
			[visual("sales", ["Revenue"]), visual("sales", ["Revenue"])],
			null,
		).length,
		1,
	);
});

test("the same measure name on another source is a different measure", () => {
	const measures = measuresOnPage([visual("sales", ["Revenue"])], null);
	assert.equal(
		goalBelongsOnPage({ source_key: "sales", measure: "Revenue" }, measures),
		true,
	);
	assert.equal(
		goalBelongsOnPage(
			{ source_key: "finance", measure: "Revenue" },
			measures,
		),
		false,
	);
});

test("page controls do not put a goal on a page", () => {
	assert.deepEqual(
		measuresOnPage(
			[
				{
					visualType: "dropdownFilter",
					sourceKey: "sales",
					config: { measures: ["Revenue"] },
				},
			],
			null,
		),
		[],
	);
});
