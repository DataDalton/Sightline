import assert from "node:assert/strict";
import { test } from "node:test";
import { asksToRemember } from "./memoryIntent";

test("a message asking to keep something opens the remember tool", () => {
	for (const question of [
		"Remember that I work in the East region",
		"From now on show revenue in millions",
		"Always round to one decimal place",
		"Thanks. Never use pie charts for me",
		"please always start with the total",
		"I prefer tables over charts",
		"Next time, compare against last year",
		"Don't forget I only care about Medical",
	]) {
		assert.equal(asksToRemember(question), true, question);
	}
});

test("an ordinary question about the data does not", () => {
	for (const question of [
		"What was revenue by region last quarter?",
		"Why is margin always lower in March?",
		"Which divisions never hit their target?",
		"Show me the top ten customers",
	]) {
		assert.equal(asksToRemember(question), false, question);
	}
});
