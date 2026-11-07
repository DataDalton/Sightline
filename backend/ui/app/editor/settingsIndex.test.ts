import { test } from "node:test";
import assert from "node:assert/strict";
import { editorSettings, rankSettings } from "./settingsIndex";

test("nothing typed finds nothing", () => {
	assert.deepEqual(rankSettings("  "), []);
});

test("a word someone might use finds a setting named differently", () => {
	assert.ok(
		rankSettings("legend").some(
			(held) => held.section === "visual-display",
		),
	);
	assert.ok(rankSettings("theme")[0].label === "Report theme");
});

test("a name's start ranks ahead of a match elsewhere", () => {
	assert.equal(
		rankSettings("page")[0].label.toLowerCase().startsWith("page"),
		true,
	);
});

test("every setting says where it lives", () => {
	for (const setting of editorSettings) {
		assert.ok(setting.where && setting.panel && setting.words);
	}
});
