import assert from "node:assert/strict";
import { test } from "node:test";
import { textOf, wordDiff, type Piece } from "./wordDiff";

// The point of a word diff is that the two sides still read as the sentences
// they are. These pin that: joining the pieces back up returns the text, only
// the words that moved are marked, and the words that did not are left alone.

const join = (pieces: Piece[]) => pieces.map((p) => p.text).join("");
const marked = (pieces: Piece[], state: string) =>
	pieces
		.filter((p) => p.state === state)
		.map((p) => p.text.trim())
		.filter((t) => t !== "");

test("the pieces joined back up are the text again", () => {
	const before = "Excludes freight and handling charges.";
	const after = "Excludes freight, handling and tax charges.";
	const diff = wordDiff(before, after);

	assert.equal(join(diff.before), before);
	assert.equal(join(diff.after), after);
});

test("only the words that moved are marked", () => {
	const diff = wordDiff(
		"Net sales excluding freight",
		"Net sales excluding freight and tax",
	);

	assert.deepEqual(marked(diff.before, "gone"), []);
	assert.deepEqual(marked(diff.after, "new"), ["and tax"]);
	assert.equal(diff.changed, true);
});

test("a removed word is marked on the older side only", () => {
	const diff = wordDiff("Sales for the quarter", "Sales for the year");

	assert.deepEqual(marked(diff.before, "gone"), ["quarter"]);
	assert.deepEqual(marked(diff.after, "new"), ["year"]);
});

test("text that did not change is reported as unchanged", () => {
	const diff = wordDiff("Same either way", "Same either way");
	assert.equal(diff.changed, false);
	assert.deepEqual(marked(diff.before, "gone"), []);
	assert.deepEqual(marked(diff.after, "new"), []);
});

test("an empty side is the whole of the other side arriving", () => {
	const diff = wordDiff("", "A note that was not there before");
	assert.equal(diff.changed, true);
	assert.deepEqual(diff.before, []);
	assert.equal(diff.after.length, 1);
	assert.equal(diff.after[0].state, "new");
});

test("an empty side is the whole of the other side going", () => {
	const diff = wordDiff("A note that has been taken away", "");
	assert.equal(diff.before.length, 1);
	assert.equal(diff.before[0].state, "gone");
	assert.deepEqual(diff.after, []);
});

test("a word moved within the sentence is not reported as untouched", () => {
	const diff = wordDiff("freight and handling", "handling and freight");
	assert.equal(diff.changed, true);
	assert.notDeepEqual(marked(diff.before, "gone"), []);
});

test("runs of the same state come back as one piece rather than one per word", () => {
	const diff = wordDiff("a b c", "a b c d e f");
	const added = diff.after.filter((p) => p.state === "new");
	assert.equal(added.length, 1);
	assert.equal(added[0].text.trim(), "d e f");
});

test("markup is not what gets compared", () => {
	assert.equal(
		textOf("<p>Excludes <strong>freight</strong> charges.</p>"),
		"Excludes freight charges.",
	);
});

test("a block end keeps the words on either side of it apart", () => {
	assert.equal(textOf("<p>First</p><p>Second</p>"), "First Second");
	assert.equal(textOf("One<br>Two"), "One Two");
});

test("entities that stand for text become the text", () => {
	assert.equal(
		textOf("Sales &amp; margin&nbsp;detail"),
		"Sales & margin detail",
	);
});

test("comparing two text panels compares what they say, not how they say it", () => {
	const diff = wordDiff(
		textOf("<p>Excludes <em>freight</em>.</p>"),
		textOf("<p>Excludes <strong>freight</strong>.</p>"),
	);
	assert.equal(diff.changed, false);
});
