import { test } from "node:test";
import assert from "node:assert/strict";
import { shareableTranscript, transcriptText } from "./sharedLog";

const saved = [
	{
		role: "user",
		id: "u1",
		content: "Why is March low?",
		attachments: ["Revenue by region"],
	},
	{
		role: "assistant",
		id: "a1",
		question: "Why is March low?",
		activity: [
			{ type: "narration", text: "Checking the definition first." },
			{
				type: "step",
				step: {
					id: "s1",
					kind: "run_query",
					label: "Querying Sales orders",
					status: "ok",
					summary: "12 rows",
					preview: {
						columns: ["Region", "Revenue"],
						rows: [["East", "41000"]],
						total: 12,
					},
					query: {
						sourceKey: "orders",
						dimensions: ["Region"],
						measures: ["Revenue"],
						filters: [],
						rowCount: 12,
					},
				},
			},
		],
		draft: "",
		answer: "Revenue excludes cancelled orders.",
		charts: [],
		status: "done",
		heldDrafts: [{ kind: "sheet", draft: { rows: [["secret"]] } }],
	},
];

test("rows and screen drafts never leave a shared conversation", () => {
	const turns = shareableTranscript(saved);
	const textOut = JSON.stringify(turns);
	assert.equal(textOut.includes("41000"), false);
	assert.equal(textOut.includes("secret"), false);
	assert.equal(textOut.includes("preview"), false);
});

test("what was asked, answered and queried is kept", () => {
	const turns = shareableTranscript(saved);
	assert.equal(turns.length, 2);
	assert.deepEqual(turns[0], {
		role: "user",
		content: "Why is March low?",
		pointedAt: ["Revenue by region"],
	});
	const answer = turns[1];
	assert.equal(answer.role, "assistant");
	if (answer.role !== "assistant") return;
	assert.equal(answer.answer, "Revenue excludes cancelled orders.");
	assert.deepEqual(answer.steps[0].query?.measures, ["Revenue"]);
	assert.equal(answer.steps[0].query?.rowCount, 12);
	assert.match(transcriptText(turns), /Person: Why is March low\?/);
});

test("anything that is not a message is skipped", () => {
	assert.deepEqual(shareableTranscript([null, 3, { role: "system" }]), []);
});
