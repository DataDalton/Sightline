import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRebuild, rebuildPrompt } from "./rebuild";

const source = { dimensions: ["Region", "Month"], measures: ["Revenue"] };

test("real fields are kept and made up ones go", () => {
	const { visuals, dropped } = parseRebuild(
		`Here it is: ${JSON.stringify([
			{
				visualType: "barChart",
				title: "By region",
				dimensions: ["Region", "Nonsense"],
				measures: ["Revenue", "Profit"],
			},
			{
				visualType: "lineChart",
				title: "Gone",
				dimensions: ["Month"],
				measures: ["Profit"],
			},
		])}`,
		source,
	);
	assert.equal(visuals.length, 1);
	assert.deepEqual(visuals[0].dimensions, ["Region"]);
	assert.deepEqual(visuals[0].measures, ["Revenue"]);
	assert.equal(dropped, 1);
});

test("a type this does not build is dropped", () => {
	const { visuals, dropped } = parseRebuild(
		JSON.stringify([
			{ visualType: "hologram", measures: ["Revenue"], dimensions: [] },
		]),
		source,
	);
	assert.equal(visuals.length, 0);
	assert.equal(dropped, 1);
});

test("an answer that is not a list gives nothing", () => {
	assert.deepEqual(parseRebuild("Sorry, I cannot see that.", source), {
		visuals: [],
		dropped: 0,
	});
	assert.deepEqual(parseRebuild("[not json]", source), {
		visuals: [],
		dropped: 0,
	});
});

test("visuals lay out in reading order, without overlapping", () => {
	const item = (visualType: string) => ({
		visualType,
		title: "x",
		dimensions: ["Region"],
		measures: ["Revenue"],
	});
	const { visuals } = parseRebuild(
		JSON.stringify([
			item("kpiRow"),
			item("barChart"),
			item("lineChart"),
			item("table"),
		]),
		source,
	);
	assert.deepEqual(
		visuals.map((v) => [v.layout.x, v.layout.y, v.layout.w]),
		[
			[0, 0, 12],
			[0, 2, 6],
			[6, 2, 6],
			[0, 8, 12],
		],
	);
	assert.deepEqual(visuals[0].dimensions, []);
});

test("the prompt names the real fields and says not to copy numbers", () => {
	const prompt = rebuildPrompt(source);
	assert.ok(prompt.includes('"Revenue"'));
	assert.match(prompt, /Do not copy any numbers/);
});
