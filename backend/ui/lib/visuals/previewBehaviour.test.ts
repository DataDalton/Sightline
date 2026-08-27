import assert from "node:assert/strict";
import { test } from "node:test";
import { visualCatalog } from "./catalog";
import {
	behaviourCaptions,
	behaviourFor,
	unclassifiedTypes,
	type PreviewBehaviour,
} from "./previewBehaviour";

// The picker's preview shows what a visual does when somebody uses it. A type
// with no behaviour recorded falls back to "reacts to the page", which is
// wrong for anything that filters one, and wrong quietly: the preview still
// draws, it just describes the wrong thing.
//
// This is the third list in this codebase that had to be kept in step with the
// catalogue by hand. The other two were a drawing per type and an ordering per
// category, and both silently omitted whatever was added last.

test("every visual in the catalogue has a behaviour", () => {
	assert.deepEqual(
		unclassifiedTypes(),
		[],
		"add these to previewBehaviour.ts",
	);
});

test("every behaviour has a caption", () => {
	const used = new Set<PreviewBehaviour>(
		visualCatalog.map((d) => behaviourFor(d.type)),
	);
	for (const behaviour of used) {
		const caption = behaviourCaptions[behaviour];
		assert.ok(
			caption && caption.length > 0,
			`no caption for "${behaviour}"`,
		);
	}
});

// The classification is a claim about what the visual does, so the claims worth
// pinning are the ones a careless edit would get backwards.

test("a filter drives the page and a summary reacts to it", () => {
	assert.equal(behaviourFor("dropdownFilter"), "narrow");
	assert.equal(behaviourFor("kpiRow"), "respond");
	assert.equal(behaviourFor("gauge"), "respond");
});

test("marks on a continuous axis are brushed, not clicked", () => {
	assert.equal(behaviourFor("lineChart"), "brush");
	assert.equal(behaviourFor("areaChart"), "brush");
	assert.equal(behaviourFor("scatterChart"), "brush");
	// A bar chart's axis is categories, so one bar is a fair question.
	assert.equal(behaviourFor("barChart"), "crossFilter");
});

test("the expandable table descends rather than filtering", () => {
	assert.equal(behaviourFor("matrixTable"), "drill");
	assert.equal(behaviourFor("table"), "crossFilter");
});

test("text does nothing when it is clicked", () => {
	assert.equal(behaviourFor("textPanel"), "static");
	assert.equal(behaviourFor("sectionHeader"), "static");
	assert.equal(behaviourFor("blockedNotice"), "static");
});
