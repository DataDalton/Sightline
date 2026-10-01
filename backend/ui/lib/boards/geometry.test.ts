import assert from "node:assert/strict";
import { test } from "node:test";
import { arrowPath, edgePoint, snapMove, snapResize } from "./geometry";

const a = { x: 0, y: 0, w: 100, h: 50 };
const right = { x: 300, y: 100, w: 100, h: 50 };
const below = { x: 20, y: 300, w: 100, h: 50 };

test("a straight arrow runs from edge to edge", () => {
	assert.deepEqual(edgePoint(a, { x: 1000, y: 25 }), { x: 100, y: 25 });
	assert.equal(arrowPath(a, right, "straight").d.startsWith("M100,"), true);
});

test("a right angled arrow leaves from the side facing the other item", () => {
	assert.equal(arrowPath(a, right, "orthogonal").d, "M100,25 H200 V125 H300");
	assert.equal(arrowPath(a, below, "orthogonal").d, "M50,50 V175 H70 V300");
});

test("a curved arrow leaves and arrives along the same direction", () => {
	const d = arrowPath(a, right, "curved").d;
	assert.match(d, /^M100,25 C200,25 200,125 300,125$/);
});

const options = { grid: 8, guides: true, threshold: 6 };

test("an item lines up with another before it snaps to the grid", () => {
	const moved = snapMove({ x: 303, y: 13, w: 100, h: 50 }, [right], options);
	// The left edges line up with the item at x 300, and y falls to the grid.
	assert.equal(moved.x, 300);
	assert.equal(moved.y, 16);
	assert.deepEqual(moved.guides, [{ axis: "x", at: 300, from: 16, to: 150 }]);
});

test("centres line up too", () => {
	const moved = snapMove({ x: 0, y: 99, w: 100, h: 52 }, [right], options);
	assert.equal(moved.y + 26, 125);
});

test("without a grid or guides an item stays where it was put", () => {
	const free = { grid: null, guides: false, threshold: 6 };
	assert.deepEqual(snapMove({ x: 303, y: 13, w: 10, h: 10 }, [right], free), {
		x: 303,
		y: 13,
		guides: [],
	});
});

test("a resized edge lines up and never goes under the least size", () => {
	const sized = snapResize({ x: 0, y: 0, w: 297, h: 10 }, [right], options, {
		w: 24,
		h: 24,
	});
	assert.equal(sized.w, 300);
	assert.equal(sized.h, 24);
});
