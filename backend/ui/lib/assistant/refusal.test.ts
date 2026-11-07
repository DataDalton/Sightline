import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalMessage } from "./refusal";

test("a refusal says who can fix it", () => {
	for (const status of [401, 403]) {
		assert.match(refusalMessage(status), /Ask an administrator/);
	}
});

test("no refusal repeats a status code or a technical term", () => {
	for (const status of [400, 401, 403, 404, 408, 429, 500, 503, 504]) {
		const message = refusalMessage(status);
		assert.doesNotMatch(message, /\d{3}|scope|token|endpoint|error_code/i);
	}
});

test("waiting is only suggested where waiting helps", () => {
	assert.match(refusalMessage(429), /Try again/);
	assert.match(refusalMessage(503), /Try again/);
	assert.doesNotMatch(refusalMessage(403), /Try again/);
});
