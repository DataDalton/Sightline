import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProposal, ProposalRejected } from "./spec";
import type { SemanticField, SemanticSource } from "../semantic/types";

// The property these tests exist to protect: nothing a model writes reaches the
// warehouse unchecked. A field it invented, a chart that cannot hold what it
// asked for, or a reply that is not a query at all is a refusal, because the
// failure that matters is not a crash. It is a plausible wrong field producing
// a confident wrong number nobody queries.

const field = (name: string, kind: "dimension" | "measure"): SemanticField => ({
	fieldId: name,
	sourceKey: "orders",
	name,
	displayName: null,
	kind,
	sqlExpr: null,
	dataType: kind === "measure" ? "DECIMAL(38,6)" : "STRING",
	description: null,
	formatHint: null,
	tags: {},
	folder: null,
	sortOrder: 0,
	isDefault: false,
});

const source: SemanticSource = {
	sourceKey: "orders",
	title: "Orders",
	description: null,
	catalog: "c",
	schema: "s",
	object: "orders",
	kind: "metric_view",
	accessMode: "direct",
	hasRowFilter: true,
	cacheTtlSeconds: 0,
	defaultTimeField: null,
	dimensions: [field("Division", "dimension"), field("Region", "dimension")],
	measures: [field("Revenue", "measure"), field("Order Count", "measure")],
};

const reply = (body: unknown) => JSON.stringify(body);

test("a well formed proposal is accepted", () => {
	const p = parseProposal(
		reply({
			dimensions: ["Division"],
			measures: ["Revenue"],
			sort: [{ field: "Revenue", direction: "desc" }],
			limit: 10,
			visualType: "barChart",
			note: "Sales by division",
		}),
		source,
	);
	assert.equal(p.sourceKey, "orders");
	assert.deepEqual(p.dimensions, ["Division"]);
	assert.deepEqual(p.measures, ["Revenue"]);
	assert.equal(p.limit, 10);
	assert.equal(p.visualType, "barChart");
});

test("a field the source does not have is refused", () => {
	assert.throws(
		() =>
			parseProposal(
				reply({
					dimensions: ["Territory"],
					measures: ["Revenue"],
					visualType: "barChart",
				}),
				source,
			),
		(error: Error) =>
			error instanceof ProposalRejected &&
			error.message.includes("Territory"),
	);
});

// The one that produces a wrong number rather than an error: a measure used as
// a grouping key changes what every figure beside it counts.
test("a measure asked for as a dimension is refused", () => {
	assert.throws(
		() =>
			parseProposal(
				reply({
					dimensions: ["Revenue"],
					measures: ["Order Count"],
					visualType: "barChart",
				}),
				source,
			),
		(error: Error) =>
			error instanceof ProposalRejected &&
			error.message.includes("is a measure"),
	);
});

test("a dimension asked for as a measure is refused", () => {
	assert.throws(
		() =>
			parseProposal(
				reply({
					dimensions: [],
					measures: ["Division"],
					visualType: "table",
				}),
				source,
			),
		ProposalRejected,
	);
});

test("an unknown filter field is refused", () => {
	assert.throws(
		() =>
			parseProposal(
				reply({
					dimensions: ["Division"],
					measures: ["Revenue"],
					filters: [{ field: "Made Up", op: "eq", value: "x" }],
					visualType: "barChart",
				}),
				source,
			),
		ProposalRejected,
	);
});

test("an unknown sort field is refused", () => {
	assert.throws(
		() =>
			parseProposal(
				reply({
					dimensions: ["Division"],
					measures: ["Revenue"],
					sort: [{ field: "Nope", direction: "desc" }],
					visualType: "barChart",
				}),
				source,
			),
		ProposalRejected,
	);
});

test("a visual type outside the catalogue is refused", () => {
	assert.throws(
		() =>
			parseProposal(
				reply({
					dimensions: ["Division"],
					measures: ["Revenue"],
					visualType: "sankeyDiagram3D",
				}),
				source,
			),
		(error: Error) =>
			error instanceof ProposalRejected &&
			error.message.includes("sankeyDiagram3D"),
	);
});

// The catalogue already says what each chart can hold, so the assistant is held
// to the same rule an author is rather than to a second copy of it.
test("more dimensions than the chosen visual takes is refused", () => {
	assert.throws(
		() =>
			parseProposal(
				reply({
					dimensions: ["Division", "Region"],
					measures: ["Revenue"],
					visualType: "pieChart",
				}),
				source,
			),
		ProposalRejected,
	);
});

test("a proposal naming no fields at all is refused", () => {
	assert.throws(
		() => parseProposal(reply({ visualType: "table" }), source),
		ProposalRejected,
	);
});

test("a reply about a different source is refused", () => {
	assert.throws(
		() =>
			parseProposal(
				reply({
					sourceKey: "somewhere_else",
					dimensions: ["Division"],
					measures: ["Revenue"],
					visualType: "barChart",
				}),
				source,
			),
		ProposalRejected,
	);
});

test("a reply that is not JSON at all is refused", () => {
	for (const body of [
		"I cannot answer that.",
		"",
		"{ not json",
		"[1, 2, 3]",
	]) {
		assert.throws(
			() => parseProposal(body, source),
			ProposalRejected,
			body,
		);
	}
});

// Models wrap JSON in prose and fences whatever they are told, and the content
// is right when the packaging is not.
test("JSON inside a fence or surrounded by prose is read", () => {
	const inner = reply({
		dimensions: ["Division"],
		measures: ["Revenue"],
		visualType: "barChart",
	});

	for (const body of [
		"```json\n" + inner + "\n```",
		"```\n" + inner + "\n```",
		"Here is the query:\n" + inner + "\nHope that helps.",
	]) {
		const p = parseProposal(body, source);
		assert.deepEqual(p.dimensions, ["Division"]);
	}
});

test("a limit is clamped rather than obeyed or refused", () => {
	const at = (limit: unknown) =>
		parseProposal(
			reply({
				dimensions: ["Division"],
				measures: ["Revenue"],
				visualType: "barChart",
				limit,
			}),
			source,
		).limit;

	assert.equal(at(5_000_000), 1000);
	assert.equal(at(0), 1);
	assert.equal(at(-3), 1);
	assert.equal(at("not a number"), 200);
	assert.equal(at(undefined), 200);
	assert.equal(at(25.7), 25);
});

test("a note is kept but bounded", () => {
	const p = parseProposal(
		reply({
			dimensions: ["Division"],
			measures: ["Revenue"],
			visualType: "barChart",
			note: "x".repeat(5000),
		}),
		source,
	);
	assert.equal(p.note.length, 400);
});

test("malformed filter and sort entries are dropped, not thrown on", () => {
	const p = parseProposal(
		reply({
			dimensions: ["Division"],
			measures: ["Revenue"],
			filters: [null, "text", {}, { op: "eq" }],
			sort: [null, 7, { direction: "asc" }],
			visualType: "barChart",
		}),
		source,
	);
	assert.deepEqual(p.filters, []);
	assert.deepEqual(p.sort, []);
});
