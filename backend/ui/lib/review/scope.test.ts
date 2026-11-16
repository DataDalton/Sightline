import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeAllows, scopeEmails } from "./scope";

const conversation = {
	id: "c1",
	owners: ["sam@example.com", "lee@example.com"],
	createdOn: "2026-11-05T10:00:00Z",
};

test("a grant for one conversation reaches only that one", () => {
	assert.equal(
		scopeAllows({ kind: "conversation", id: "c1" }, conversation),
		true,
	);
	assert.equal(
		scopeAllows({ kind: "conversation", id: "c2" }, conversation),
		false,
	);
});

test("a grant for a person reaches what they own or are in, within its dates", () => {
	assert.equal(
		scopeAllows({ kind: "person", email: "Lee@Example.com" }, conversation),
		true,
	);
	assert.equal(
		scopeAllows({ kind: "person", email: "kim@example.com" }, conversation),
		false,
	);
	assert.equal(
		scopeAllows(
			{ kind: "person", email: "sam@example.com", from: "2026-11-06" },
			conversation,
		),
		false,
	);
});

test("a grant for everyone keeps to its dates, both ends included", () => {
	assert.equal(
		scopeAllows(
			{ kind: "everyone", from: "2026-11-05", to: "2026-11-05" },
			conversation,
		),
		true,
	);
	assert.equal(
		scopeAllows({ kind: "everyone", to: "2026-11-04" }, conversation),
		false,
	);
	assert.equal(scopeAllows({ kind: "everyone" }, conversation), true);
});

test("chosen people reach a conversation any one of them is in", () => {
	const conversation = {
		id: "c1",
		owners: ["sam@example.com", "lee@example.com"],
		createdOn: "2026-11-05T10:00:00Z",
	};
	assert.equal(
		scopeAllows(
			{ kind: "people", emails: ["Kim@example.com", "LEE@example.com"] },
			conversation,
		),
		true,
	);
	assert.equal(
		scopeAllows(
			{ kind: "people", emails: ["kim@example.com"] },
			conversation,
		),
		false,
	);
	assert.equal(
		scopeAllows(
			{
				kind: "people",
				emails: ["sam@example.com"],
				to: "2026-11-04",
			},
			conversation,
		),
		false,
	);
});

test("a scope names its people in lower case", () => {
	assert.deepEqual(
		scopeEmails({ kind: "person", email: "Sam@Example.com" }),
		["sam@example.com"],
	);
	assert.deepEqual(scopeEmails({ kind: "everyone" }), []);
});
