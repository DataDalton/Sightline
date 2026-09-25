import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantEvent } from "./events";
import { applyEvent, type Message } from "./transcript";

type Answer = Extract<Message, { role: "assistant" }>;

const fresh = (): Answer => ({
	role: "assistant",
	id: "a",
	question: "q",
	activity: [],
	draft: "",
	answer: "",
	charts: [],
	status: "streaming",
	startedAt: 0,
});

const play = (events: AssistantEvent[]): Answer =>
	events.reduce((m, e, i) => applyEvent(m, e, i + 1), fresh());

test("text with no step after it is the answer", () => {
	const m = play([
		{ type: "text", delta: "Sales " },
		{ type: "text", delta: "rose." },
		{ type: "done", ranAs: "app" },
	]);
	assert.equal(m.answer, "Sales rose.");
	assert.equal(m.draft, "");
	assert.equal(m.status, "done");
	assert.deepEqual(m.activity, []);
});

// The rule the whole view depends on. What the model says before a step is it
// thinking out loud, and belongs with the working rather than in the answer.
test("text before a step becomes narration, not answer", () => {
	const m = play([
		{ type: "text", delta: "Checking the orders data." },
		{ type: "step", id: "1", kind: "describe_source", label: "Reading" },
		{ type: "stepDone", id: "1", ok: true, summary: "107 fields" },
		{ type: "text", delta: "Revenue is up." },
		{ type: "done", ranAs: "caller" },
	]);
	assert.deepEqual(
		m.activity.map((a) => a.type),
		["narration", "step"],
	);
	assert.equal(
		m.activity[0].type === "narration" && m.activity[0].text,
		"Checking the orders data.",
	);
	assert.equal(m.answer, "Revenue is up.");
	assert.equal(m.ranAs, "caller");
});

test("a step goes from running to done with its result and timing", () => {
	const m = play([
		{ type: "step", id: "q", kind: "run_query", label: "Querying" },
		{
			type: "stepDone",
			id: "q",
			ok: true,
			summary: "12 rows",
			preview: { columns: ["A"], rows: [["1"]], total: 12 },
		},
	]);
	const step = m.activity[0].type === "step" ? m.activity[0].step : null;
	assert.equal(step?.status, "ok");
	assert.equal(step?.summary, "12 rows");
	assert.equal(step?.preview?.total, 12);
	assert.equal(step?.startedAt, 1);
	assert.equal(step?.finishedAt, 2);
});

test("steps running side by side finish independently", () => {
	const m = play([
		{ type: "step", id: "a", kind: "run_query", label: "A" },
		{ type: "step", id: "b", kind: "run_query", label: "B" },
		{ type: "stepDone", id: "b", ok: false, summary: "refused" },
	]);
	const status = m.activity.map((a) =>
		a.type === "step" ? a.step.status : "",
	);
	assert.deepEqual(status, ["running", "failed"]);
});

test("empty text before a step leaves no empty narration", () => {
	const m = play([
		{ type: "text", delta: "  \n" },
		{ type: "step", id: "1", kind: "list_sources", label: "Looking" },
	]);
	assert.deepEqual(
		m.activity.map((a) => a.type),
		["step"],
	);
});

test("an error keeps what was written so far", () => {
	const m = play([
		{ type: "text", delta: "Partly there" },
		{ type: "error", message: "The endpoint answered 500" },
	]);
	assert.equal(m.status, "error");
	assert.equal(m.error, "The endpoint answered 500");
	assert.equal(m.answer, "Partly there");
});

test("charts are collected in the order they arrive", () => {
	const chart = (title: string) => ({
		sourceKey: "s",
		dimensions: [],
		measures: ["M"],
		filters: [],
		sort: [],
		limit: 10,
		visualType: "barChart",
		title,
	});
	const m = play([
		{ type: "chart", chart: chart("one") },
		{ type: "chart", chart: chart("two") },
	]);
	assert.deepEqual(
		m.charts.map((c) => c.title),
		["one", "two"],
	);
});
