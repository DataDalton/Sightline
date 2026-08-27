import assert from "node:assert/strict";
import { test } from "node:test";
import { opsForRestore, type RestoreOp } from "./undo";

// The failures worth pinning are the two that write the wrong thing to the
// server rather than merely looking wrong on screen: undoing the creation of a
// visual must not delete a row that was never written, and putting back a
// visual the server still holds must not insert a second copy of it.

const saved = (id: string) => ({ visualId: id });
const fresh = (id: string) => ({ visualId: id, isNew: true });

function find(ops: RestoreOp[], id: string): RestoreOp | undefined {
	return ops.find((op) => op.visualId === id);
}

test("nothing changed means every visual is rewritten and nothing else", () => {
	const ops = opsForRestore(
		[saved("a"), saved("b")],
		[saved("a"), saved("b")],
	);
	assert.deepEqual(
		ops.map((op) => op.kind),
		["update", "update"],
	);
});

test("undoing a delete of a saved visual cancels the delete", () => {
	// It was on the page, was removed, and undo puts it back. The server never
	// heard about the removal, so the pending operation simply goes away.
	const ops = opsForRestore([saved("a")], [saved("a"), saved("b")]);
	assert.deepEqual(find(ops, "b"), { kind: "cancel", visualId: "b" });
});

test("undoing a delete does not insert a second copy", () => {
	const ops = opsForRestore([saved("a")], [saved("a"), saved("b")]);
	assert.equal(
		ops.some((op) => op.kind === "add"),
		false,
	);
});

test("undoing the creation of a visual cancels the insert", () => {
	// Created in this session, then undone. There is no row to delete.
	const ops = opsForRestore([saved("a"), fresh("new")], [saved("a")]);
	assert.deepEqual(find(ops, "new"), { kind: "cancel", visualId: "new" });
});

test("undoing a creation does not send a delete", () => {
	const ops = opsForRestore([saved("a"), fresh("new")], [saved("a")]);
	assert.equal(
		ops.some((op) => op.kind === "remove"),
		false,
	);
});

test("redoing a creation inserts it again", () => {
	// The other direction: the unsaved visual comes back, and it has to be
	// written because the server has still never seen it.
	const ops = opsForRestore([saved("a")], [saved("a"), fresh("new")]);
	assert.deepEqual(find(ops, "new"), { kind: "add", visualId: "new" });
});

test("removing a saved visual sends a delete", () => {
	const ops = opsForRestore([saved("a"), saved("b")], [saved("a")]);
	assert.deepEqual(find(ops, "b"), { kind: "remove", visualId: "b" });
});

test("a visual on both sides is updated, never added twice", () => {
	const ops = opsForRestore([saved("a")], [saved("a")]);
	assert.deepEqual(ops, [{ kind: "update", visualId: "a" }]);
});

test("every visual in either state is accounted for exactly once", () => {
	const ops = opsForRestore(
		[saved("a"), saved("b"), fresh("c")],
		[saved("a"), saved("d"), fresh("e")],
	);
	const ids = ops.map((op) => op.visualId).sort();
	assert.deepEqual(ids, ["a", "b", "c", "d", "e"]);
	assert.equal(new Set(ids).size, ids.length, "a visual got two operations");
});

test("an empty page restores to an empty page without operations", () => {
	assert.deepEqual(opsForRestore([], []), []);
});
