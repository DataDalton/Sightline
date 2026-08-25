import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyOperation,
	applyRemoteOps,
	type AppliedVisual,
	type RemoteOp,
} from "./applyOps";

// The property these tests protect: two sessions that receive the same ops in
// the same order end up with the same canvas. Everything else in co-editing is
// presentation; convergence is correctness.

function visual(id: string, overrides: Partial<AppliedVisual> = {}): AppliedVisual {
	return {
		visualId: id,
		visualType: "barChart",
		title: id,
		sourceKey: "sales_bookings",
		config: { dimensions: ["Division"], measures: ["Net Sales"] },
		layout: { x: 0, y: 0, w: 6, h: 4 },
		...overrides,
	};
}

function op(seq: number, originId: string | null, operations: unknown[]): RemoteOp {
	return {
		seq,
		actor: `user${seq}@example.com`,
		originId,
		op: { version: seq, operations: operations as never },
	};
}

test("an insert applies with the id the author generated", () => {
	const result = applyOperation([], {
		type: "addVisual",
		visualId: "v1",
		pageId: "p1",
		visualType: "pieChart",
		title: "Mix",
		sourceKey: "sales_bookings",
		layout: { x: 2, y: 3, w: 4, h: 5 },
	});

	assert.equal(result.visuals.length, 1);
	assert.equal(result.visuals[0].visualId, "v1");
	assert.deepEqual(result.visuals[0].layout, { x: 2, y: 3, w: 4, h: 5 });
});

test("applying the same insert twice does not duplicate", () => {
	// A session that reconnects can be handed an op it already applied.
	const once = applyOperation([], {
		type: "addVisual",
		visualId: "v1",
		pageId: "p1",
		visualType: "pieChart",
	});
	const twice = applyOperation(once.visuals, {
		type: "addVisual",
		visualId: "v1",
		pageId: "p1",
		visualType: "pieChart",
	});

	assert.equal(twice.visuals.length, 1);
});

test("an insert with no id is ignored rather than guessed at", () => {
	const result = applyOperation([], {
		type: "addVisual",
		pageId: "p1",
		visualType: "pieChart",
	});
	assert.equal(result.visuals.length, 0);
});

test("an update changes only the fields the op carries", () => {
	const before = [visual("v1", { title: "Original" })];
	const result = applyOperation(before, {
		type: "updateVisual",
		visualId: "v1",
		layout: { x: 6, y: 0, w: 6, h: 4 },
	});

	assert.equal(result.visuals[0].layout.x, 6);
	// The title was not in the op, so it survives.
	assert.equal(result.visuals[0].title, "Original");
	assert.deepEqual(result.visuals[0].config, before[0].config);
});

test("a visual being dragged locally is not moved out from under the author", () => {
	const before = [visual("v1")];
	const result = applyOperation(
		before,
		{
			type: "updateVisual",
			visualId: "v1",
			layout: { x: 9, y: 9, w: 3, h: 3 },
		},
		{ protectedIds: new Set(["v1"]) },
	);

	assert.deepEqual(result.visuals[0].layout, { x: 0, y: 0, w: 6, h: 4 });
	assert.deepEqual(result.deferred, ["v1"]);
});

test("a removal applies even to a visual being edited locally", () => {
	// There is nothing left to protect, and keeping a ghost would fail on the
	// next save.
	const result = applyOperation(
		[visual("v1")],
		{ type: "removeVisual", visualId: "v1" },
		{ protectedIds: new Set(["v1"]) },
	);
	assert.equal(result.visuals.length, 0);
});

test("this session skips its own ops but still advances the version", () => {
	const before = [visual("v1", { title: "Local edit" })];
	const result = applyRemoteOps(
		before,
		[
			op(5, "me", [
				{ type: "updateVisual", visualId: "v1", title: "Echo" },
			]),
		],
		"me",
		4,
	);

	// The echo did not overwrite the local title.
	assert.equal(result.visuals[0].title, "Local edit");
	// The version still moved, so the next save is not stale.
	assert.equal(result.version, 5);
	assert.deepEqual(result.actors, []);
});

test("ops apply in sequence order regardless of arrival order", () => {
	const before = [visual("v1")];
	// Delivered out of order, as a retry or a slow poll can produce.
	const result = applyRemoteOps(
		before,
		[
			op(3, "them", [
				{ type: "updateVisual", visualId: "v1", title: "Third" },
			]),
			op(1, "them", [
				{ type: "updateVisual", visualId: "v1", title: "First" },
			]),
			op(2, "them", [
				{ type: "updateVisual", visualId: "v1", title: "Second" },
			]),
		],
		"me",
		0,
	);

	// The highest sequence wins, not the last one that happened to arrive.
	assert.equal(result.visuals[0].title, "Third");
	assert.equal(result.seq, 3);
});

test("two sessions receiving the same ops converge", () => {
	// The property the whole design rests on.
	const start = [visual("v1"), visual("v2")];
	const ops = [
		op(1, "alice", [
			{ type: "updateVisual", visualId: "v1", layout: { x: 6, y: 0, w: 6, h: 4 } },
		]),
		op(2, "bob", [
			{
				type: "addVisual",
				visualId: "v3",
				pageId: "p1",
				visualType: "donutChart",
				title: "New",
			},
		]),
		op(3, "alice", [{ type: "removeVisual", visualId: "v2" }]),
	];

	const sessionA = applyRemoteOps(start, ops, "carol", 0);
	// The other session receives them shuffled.
	const sessionB = applyRemoteOps(start, [ops[2], ops[0], ops[1]], "dave", 0);

	assert.deepEqual(
		sessionA.visuals.map((v) => v.visualId).sort(),
		sessionB.visuals.map((v) => v.visualId).sort(),
	);
	assert.deepEqual(sessionA.visuals, sessionB.visuals);
	assert.equal(sessionA.version, sessionB.version);
});

test("the later of two edits to the same field wins", () => {
	// Last-writer-wins is the model. Merging two positions into a third that
	// neither author chose would be worse than picking one.
	const result = applyRemoteOps(
		[visual("v1")],
		[
			op(1, "alice", [
				{ type: "updateVisual", visualId: "v1", layout: { x: 1, y: 1, w: 6, h: 4 } },
			]),
			op(2, "bob", [
				{ type: "updateVisual", visualId: "v1", layout: { x: 8, y: 2, w: 4, h: 3 } },
			]),
		],
		"me",
		0,
	);

	assert.deepEqual(result.visuals[0].layout, { x: 8, y: 2, w: 4, h: 3 });
});

test("edits to different visuals both survive", () => {
	// The common case: two people working on different parts of a page.
	const result = applyRemoteOps(
		[visual("v1"), visual("v2")],
		[
			op(1, "alice", [
				{ type: "updateVisual", visualId: "v1", title: "Alice edited" },
			]),
			op(2, "bob", [
				{ type: "updateVisual", visualId: "v2", title: "Bob edited" },
			]),
		],
		"me",
		0,
	);

	assert.equal(result.visuals[0].title, "Alice edited");
	assert.equal(result.visuals[1].title, "Bob edited");
	assert.deepEqual(result.actors.sort(), ["alice", "bob"].map(
		(_, i) => `user${i + 1}@example.com`,
	));
});

test("reordering follows the order the op names", () => {
	const result = applyOperation(
		[visual("a"), visual("b"), visual("c")],
		{ type: "reorderVisuals", pageId: "p1", visualIds: ["c", "a", "b"] },
	);
	assert.deepEqual(
		result.visuals.map((v) => v.visualId),
		["c", "a", "b"],
	);
});
