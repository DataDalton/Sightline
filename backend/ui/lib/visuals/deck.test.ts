import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cleanStep,
	placeSlide,
	slideSlots,
	cleanDeckInput,
	popoverPosition,
	shouldOffer,
	slideLayout,
	stepIndex,
	stepParams,
} from "./deck";
import { decodeShareParams } from "./shareState";

const ids = () => {
	let next = 0;
	return () => `id${++next}`;
};

test("whatever is sent is reduced to a usable deck", () => {
	const deck = cleanDeckInput(
		{
			kind: "nonsense",
			title: "  ",
			steps: [
				{
					text: " Look here ",
					mark: "explode",
					filters: { Region: ["West", 3, ""], Bad: "x" },
					visualIds: ["a", 1],
				},
			],
		},
		ids(),
	);
	assert.equal(deck.kind, "walkthrough");
	assert.equal(deck.title, "Untitled");
	assert.equal(deck.steps[0].id, "id1");
	assert.equal(deck.steps[0].text, "Look here");
	assert.equal(deck.steps[0].mark, null);
	assert.deepEqual(deck.steps[0].filters, { Region: ["West"] });
	assert.deepEqual(deck.steps[0].visualIds, ["a"]);
});

test("a step keeps the id it came with", () => {
	const deck = cleanDeckInput({ steps: [{ id: "keep" }] }, ids());
	assert.equal(deck.steps[0].id, "keep");
});

test("moving stops at both ends", () => {
	assert.equal(stepIndex(-1, 3), 0);
	assert.equal(stepIndex(1, 3), 1);
	assert.equal(stepIndex(9, 3), 2);
});

test("a step's filters open the page the way a link does", () => {
	const params = new URLSearchParams(
		stepParams({ Region: ["West", "East"] }),
	);
	const state = decodeShareParams(params, {
		pages: [{ pageId: "p1", title: "One" }],
		widgets: [{ visualId: "w1", field: "Region" }],
		dimensions: [],
		views: [],
	});
	const clauses = state?.filters?.w1 as { values?: string[] }[];
	assert.deepEqual(clauses[0].values, ["West", "East"]);
});

test("a deck is offered once, and again when raised", () => {
	const deck = { promptOnce: true, epoch: 1, steps: [{}] as never };
	assert.equal(shouldOffer(deck, null), true);
	assert.equal(shouldOffer(deck, 1), false);
	assert.equal(shouldOffer({ ...deck, epoch: 2 }, 1), true);
	assert.equal(shouldOffer({ ...deck, promptOnce: false }, null), false);
	assert.equal(shouldOffer({ ...deck, steps: [] }, null), false);
});

test("a slide fills the width and never overlaps", () => {
	for (const count of [1, 2, 3, 4, 5, 6, 9]) {
		const rects = slideLayout(count);
		assert.equal(rects.length, count);
		for (const rect of rects) assert.ok(rect.x + rect.w <= 12);
		const seen = new Set(rects.map((r) => `${r.x},${r.y}`));
		assert.equal(seen.size, count);
	}
	assert.equal(slideLayout(1)[0].w, 12);
});

test("the explanation stays on screen", () => {
	const viewport = { width: 1000, height: 800 };
	const popover = { width: 300, height: 200 };
	assert.deepEqual(
		popoverPosition(
			{ top: 100, left: 50, width: 200, height: 100 },
			popover,
			viewport,
		),
		{ top: 216, left: 50 },
	);
	assert.deepEqual(
		popoverPosition(
			{ top: 500, left: 900, width: 90, height: 280 },
			popover,
			viewport,
		),
		{ top: 284, left: 684 },
	);
	assert.deepEqual(popoverPosition(null, popover, viewport), {
		top: 300,
		left: 350,
	});
});

test("a slide's visuals go where its layout puts them, and empty places stay empty", () => {
	const placed = placeSlide({
		layout: "oneOverTwo",
		visualIds: ["a", "", "c"],
	});
	assert.deepEqual(
		placed.map((held) => held.visualId),
		["a", "c"],
	);
	assert.equal(placed[0].rect.w, 12);
	assert.equal(placed[1].rect.x, 6);
});

test("a slide made before layouts arranges itself", () => {
	const placed = placeSlide({ visualIds: ["a", "b"] });
	assert.equal(placed.length, 2);
	assert.equal(placed[0].rect.w, 6);
});

test("a layout says how many places it has, and a title slide has none", () => {
	assert.equal(slideSlots("title"), 0);
	assert.equal(slideSlots("four"), 4);
	assert.equal(slideSlots("nonsense"), 0);
	assert.deepEqual(placeSlide({ layout: "title", visualIds: ["a"] }), []);
});

test("a stored layout must be a real one", () => {
	assert.equal(cleanStep({ layout: "two" }, () => "x").layout, "two");
	assert.equal(cleanStep({ layout: "bad" }, () => "x").layout, null);
});
