import assert from "node:assert/strict";
import { test } from "node:test";
import { batchedRead } from "./batch";

test("keys asked in the same turn are answered by one load", async () => {
	const loads: string[][] = [];
	const read = batchedRead<string, number>(
		async (keys) => {
			loads.push(keys);
			return new Map(keys.map((k) => [k, k.length]));
		},
		(k) => k,
		-1,
	);
	const answers = await Promise.all([read("a"), read("bb"), read("ccc")]);
	assert.deepEqual(answers, [1, 2, 3]);
	assert.equal(loads.length, 1);
	assert.deepEqual(loads[0], ["a", "bb", "ccc"]);
});

test("the same key asked twice is loaded once and answers both", async () => {
	const loads: string[][] = [];
	const read = batchedRead<string, string>(
		async (keys) => {
			loads.push(keys);
			return new Map(keys.map((k) => [k, k.toUpperCase()]));
		},
		(k) => k,
		"",
	);
	assert.deepEqual(await Promise.all([read("x"), read("x")]), ["X", "X"]);
	assert.deepEqual(loads, [["x"]]);
});

test("a key the load leaves out answers the fallback", async () => {
	const read = batchedRead<string, string | null>(
		async () => new Map([["known", "yes"]]),
		(k) => k,
		null,
	);
	assert.deepEqual(await Promise.all([read("known"), read("missing")]), [
		"yes",
		null,
	]);
});

test("a failed load rejects every caller in its batch, and the next batch loads again", async () => {
	let fail = true;
	const read = batchedRead<string, string>(
		async (keys) => {
			if (fail) throw new Error("no connection");
			return new Map(keys.map((k) => [k, k]));
		},
		(k) => k,
		"",
	);
	const failed = await Promise.allSettled([read("a"), read("b")]);
	assert.deepEqual(
		failed.map((r) => r.status),
		["rejected", "rejected"],
	);
	fail = false;
	assert.equal(await read("a"), "a");
});

test("keys asked in different turns are loaded separately", async () => {
	const loads: string[][] = [];
	const read = batchedRead<string, string>(
		async (keys) => {
			loads.push(keys);
			return new Map(keys.map((k) => [k, k]));
		},
		(k) => k,
		"",
	);
	await read("first");
	await read("second");
	assert.deepEqual(loads, [["first"], ["second"]]);
});
