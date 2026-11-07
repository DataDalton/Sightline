import { test } from "node:test";
import assert from "node:assert/strict";
import {
	blockRefOf,
	placeBlock,
	planBlockUpdate,
	visualsToBlock,
	withoutBlockRef,
	type BlockVisual,
} from "./blocks";

const counter = (prefix: string) => {
	let next = 0;
	return () => `${prefix}${++next}`;
};

const member = (key: string, y = 0): BlockVisual => ({
	key,
	visualType: "barChart",
	title: key,
	sourceKey: "sales",
	config: { measures: ["Revenue"] },
	layout: { x: 0, y, w: 6, h: 4 },
});

test("a block is measured from its own top left corner", () => {
	const block = visualsToBlock(
		[
			{
				visualType: "barChart",
				title: "A",
				config: { blockRef: { blockId: "old" }, measures: ["M"] },
				layout: { x: 4, y: 10, w: 6, h: 4 },
			},
			{
				visualType: "lineChart",
				title: "B",
				config: {},
				layout: { x: 6, y: 14, w: 6, h: 4 },
			},
		],
		counter("k"),
	);
	assert.deepEqual(block[0].layout, { x: 0, y: 0, w: 6, h: 4 });
	assert.deepEqual(block[1].layout, { x: 2, y: 4, w: 6, h: 4 });
	assert.deepEqual(block[0].config, { measures: ["M"] });
});

test("placing a block links each visual back and offsets it", () => {
	const placed = placeBlock(
		"b1",
		[member("k1", 4)],
		{ x: 2, y: 20 },
		{
			placementId: "p1",
			visualId: counter("v"),
		},
	);
	assert.equal(placed[0].visualId, "v1");
	assert.deepEqual(placed[0].layout, { x: 2, y: 24, w: 6, h: 4 });
	assert.deepEqual(blockRefOf(placed[0].config), {
		blockId: "b1",
		key: "k1",
		placementId: "p1",
		origin: { x: 2, y: 20 },
	});
});

test("a config with no complete reference is not linked", () => {
	assert.equal(blockRefOf({}), null);
	assert.equal(blockRefOf({ blockRef: { blockId: "b" } }), null);
	assert.equal(blockRefOf(null), null);
});

test("detaching keeps everything but the link", () => {
	assert.deepEqual(withoutBlockRef({ blockRef: {}, measures: ["M"] }), {
		measures: ["M"],
	});
});

const placedRow = (visualId: string, key: string, placementId = "p1") => ({
	visualId,
	pageId: "page",
	config: {
		blockRef: {
			blockId: "b1",
			key,
			placementId,
			origin: { x: 1, y: 10 },
		},
	},
});

test("an update changes what stayed, removes what left, adds what is new", () => {
	const plan = planBlockUpdate(
		"b1",
		[member("keep"), member("added", 4)],
		[placedRow("v1", "keep"), placedRow("v2", "gone")],
	);
	assert.deepEqual(
		plan.updates.map((u) => u.visualId),
		["v1"],
	);
	assert.deepEqual(plan.removes, ["v2"]);
	assert.equal(plan.inserts.length, 1);
	assert.equal(plan.inserts[0].visual.key, "added");
	assert.deepEqual(plan.inserts[0].layout, { x: 1, y: 14, w: 6, h: 4 });
	assert.equal(plan.inserts[0].ref.placementId, "p1");
});

test("two drops on a page each gain the new visual", () => {
	const plan = planBlockUpdate(
		"b1",
		[member("keep"), member("added")],
		[placedRow("v1", "keep", "p1"), placedRow("v2", "keep", "p2")],
	);
	assert.deepEqual(plan.inserts.map((i) => i.ref.placementId).sort(), [
		"p1",
		"p2",
	]);
});

test("visuals from another block and detached ones are left alone", () => {
	const plan = planBlockUpdate(
		"b1",
		[member("keep")],
		[
			{ visualId: "v1", pageId: "page", config: {} },
			{
				visualId: "v2",
				pageId: "page",
				config: {
					blockRef: {
						blockId: "other",
						key: "keep",
						placementId: "p",
						origin: { x: 0, y: 0 },
					},
				},
			},
		],
	);
	assert.deepEqual(plan, { updates: [], removes: [], inserts: [] });
});
