import assert from "node:assert/strict";
import { test } from "node:test";
import {
	decodeGridParams,
	encodeGridParams,
	isEmptyGridState,
	type GridState,
} from "./gridState";

const idA = "1a2b3c4d-0000-4000-8000-000000000001";
const idB = "9f8e7d6c-0000-4000-8000-000000000002";

function roundTrip(states: Record<string, GridState>, ids: string[]) {
	return decodeGridParams(new URLSearchParams(encodeGridParams(states)), ids);
}

test("a table's choices come back from the address", () => {
	const states: Record<string, GridState> = {
		[idA]: {
			sort: { key: "Revenue", direction: "desc" },
			search: "north",
			filters: { Region: ["East", "West"] },
		},
		[idB]: { search: "other" },
	};
	assert.deepEqual(roundTrip(states, [idA, idB]), states);
});

test("the address stays readable", () => {
	const encoded = encodeGridParams({
		[idA]: { sort: { key: "Revenue", direction: "desc" } },
	});
	assert.deepEqual(encoded, [["1a2b3c4d.sort", "Revenue:desc"]]);
});

test("a value holding a comma stays one value", () => {
	const states = { [idA]: { filters: { Name: ["Smith, Jones", "Lee"] } } };
	assert.deepEqual(roundTrip(states, [idA]), states);
});

test("a matrix sort on a cell key and on its labels survives", () => {
	for (const key of ["2026||Revenue", ""]) {
		const states: Record<string, GridState> = {
			[idA]: { sort: { key, direction: "asc" } },
		};
		assert.deepEqual(roundTrip(states, [idA]), states);
	}
});

test("a parameter for a visual the page does not hold is dropped", () => {
	const params = new URLSearchParams("deadbeef.search=x&region=East");
	assert.deepEqual(decodeGridParams(params, [idA]), {});
});

test("a sort with an unknown direction is dropped", () => {
	const params = new URLSearchParams("1a2b3c4d.sort=Revenue:sideways");
	assert.deepEqual(decodeGridParams(params, [idA]), { [idA]: {} });
});

test("nothing chosen counts as empty", () => {
	assert.equal(isEmptyGridState({}), true);
	assert.equal(isEmptyGridState({ filters: { Region: [] } }), true);
	assert.equal(isEmptyGridState({ search: "x" }), false);
});
