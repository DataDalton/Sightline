import assert from "node:assert/strict";
import { test } from "node:test";
import { canSee, cleanText, peopleToTell, pickRecipients } from "./rules";

const contacts = [
	{ kind: "person" as const, id: "alex.kim@example.com", name: "Alex Kim" },
	{
		kind: "group" as const,
		id: "Finance Analysts",
		name: "Finance Analysts",
	},
];

test("a person named in a conversation can see it, whatever the case", () => {
	assert.equal(
		canSee(
			[{ type: "user", id: "alex.kim@example.com" }],
			"Alex.Kim@example.com",
			[],
		),
		true,
	);
});

test("a group member can see a conversation sent to the group", () => {
	const members = [{ type: "group" as const, id: "Finance Analysts" }];
	assert.equal(
		canSee(members, "sam@example.com", ["Finance Analysts"]),
		true,
	);
	assert.equal(canSee(members, "sam@example.com", ["Other"]), false);
});

test("a group name is not mistaken for an address", () => {
	assert.equal(
		canSee(
			[{ type: "group", id: "sam@example.com" }],
			"sam@example.com",
			[],
		),
		false,
	);
});

test("recipients are narrowed to the maintainers asked for", () => {
	assert.deepEqual(
		pickRecipients(contacts, [{ type: "group", id: "Finance Analysts" }]),
		[{ type: "group", id: "Finance Analysts" }],
	);
});

test("somebody who is not a maintainer cannot be written to", () => {
	assert.deepEqual(
		pickRecipients(contacts, [{ type: "user", id: "ceo@example.com" }]),
		[
			{ type: "user", id: "alex.kim@example.com" },
			{ type: "group", id: "Finance Analysts" },
		],
	);
});

test("asking for nobody in particular goes to every maintainer", () => {
	assert.equal(pickRecipients(contacts, undefined).length, 2);
	assert.equal(pickRecipients(contacts, "everyone").length, 2);
});

test("text is trimmed, capped, and refused when empty", () => {
	assert.equal(cleanText("  hi  ", 10), "hi");
	assert.equal(cleanText("abcdef", 3), "abc");
	assert.equal(cleanText("   ", 10), null);
	assert.equal(cleanText(42, 10), null);
});

test("the author is not told about their own message", () => {
	assert.deepEqual(
		peopleToTell(
			[
				{ type: "user", id: "alex@example.com" },
				{ type: "group", id: "Team" },
			],
			{ Team: ["sam@example.com", "Alex@example.com"] },
			"alex@example.com",
		),
		["sam@example.com"],
	);
});

test("an empty group tells nobody", () => {
	assert.deepEqual(
		peopleToTell([{ type: "group", id: "Quiet" }], {}, "a@example.com"),
		[],
	);
});
