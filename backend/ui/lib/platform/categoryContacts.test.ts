import assert from "node:assert/strict";
import { test } from "node:test";
import { toContacts } from "./categoryContacts";

test("people come before groups, each in name order", () => {
	const contacts = toContacts([
		{ subject_type: "group", subject_id: "Finance Analysts" },
		{ subject_type: "user", subject_id: "sam.lee@example.com" },
		{ subject_type: "user", subject_id: "alex.kim@example.com" },
	]);
	assert.deepEqual(
		contacts.map((c) => c.name),
		["Alex Kim", "Sam Lee", "Finance Analysts"],
	);
});

test("an address held twice is listed once, whatever its case", () => {
	const contacts = toContacts([
		{ subject_type: "user", subject_id: "Alex.Kim@example.com" },
		{ subject_type: "user", subject_id: "alex.kim@example.com" },
	]);
	assert.equal(contacts.length, 1);
	assert.equal(contacts[0].id, "alex.kim@example.com");
});

test("a person and a group of the same name are both kept", () => {
	const contacts = toContacts([
		{ subject_type: "user", subject_id: "ops@example.com" },
		{ subject_type: "group", subject_id: "ops@example.com" },
	]);
	assert.deepEqual(
		contacts.map((c) => c.kind),
		["person", "group"],
	);
});
