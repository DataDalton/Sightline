import { test } from "node:test";
import assert from "node:assert/strict";
import { peerUsage, rankByPeers } from "./peerRanking";

test("ranks by distinct readers before opens", () => {
	const usage = peerUsage([
		{ reportId: "a", email: "x@corp", opens: 40 },
		{ reportId: "b", email: "x@corp", opens: 1 },
		{ reportId: "b", email: "y@corp", opens: 1 },
	]);
	assert.deepEqual(rankByPeers(usage, "me@corp", 10), ["b", "a"]);
});

test("leaves the reader's own opens out", () => {
	const usage = peerUsage([
		{ reportId: "a", email: "me@corp", opens: 50 },
		{ reportId: "a", email: "x@corp", opens: 1 },
		{ reportId: "b", email: "x@corp", opens: 2 },
		{ reportId: "c", email: "me@corp", opens: 9 },
	]);
	// a has one other reader with one open, b one with two, c only the reader.
	assert.deepEqual(rankByPeers(usage, "ME@corp", 10), ["b", "a"]);
});

test("adds rows for the same reader and report together", () => {
	const usage = peerUsage([
		{ reportId: "a", email: "x@corp", opens: 1 },
		{ reportId: "a", email: "x@corp", opens: 2 },
	]);
	assert.equal(usage.get("a")?.get("x@corp"), 3);
});

test("stops at the limit", () => {
	const usage = peerUsage([
		{ reportId: "a", email: "x@corp", opens: 3 },
		{ reportId: "b", email: "x@corp", opens: 2 },
		{ reportId: "c", email: "x@corp", opens: 1 },
	]);
	assert.deepEqual(rankByPeers(usage, "me@corp", 2), ["a", "b"]);
});
