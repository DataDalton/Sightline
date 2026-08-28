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
	tidyLayout,
	alignRects,
	distributeRects,
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
	assert.ok(
		!overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 }),
	);
	// Touching edges do not count as overlapping, or every adjacent pair would
	// warn.
	assert.ok(
		!overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 0, y: 4, w: 4, h: 4 }),
	);
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
	const items = [
		{ id: "table", rect: { x: 0, y: 0, w: 12, h: 20 }, canFill: true },
	];
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

// --- Tidying ---------------------------------------------------------------

const t = (id: string, x: number, y: number, w: number, h: number) => ({
	id,
	rect: { x, y, w, h },
});

test("tidying closes the empty rows between visuals", () => {
	const { items, moved } = tidyLayout([
		t("a", 0, 3, 12, 2),
		t("b", 0, 9, 12, 4),
	]);
	assert.equal(items[0].rect.y, 0);
	assert.equal(items[1].rect.y, 2);
	assert.equal(moved, 2);
});

test("tidying closes the gap between two visuals in a row", () => {
	const { items } = tidyLayout([t("a", 0, 0, 5, 4), t("b", 7, 0, 5, 4)]);
	assert.equal(items[0].rect.x, 0);
	// Ten columns across a nearly full row, so the two share the slack and the
	// second starts where the first, now six wide, ends.
	assert.equal(items[0].rect.w, 6);
	assert.equal(items[1].rect.x, 6);
	assert.equal(items[1].rect.w, 6);
});

test("tidying keeps the left to right order of a row", () => {
	const { items } = tidyLayout([
		t("right", 6, 0, 4, 3),
		t("left", 1, 0, 4, 3),
	]);
	const left = items.find((i) => i.id === "left")!;
	const right = items.find((i) => i.id === "right")!;
	assert.ok(left.rect.x < right.rect.x);
});

test("a row already reaching across is stretched to the full grid", () => {
	const { items } = tidyLayout([
		t("a", 0, 0, 3, 4),
		t("b", 3, 0, 3, 4),
		t("c", 6, 0, 4, 4),
	]);
	assert.equal(items[0].rect.x + items[0].rect.w, items[1].rect.x);
	assert.equal(items[2].rect.x + items[2].rect.w, gridColumns);
});

test("a narrow row keeps the width it was given", () => {
	// Six columns is well under the point where a row counts as reaching
	// across, so widening it would be a rearrangement rather than a tidy.
	const { items } = tidyLayout([t("a", 0, 0, 3, 4), t("b", 3, 0, 3, 4)]);
	assert.equal(items[0].rect.w, 3);
	assert.equal(items[1].rect.w, 3);
});

test("a visual on its own keeps its position and width", () => {
	// Centred deliberately, so nothing about it is ragged.
	const { items, moved } = tidyLayout([t("only", 3, 0, 6, 4)]);
	assert.deepEqual(items[0].rect, { x: 3, y: 0, w: 6, h: 4 });
	assert.equal(moved, 0);
});

test("heights within a row level up when they nearly agree", () => {
	const { items } = tidyLayout([t("a", 0, 0, 6, 4), t("b", 6, 0, 6, 5)]);
	assert.equal(items[0].rect.h, 5);
	assert.equal(items[1].rect.h, 5);
});

test("a row with one deliberately tall visual is left unlevelled", () => {
	const { items } = tidyLayout([t("a", 0, 0, 6, 3), t("b", 6, 0, 6, 9)]);
	assert.equal(items[0].rect.h, 3);
	assert.equal(items[1].rect.h, 9);
});

test("the next row starts below the tallest visual above it", () => {
	const { items } = tidyLayout([
		t("a", 0, 0, 6, 3),
		t("b", 6, 0, 6, 9),
		t("c", 0, 12, 12, 2),
	]);
	assert.equal(items[2].rect.y, 9);
});

test("an arrangement that is already tidy is left exactly as it is", () => {
	const items = [t("a", 0, 0, 6, 4), t("b", 6, 0, 6, 4), t("c", 0, 4, 12, 3)];
	const result = tidyLayout(items);
	assert.equal(result.moved, 0);
	assert.deepEqual(
		result.items.map((i) => i.rect),
		items.map((i) => i.rect),
	);
});

test("tidying never widens a row past the grid", () => {
	const { items } = tidyLayout([
		t("a", 0, 0, 6, 4),
		t("b", 6, 0, 6, 4),
		t("c", 0, 4, 11, 4),
	]);
	for (const item of items) {
		assert.ok(item.rect.x + item.rect.w <= gridColumns);
	}
});

test("tidying an empty page does nothing", () => {
	const { items, moved } = tidyLayout([]);
	assert.deepEqual(items, []);
	assert.equal(moved, 0);
});

// --- Aligning and distributing ---------------------------------------------

test("aligning left puts every rectangle on the leftmost edge", () => {
	const aligned = alignRects(
		[t("a", 2, 0, 4, 3), t("b", 7, 4, 3, 3)],
		"left",
	);
	assert.equal(aligned[0].rect.x, 2);
	assert.equal(aligned[1].rect.x, 2);
});

test("aligning right lines up the right edges, not the left", () => {
	const aligned = alignRects(
		[t("a", 0, 0, 4, 3), t("b", 2, 4, 6, 3)],
		"right",
	);
	assert.equal(aligned[0].rect.x + aligned[0].rect.w, 8);
	assert.equal(aligned[1].rect.x + aligned[1].rect.w, 8);
});

test("matching width widens to the widest and never narrows", () => {
	const aligned = alignRects(
		[t("a", 0, 0, 3, 3), t("b", 0, 4, 7, 3)],
		"matchWidth",
	);
	assert.equal(aligned[0].rect.w, 7);
	assert.equal(aligned[1].rect.w, 7);
});

test("matching width cannot push a rectangle off the grid", () => {
	const aligned = alignRects(
		[t("a", 8, 0, 4, 3), t("b", 0, 4, 10, 3)],
		"matchWidth",
	);
	for (const item of aligned) {
		assert.ok(item.rect.x + item.rect.w <= gridColumns);
	}
});

test("aligning a single rectangle changes nothing", () => {
	const items = [t("only", 3, 2, 4, 3)];
	assert.equal(alignRects(items, "left")[0], items[0]);
});

test("distributing evens the gaps and leaves the ends alone", () => {
	const spread = distributeRects(
		[t("a", 0, 0, 2, 2), t("b", 3, 0, 2, 2), t("c", 10, 0, 2, 2)],
		"x",
	);
	const [a, b, c] = spread.map((i) => i.rect);
	assert.equal(a.x, 0);
	assert.equal(c.x, 10);
	// Six columns of free space across two gaps, so three each.
	assert.equal(b.x, 5);
});

test("distributing needs three rectangles to have a middle", () => {
	const items = [t("a", 0, 0, 2, 2), t("b", 8, 0, 2, 2)];
	assert.equal(distributeRects(items, "x"), items);
});

test("distributing an overlapping selection leaves it alone", () => {
	const items = [t("a", 0, 0, 6, 2), t("b", 1, 0, 6, 2), t("c", 2, 0, 6, 2)];
	assert.equal(distributeRects(items, "x"), items);
});

test("distributing vertically works on the other axis", () => {
	const spread = distributeRects(
		[t("a", 0, 0, 12, 2), t("b", 0, 3, 12, 2), t("c", 0, 10, 12, 2)],
		"y",
	);
	assert.equal(spread[0].rect.y, 0);
	assert.equal(spread[1].rect.y, 5);
	assert.equal(spread[2].rect.y, 10);
});
