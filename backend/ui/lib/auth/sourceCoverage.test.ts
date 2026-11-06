import assert from "node:assert/strict";
import { test } from "node:test";
import { answerCovers } from "./sourceCoverage";

test("an answer that asked about every source covers them", () => {
	assert.equal(answerCovers(new Set(["a", "b"]), ["a", "b"]), true);
});

test("a source registered after the answer is not covered", () => {
	assert.equal(answerCovers(new Set(["a"]), ["a", "b"]), false);
});

test("a source removed since the answer does not matter", () => {
	assert.equal(answerCovers(new Set(["a", "gone"]), ["a"]), true);
});

test("an answer stored before the list existed counts as covering", () => {
	assert.equal(answerCovers(null, ["a", "b"]), true);
});
