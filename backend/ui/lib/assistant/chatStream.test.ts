import assert from "node:assert/strict";
import { test } from "node:test";
import { readChatStream } from "./chatStream";

// A stream is read in whatever pieces the network delivers, which is never the
// pieces it was written in. An event split across two reads, a tool call whose
// arguments arrive over several chunks, or a final event with no trailing
// newline each has to come out the same as if it had arrived whole.

function streamOf(pieces: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const piece of pieces)
				controller.enqueue(encoder.encode(piece));
			controller.close();
		},
	});
}

const event = (delta: unknown) =>
	`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;

test("text is handed on piece by piece and collected", async () => {
	const seen: string[] = [];
	const turn = await readChatStream(
		streamOf([
			event({ role: "assistant", content: "Gross " }),
			event({ content: "sale rose" }),
			event({ content: " 12%." }),
			"data: [DONE]\n\n",
		]),
		(d) => seen.push(d),
	);
	assert.deepEqual(seen, ["Gross ", "sale rose", " 12%."]);
	assert.equal(turn.content, "Revenue rose 12%.");
	assert.deepEqual(turn.toolCalls, []);
});

test("an event split across two reads is read once, whole", async () => {
	const whole = event({ content: "hello" });
	const turn = await readChatStream(
		streamOf([whole.slice(0, 17), whole.slice(17)]),
	);
	assert.equal(turn.content, "hello");
});

test("a tool call assembled from fragments", async () => {
	const turn = await readChatStream(
		streamOf([
			event({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "run_query", arguments: "" },
					},
				],
			}),
			event({
				tool_calls: [
					{ index: 0, function: { arguments: '{"sourceKey":' } },
				],
			}),
			event({
				tool_calls: [{ index: 0, function: { arguments: '"deals"}' } }],
			}),
			"data: [DONE]\n\n",
		]),
	);
	assert.equal(turn.toolCalls.length, 1);
	assert.equal(turn.toolCalls[0].id, "call_1");
	assert.equal(turn.toolCalls[0].function.name, "run_query");
	assert.deepEqual(JSON.parse(turn.toolCalls[0].function.arguments), {
		sourceKey: "deals",
	});
});

test("several tool calls keep their order", async () => {
	const turn = await readChatStream(
		streamOf([
			event({
				tool_calls: [
					{
						index: 1,
						id: "b",
						function: { name: "describe_source" },
					},
					{ index: 0, id: "a", function: { name: "list_sources" } },
				],
			}),
		]),
	);
	assert.deepEqual(
		turn.toolCalls.map((c) => c.function.name),
		["list_sources", "describe_source"],
	);
	// A call with no arguments at all still carries a JSON object.
	assert.equal(turn.toolCalls[0].function.arguments, "{}");
});

test("content given as typed parts is read as text", async () => {
	const turn = await readChatStream(
		streamOf([event({ content: [{ type: "text", text: "parts" }] })]),
	);
	assert.equal(turn.content, "parts");
});

test("a last event with no trailing newline is still read", async () => {
	const turn = await readChatStream(
		streamOf([
			`data: ${JSON.stringify({ choices: [{ delta: { content: "end" } }] })}`,
		]),
	);
	assert.equal(turn.content, "end");
});

test("comments, blank lines and malformed chunks are skipped", async () => {
	const turn = await readChatStream(
		streamOf([
			": keep-alive\n\n",
			"data: {not json}\n\n",
			"\r\n",
			event({ content: "ok" }),
		]),
	);
	assert.equal(turn.content, "ok");
});

test("an empty stream reads as no content and no calls", async () => {
	const turn = await readChatStream(streamOf(["data: [DONE]\n\n"]));
	assert.equal(turn.content, null);
	assert.deepEqual(turn.toolCalls, []);
});

// Captured from a Databricks Foundation Model endpoint serving Claude, with the
// usage block trimmed. Narration first, then a tool call whose arguments arrive
// empty, then the finish chunk and the terminator.
test("the stream a Databricks Claude endpoint actually sends", async () => {
	const chunk = (delta: unknown, finish: string | null = null) =>
		`data: ${JSON.stringify({
			model: "us.anthropic.claude-sonnet-5",
			choices: [{ delta, index: 0, finish_reason: finish }],
			object: "chat.completion.chunk",
		})}\n\n`;
	const seen: string[] = [];
	const turn = await readChatStream(
		streamOf([
			chunk({
				role: "assistant",
				content: "I'll look up the available dat",
			}),
			chunk({ role: "assistant", content: "asets for" }),
			chunk({ role: "assistant", content: " you." }),
			chunk({
				role: "assistant",
				content: null,
				tool_calls: [
					{
						index: 0,
						id: "toolu_bdrk_01Ebq",
						type: "function",
						function: { name: "list_sources", arguments: "" },
					},
				],
			}),
			chunk({
				role: "assistant",
				content: null,
				tool_calls: [{ index: 0, function: { arguments: "" } }],
			}),
			chunk({ role: "assistant", content: "" }, "tool_calls"),
			"data: [DONE]\n\n",
		]),
		(d) => seen.push(d),
	);
	assert.equal(turn.content, "I'll look up the available datasets for you.");
	assert.equal(seen.join(""), turn.content);
	assert.equal(turn.toolCalls.length, 1);
	assert.equal(turn.toolCalls[0].id, "toolu_bdrk_01Ebq");
	assert.equal(turn.toolCalls[0].function.name, "list_sources");
	assert.equal(turn.toolCalls[0].function.arguments, "{}");
});
