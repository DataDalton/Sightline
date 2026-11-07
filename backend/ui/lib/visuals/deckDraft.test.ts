import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDraft } from "./deck";

const report = {
	title: "Sales",
	description: null,
	pages: [
		{
			pageId: "p1",
			title: "One",
			visuals: [
				{
					visualId: "v1",
					visualType: "barChart",
					title: "Revenue",
					config: {},
				},
			],
		},
	],
};

test("reads the steps out of an answer with words around them", () => {
	const steps = parseDraft(
		'Here you go:\n[{"visualId":"v1","title":"Revenue","text":"How much was sold."}]\nDone.',
		report,
		() => "new",
	);
	assert.equal(steps.length, 1);
	assert.equal(steps[0].pageId, "p1");
	assert.equal(steps[0].text, "How much was sold.");
});

test("drops a step naming a visual the report does not have", () => {
	assert.deepEqual(
		parseDraft(
			'[{"visualId":"made-up","title":"X","text":"Y"}]',
			report,
			() => "n",
		),
		[],
	);
});

test("an answer that is not steps gives nothing", () => {
	assert.deepEqual(
		parseDraft("I cannot help with that.", report, () => "n"),
		[],
	);
	assert.deepEqual(
		parseDraft("[not json]", report, () => "n"),
		[],
	);
});
