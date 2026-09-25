import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanState, decodeState, encodeState } from "./state";

// An exploration travels through two places anybody can edit, the address bar
// and a stored row, so what comes back has to be exactly what went in when it
// is genuine and harmless when it is not.

const state = {
	sourceKey: "sales",
	columns: ["Division", "Revenue"],
	conditions: [
		{
			field: "Region",
			op: "eq" as const,
			value: "West",
			negate: false,
			join: "and" as const,
		},
		{
			field: "Division",
			op: "eq" as const,
			values: ["Hardware", "Software"],
			negate: true,
			join: "or" as const,
		},
	],
};

test("a state survives the trip through the address", () => {
	assert.deepEqual(decodeState(encodeState(state)), state);
});

test("names and values outside ASCII survive too", () => {
	const unusual = {
		...state,
		conditions: [
			{
				field: "Région",
				op: "eq" as const,
				value: "Zürich — Nord",
				negate: false,
				join: "and" as const,
			},
		],
	};
	assert.deepEqual(decodeState(encodeState(unusual)), unusual);
});

test("the encoding is safe to put in an address unescaped", () => {
	assert.match(encodeState(state), /^[A-Za-z0-9_-]+$/);
});

test("a mangled link reads as nothing rather than throwing", () => {
	for (const bad of [
		"",
		"not base64!!",
		"e30",
		encodeState(state).slice(0, 10),
	]) {
		assert.equal(decodeState(bad), null, bad);
	}
});

test("an unknown operator drops the condition, not the view", () => {
	const cleaned = cleanState({
		...state,
		conditions: [
			{ field: "Region", op: "drop table", value: "x" },
			...state.conditions,
		],
	});
	assert.equal(cleaned?.conditions.length, 2);
});

test("duplicate columns are kept once, in order", () => {
	const cleaned = cleanState({
		sourceKey: "s",
		columns: ["A", "B", "A", 7, null, "C"],
		conditions: [],
	});
	assert.deepEqual(cleaned?.columns, ["A", "B", "C"]);
});

test("a state with no dataset is not a state", () => {
	assert.equal(cleanState({ columns: ["A"] }), null);
	assert.equal(cleanState(null), null);
	assert.equal(cleanState([]), null);
});

test("anything other than true is not a negation, and join defaults to and", () => {
	const cleaned = cleanState({
		sourceKey: "s",
		columns: [],
		conditions: [
			{ field: "A", op: "eq", value: "1", negate: "yes", join: "xor" },
		],
	});
	assert.equal(cleaned?.conditions[0].negate, false);
	assert.equal(cleaned?.conditions[0].join, "and");
});
