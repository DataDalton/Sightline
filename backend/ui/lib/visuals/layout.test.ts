import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canvasRows,
	clampRect,
	findFreeSlot,
	gridColumns,
	measureCanvas,
	overlaps,
	pixelsToCell,
	pixelsToSpan,
	rectToPixels,
	stackForNarrow,
	compactRows,
	resolveVerticalOverlaps,
	heightForRows,
	rowsForHeight,
	fillToViewport,
} from "./layout";

test("a rectangle is kept inside the grid", () => {
	// Too wide gets clamped to the grid, and the position follows so it does
	// not hang off the right edge.
	assert.deepEqual(clampRect({ x: 10, y: 0, w: 8, h: 4 }), {
		x: 4,
		y: 0,
		w: 8,
		h: 4,
	});
	assert.deepEqual(clampRect({ x: -3, y: -2, w: 4, h: 3 }), {
		x: 0,
		y: 0,
		w: 4,
		h: 3,
	});
});

test("a rectangle cannot be smaller than the minimum", () => {
	const clamped = clampRect({ x: 0, y: 0, w: 0, h: 0 });
	assert.ok(clamped.w >= 2);
	assert.ok(clamped.h >= 2);
});

test("pixel conversion round-trips through the grid", () => {
	const metrics = measureCanvas(1200);
	const rect = { x: 3, y: 2, w: 4, h: 5 };
	const pixels = rectToPixels(rect, metrics);

	assert.deepEqual(pixelsToCell(pixels.left, pixels.top, metrics), {
		x: 3,
		y: 2,
	});
	assert.deepEqual(pixelsToSpan(pixels.width, pixels.height, metrics), {
		w: 4,
		h: 5,
	});
});

test("a full-width visual spans every column", () => {
	const metrics = measureCanvas(1200);
	const pixels = rectToPixels({ x: 0, y: 0, w: gridColumns, h: 2 }, metrics);
	// Rounding across twelve columns must not lose a pixel, or a full-width
	// visual would stop short of the edge.
	assert.ok(Math.abs(pixels.width - 1200) < 1);
});

test("a new visual lands in the first free slot", () => {
	const existing = [{ x: 0, y: 0, w: 6, h: 4 }];
	// The right half of the first row is free, so that is where it goes.
	assert.deepEqual(findFreeSlot(existing, 6, 4), { x: 6, y: 0, w: 6, h: 4 });
});

test("a new visual goes below when the row is taken", () => {
	const existing = [{ x: 0, y: 0, w: 12, h: 4 }];
	const slot = findFreeSlot(existing, 6, 4);
	assert.ok(slot.y >= 4, "must not overlap the full-width visual above");
});

test("the canvas keeps spare rows to drop into", () => {
	// Without room below the last visual there would be nowhere to drag a new
	// one to.
	assert.ok(canvasRows([{ x: 0, y: 0, w: 6, h: 4 }]) > 4);
});

test("overlap is detected but not prevented", () => {
	assert.ok(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 2, y: 2, w: 4, h: 4 }));
	assert.ok(!overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 }));
	// Touching edges do not count as overlapping, or every adjacent pair would
	// warn.
	assert.ok(!overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 0, y: 4, w: 4, h: 4 }));
});

test("narrow screens stack in reading order", () => {
	// b sits to the right of a, and c below both. Stacked, the order must be
	// a, b, c rather than following the stored y alone.
	const stacked = stackForNarrow([
		{ id: "c", rect: { x: 0, y: 4, w: 12, h: 3 } },
		{ id: "b", rect: { x: 6, y: 0, w: 6, h: 4 } },
		{ id: "a", rect: { x: 0, y: 0, w: 6, h: 4 } },
	]);

	assert.deepEqual(
		stacked.map((s) => s.id),
		["a", "b", "c"],
	);
	// Every visual is full width and they do not overlap.
	assert.ok(stacked.every((s) => s.rect.w === gridColumns && s.rect.x === 0));
	assert.equal(stacked[1].rect.y, 4);
	assert.equal(stacked[2].rect.y, 8);
});

test("empty rows above the first visual are closed", () => {
	const compacted = compactRows([
		{ id: "a", rect: { x: 0, y: 2, w: 6, h: 4 } },
		{ id: "b", rect: { x: 6, y: 2, w: 6, h: 4 } },
	]);
	assert.equal(compacted[0].rect.y, 0);
	assert.equal(compacted[1].rect.y, 0);
});

test("two visuals sharing a row keep sharing it", () => {
	const compacted = compactRows([
		{ id: "a", rect: { x: 0, y: 3, w: 6, h: 2 } },
		{ id: "b", rect: { x: 6, y: 3, w: 6, h: 2 } },
	]);
	assert.equal(compacted[0].rect.y, compacted[1].rect.y);
	assert.equal(compacted[0].rect.x, 0);
	assert.equal(compacted[1].rect.x, 6);
});

test("a gap between two visuals is closed but their order is kept", () => {
	const compacted = compactRows([
		{ id: "a", rect: { x: 0, y: 0, w: 12, h: 2 } },
		{ id: "b", rect: { x: 0, y: 8, w: 12, h: 2 } },
	]);
	assert.equal(compacted[0].rect.y, 0);
	assert.equal(compacted[1].rect.y, 2);
});

test("an arrangement with no gaps is left alone", () => {
	const items = [
		{ id: "a", rect: { x: 0, y: 0, w: 12, h: 2 } },
		{ id: "b", rect: { x: 0, y: 2, w: 12, h: 4 } },
	];
	const compacted = compactRows(items);
	assert.deepEqual(
		compacted.map((i) => i.rect.y),
		[0, 2],
	);
});

test("an arrangement that does not overlap is left exactly as it is", () => {
	const items = [
		{ id: "a", rect: { x: 0, y: 0, w: 6, h: 4 } },
		{ id: "b", rect: { x: 6, y: 0, w: 6, h: 4 } },
		{ id: "c", rect: { x: 0, y: 4, w: 12, h: 6 } },
	];
	assert.deepEqual(resolveVerticalOverlaps(items), items);
});

test("a visual grown into the one below pushes it down", () => {
	const resolved = resolveVerticalOverlaps([
		{ id: "a", rect: { x: 0, y: 0, w: 12, h: 8 } },
		{ id: "b", rect: { x: 0, y: 4, w: 12, h: 4 } },
	]);
	assert.equal(resolved.find((i) => i.id === "b")?.rect.y, 8);
});

test("a visual beside another is not pushed by it", () => {
	const resolved = resolveVerticalOverlaps([
		{ id: "a", rect: { x: 0, y: 0, w: 6, h: 10 } },
		{ id: "b", rect: { x: 6, y: 0, w: 6, h: 4 } },
	]);
	assert.equal(resolved.find((i) => i.id === "b")?.rect.y, 0);
});

test("a height in pixels round trips through rows", () => {
	assert.equal(rowsForHeight(heightForRows(6)), 6);
});

test("the visual on the bottom row grows to the foot of the screen", () => {
	const filled = fillToViewport(
		[
			{ id: "kpi", rect: { x: 0, y: 0, w: 12, h: 2 }, canFill: false },
			{ id: "table", rect: { x: 0, y: 2, w: 12, h: 6 }, canFill: true },
		],
		heightForRows(20),
	);
	assert.ok((filled.find((i) => i.id === "table")?.rect.h ?? 0) > 6);
	assert.equal(filled.find((i) => i.id === "kpi")?.rect.h, 2);
});

test("a visual that is not on the bottom row is left alone", () => {
	const items = [
		{ id: "table", rect: { x: 0, y: 0, w: 12, h: 6 }, canFill: true },
		{ id: "note", rect: { x: 0, y: 6, w: 12, h: 2 }, canFill: false },
	];
	assert.deepEqual(fillToViewport(items, heightForRows(30)), items);
});

test("a visual already taller than the space is not shrunk", () => {
	const items = [{ id: "table", rect: { x: 0, y: 0, w: 12, h: 20 }, canFill: true }];
	assert.deepEqual(fillToViewport(items, heightForRows(6)), items);
});

test("two visuals sharing the bottom row both grow", () => {
	const filled = fillToViewport(
		[
			{ id: "a", rect: { x: 0, y: 0, w: 6, h: 4 }, canFill: true },
			{ id: "b", rect: { x: 6, y: 0, w: 6, h: 4 }, canFill: true },
		],
		heightForRows(12),
	);
	assert.equal(filled[0].rect.h, filled[1].rect.h);
	assert.ok(filled[0].rect.h > 4);
});
