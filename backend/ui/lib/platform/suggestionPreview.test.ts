import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToSnapshot } from "./suggestionPreview";

const start = {
	visuals: [
		{
			visual_id: "V1",
			page_id: "p1",
			title: "Old",
			config: { a: 1 },
			layout_x: 0,
			is_active: true,
		},
		{ visual_id: "v2", page_id: "p1", title: "Other", is_active: true },
	],
	pages: [{ page_id: "p1", title: "One", config: { x: 1 }, is_active: true }],
	report: { title: "Report", theme: "plain" },
};

test("a suggestion changes a copy, never what it was given", () => {
	const copy = JSON.parse(JSON.stringify(start));
	const after = applyToSnapshot(start, [
		{ type: "updateVisual", visualId: "v1", title: "New" },
	]);
	assert.deepEqual(start, copy);
	assert.equal(after.visuals?.[0].title, "New");
	assert.deepEqual(after.visuals?.[0].config, { a: 1 });
});

test("adding, removing and moving visuals show", () => {
	const after = applyToSnapshot(start, [
		{
			type: "addVisual",
			visualId: "v3",
			pageId: "p1",
			visualType: "barChart",
			title: "Added",
			layout: { x: 1, y: 2, w: 3, h: 4 },
		},
		{ type: "removeVisual", visualId: "v2" },
		{
			type: "updateVisual",
			visualId: "v1",
			layout: { x: 5, y: 6, w: 7, h: 8 },
		},
	]);
	const byId = new Map(after.visuals?.map((v) => [v.visual_id, v]));
	assert.equal(byId.get("v3")?.layout_w, 3);
	assert.equal(byId.get("v2")?.is_active, false);
	assert.equal(byId.get("V1")?.layout_x, 5);
});

test("page settings merge and the report's own fields change", () => {
	const after = applyToSnapshot(start, [
		{ type: "updatePage", pageId: "p1", config: { y: 2 } },
		{ type: "updateReport", theme: "" },
		{ type: "addPage", pageId: "p2", title: "Two", slug: "two" },
		{ type: "removePage", pageId: "p1" },
	]);
	assert.deepEqual(after.pages?.[0].config, { x: 1, y: 2 });
	assert.equal(after.pages?.[0].is_active, false);
	assert.equal(after.pages?.[1].title, "Two");
	assert.equal(after.report?.theme, null);
});
