import { test } from "node:test";
import assert from "node:assert/strict";
import { displayNameFromEmail } from "./names";

test("a name is read from the address, without a directory's numbers", () => {
	assert.equal(displayNameFromEmail("jane.doe@example.com"), "Jane Doe");
	assert.equal(displayNameFromEmail("pat.morgan1@example.com"), "Pat Morgan");
	assert.equal(displayNameFromEmail("sam_lee-22@example.com"), "Sam Lee");
});

test("an address made only of digits keeps them", () => {
	assert.equal(displayNameFromEmail("12345@example.com"), "12345");
});
