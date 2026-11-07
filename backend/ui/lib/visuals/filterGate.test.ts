import assert from "node:assert/strict";
import { test } from "node:test";
import { requiredFields, waitingFor } from "./filterGate";

test("a visual with nothing required draws", () => {
	assert.deepEqual(requiredFields("table", undefined, undefined), []);
	assert.deepEqual(waitingFor([], []), []);
});

test("a visual waits for its own fields and its page's", () => {
	assert.deepEqual(
		requiredFields(
			"table",
			{ requireFilter: ["Customer"] },
			{ requireFilter: ["Region", "Customer"] },
		),
		["Region", "Customer"],
	);
});

test("a filter control never waits, since it is how the reader answers", () => {
	assert.deepEqual(
		requiredFields("dropdownFilter", undefined, {
			requireFilter: ["Region"],
		}),
		[],
	);
});

test("a field with a value stops holding the visual back", () => {
	const required = ["Customer", "Region"];
	assert.deepEqual(waitingFor(required, []), required);
	assert.deepEqual(
		waitingFor(required, [
			{ field: "Customer", op: "eq", values: ["Acme"] },
		]),
		["Region"],
	);
	assert.deepEqual(
		waitingFor(required, [
			{ field: "Customer", op: "eq", values: ["Acme"] },
			{ field: "Region", op: "contains", value: "north" },
		]),
		[],
	);
});

test("an empty value does not count as choosing", () => {
	assert.deepEqual(
		waitingFor(["Customer"], [{ field: "Customer", op: "eq", values: [] }]),
		["Customer"],
	);
	assert.deepEqual(
		waitingFor(["Customer"], [{ field: "Customer", op: "eq", value: "" }]),
		["Customer"],
	);
});

test("asking for blanks or the newest value counts as choosing", () => {
	assert.deepEqual(
		waitingFor(["Customer"], [{ field: "Customer", op: "is_empty" }]),
		[],
	);
	assert.deepEqual(
		waitingFor(["Year"], [{ field: "Year", op: "is_latest" }]),
		[],
	);
});
