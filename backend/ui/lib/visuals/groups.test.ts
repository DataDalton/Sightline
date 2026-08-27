import assert from "node:assert/strict";
import { test } from "node:test";
import {
	boundsRows,
	groupContentBox,
	groupHeaderHeight,
	groupPadding,
	wouldLoop,
} from "./layout";

// A group holds other visuals, and what it holds is stored on the children.
// That makes two things worth pinning: the box the children are measured from,
// and the rule that stops a group being put inside itself.

test("the content box takes the padding off both sides", () => {
	const box = groupContentBox({ width: 400, height: 300 }, false);
	assert.equal(box.width, 400 - groupPadding * 2);
	assert.equal(box.height, 300 - groupPadding * 2);
});

test("a titled group gives up a row to its heading", () => {
	const bare = groupContentBox({ width: 400, height: 300 }, false);
	const titled = groupContentBox({ width: 400, height: 300 }, true);
	assert.equal(titled.height, bare.height - groupHeaderHeight);
	assert.equal(titled.width, bare.width);
});

// A group dragged smaller than its padding would otherwise report a negative
// box, and every child inside it would be laid out against a negative width.
test("a box smaller than its own padding does not go negative", () => {
	const box = groupContentBox({ width: 4, height: 4 }, true);
	assert.ok(box.width >= 1);
	assert.equal(box.height, 0);
});

test("bounds are the lowest edge reached, not the last rectangle", () => {
	assert.equal(
		boundsRows([
			{ x: 0, y: 0, w: 6, h: 8 },
			{ x: 6, y: 2, w: 6, h: 2 },
		]),
		8,
	);
});

test("nothing bounds an empty group", () => {
	assert.equal(boundsRows([]), 0);
});

// --- the loop guard --------------------------------------------------------

// parent chain: c -> b -> a, and a is top level.
const chain: Record<string, string | null> = { a: null, b: "a", c: "b" };
const parentOf = (id: string) => chain[id] ?? null;

test("taking something out of a group is never a loop", () => {
	assert.equal(wouldLoop("c", null, parentOf), false);
});

test("a group cannot hold itself", () => {
	assert.equal(wouldLoop("a", "a", parentOf), true);
});

test("a group cannot be put inside what it already contains", () => {
	// a holds b holds c. Putting a inside c closes the ring.
	assert.equal(wouldLoop("a", "c", parentOf), true);
});

test("an unrelated group is a legal home", () => {
	assert.equal(wouldLoop("d", "c", parentOf), false);
});

// A chain that is already broken must not hang the check that finds it.
test("a chain that already loops terminates rather than spinning", () => {
	const ring: Record<string, string> = { x: "y", y: "x" };
	assert.equal(
		wouldLoop("new", "x", (id) => ring[id] ?? null),
		true,
	);
});
