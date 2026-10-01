import assert from "node:assert/strict";
import { test } from "node:test";
import {
	commitBatch,
	fingerprint,
	maxMessageLength,
	newTracker,
	planSave,
	saveBatchLength,
	trackStored,
	trackUnknown,
} from "./conversationSave";

interface Note {
	id: string;
	text: string;
}

const note = (id: string, text = id): Note => ({ id, text });

function saveAll(
	tracker: ReturnType<typeof newTracker>,
	title: string,
	messages: Note[],
) {
	const plan = planSave(tracker, title, messages);
	for (const batch of plan.batches) commitBatch(tracker, batch);
	return plan;
}

test("a new conversation sends every message and the title", () => {
	const tracker = newTracker();
	const messages = [note("a"), note("b")];
	const { batches } = planSave(tracker, "First", messages);
	assert.equal(batches.length, 1);
	assert.equal(batches[0].title, "First");
	assert.deepEqual(
		batches[0].messages.map((m) => m.id),
		["a", "b"],
	);
	assert.deepEqual(batches[0].removed, []);
});

test("nothing is sent when nothing changed since the last save", () => {
	const tracker = newTracker();
	const messages = [note("a"), note("b")];
	saveAll(tracker, "First", messages);
	assert.deepEqual(planSave(tracker, "First", messages).batches, []);
});

test("only messages added since the last save are sent, without the title", () => {
	const tracker = newTracker();
	const messages = [note("a"), note("b")];
	saveAll(tracker, "First", messages);
	const { batches } = planSave(tracker, "First", [...messages, note("c")]);
	assert.equal(batches.length, 1);
	assert.equal(batches[0].title, undefined);
	assert.deepEqual(
		batches[0].messages.map((m) => m.id),
		["c"],
	);
});

test("a replaced object with the same content is not sent again", () => {
	const tracker = newTracker();
	saveAll(tracker, "First", [note("a", "same")]);
	assert.deepEqual(
		planSave(tracker, "First", [note("a", "same")]).batches,
		[],
	);
});

test("a message whose content changed is sent again", () => {
	const tracker = newTracker();
	saveAll(tracker, "First", [note("a", "before")]);
	const { batches } = planSave(tracker, "First", [note("a", "after")]);
	assert.deepEqual(
		batches[0].messages.map((m) => m.text),
		["after"],
	);
});

test("messages no longer in the conversation are listed as removed", () => {
	const tracker = newTracker();
	saveAll(tracker, "First", [note("q1"), note("a1"), note("q2"), note("a2")]);
	// Asking the last question again replaces its question and answer.
	const retried = [note("q1"), note("a1"), note("q3"), note("a3")];
	const plan = saveAll(tracker, "First", retried);
	assert.deepEqual(plan.batches[0].removed.sort(), ["a2", "q2"]);
	assert.deepEqual(
		plan.batches[0].messages.map((m) => m.id),
		["q3", "a3"],
	);
	assert.deepEqual([...tracker.saved.keys()].sort(), [
		"a1",
		"a3",
		"q1",
		"q3",
	]);
});

test("a conversation read from the server is not sent back", () => {
	const messages = [note("a"), note("b")];
	const tracker = trackStored("Kept", messages);
	assert.deepEqual(planSave(tracker, "Kept", messages).batches, []);
	const copies = messages.map((m) => ({ ...m }));
	assert.deepEqual(planSave(tracker, "Kept", copies).batches, []);
});

test("messages read back from the browser are sent again and still tracked", () => {
	const messages = [note("a"), note("b")];
	const tracker = trackUnknown(messages);
	const first = planSave(tracker, "Held", messages);
	assert.equal(first.batches[0].title, "Held");
	assert.deepEqual(
		first.batches[0].messages.map((m) => m.id),
		["a", "b"],
	);
	const dropped = planSave(tracker, "Held", [note("a")]);
	assert.deepEqual(dropped.batches[0].removed, ["b"]);
});

test("a large save is split across requests in order", () => {
	const tracker = newTracker();
	const big = "x".repeat(Math.ceil(saveBatchLength / 2));
	const messages = [note("a", big), note("b", big), note("c", big)];
	const { batches } = planSave(tracker, "Long", messages);
	assert.ok(batches.length >= 2);
	assert.deepEqual(
		batches.flatMap((b) => b.messages.map((m) => m.id)),
		["a", "b", "c"],
	);
	assert.equal(batches[0].title, "Long");
	assert.equal(
		batches.slice(1).every((b) => b.title === undefined),
		true,
	);
});

test("a message too large to keep is skipped rather than stopping the save", () => {
	const tracker = newTracker();
	const huge = note("huge", "x".repeat(maxMessageLength));
	const { batches, skipped } = planSave(tracker, "Big", [
		note("a"),
		huge,
		note("b"),
	]);
	assert.deepEqual(skipped, ["huge"]);
	assert.deepEqual(
		batches.flatMap((b) => b.messages.map((m) => m.id)),
		["a", "b"],
	);
});

test("a failed batch leaves its messages to be sent next time", () => {
	const tracker = newTracker();
	const messages = [note("a"), note("b")];
	planSave(tracker, "First", messages);
	assert.equal(planSave(tracker, "First", messages).batches.length, 1);
});

test("fingerprints differ when content differs", () => {
	assert.equal(fingerprint(note("a", "x")), fingerprint(note("a", "x")));
	assert.notEqual(fingerprint(note("a", "x")), fingerprint(note("a", "y")));
});
