import assert from "node:assert/strict";
import { test } from "node:test";
import { trimToolResults } from "./rounds";

test("the oldest tool results are removed first until the conversation fits", () => {
	const big = "r".repeat(1000);
	const messages = [
		{ role: "system", content: "s".repeat(500) },
		{ role: "user", content: "question" },
		{ role: "tool", tool_call_id: "1", content: big },
		{ role: "assistant", content: "thinking" },
		{ role: "tool", tool_call_id: "2", content: big },
		{ role: "tool", tool_call_id: "3", content: big },
	];
	const out = trimToolResults(messages, 2800);
	assert.notEqual(out[2].content, big, "the oldest result goes");
	assert.equal(out[5].content, big, "the newest result stays");
	assert.equal(out[0].content, messages[0].content);
	assert.equal(out[1].content, "question");
	assert.equal(out[3].content, "thinking");
	const total = out.reduce((n, m) => n + (m.content?.length ?? 0), 0);
	assert.ok(total <= 2800);

	assert.equal(
		trimToolResults(messages, 1_000_000),
		messages,
		"a conversation under budget is returned as it is",
	);
});
