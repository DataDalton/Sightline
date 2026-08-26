import assert from "node:assert/strict";
import { test } from "node:test";
import { describeProblems, hasError, validateVisual } from "./validate";

// Every case here is something the write path used to accept. applyEdits took
// any visual_type string and any config object, and the only thing standing
// between a report and a definition nothing could draw was an editor UI that
// happened not to offer it.

const source = {
	dimensions: ["Division", "Order Date", "Product Number"],
	measures: ["Net Sales", "Units", "Freight"],
};

test("a type nothing renders is refused", () => {
	const problems = validateVisual(
		"notAThing",
		{ dimensions: ["Division"], measures: ["Net Sales"] },
		source,
	);
	assert.equal(hasError(problems), true);
	assert.equal(problems[0].field, "visualType");
	assert.match(problems[0].message, /not a visual/);
});

test("an unknown type stops the checks rather than describing itself further", () => {
	const problems = validateVisual(
		"notAThing",
		{ measures: ["nope"] },
		source,
	);
	assert.equal(problems.length, 1);
});

test("a bar chart with no measure is refused", () => {
	const problems = validateVisual(
		"barChart",
		{ dimensions: ["Division"], measures: [] },
		source,
	);
	assert.equal(hasError(problems), true);
	assert.equal(problems[0].field, "measures");
});

test("a well formed visual has nothing wrong with it", () => {
	const problems = validateVisual(
		"barChart",
		{ dimensions: ["Division"], measures: ["Net Sales"] },
		source,
	);
	assert.deepEqual(problems, []);
});

test("more dimensions than the type can use is refused", () => {
	const problems = validateVisual(
		"pieChart",
		{
			dimensions: ["Division", "Order Date", "Product Number"],
			measures: ["Net Sales"],
		},
		source,
	);
	assert.equal(hasError(problems), true);
	assert.equal(problems[0].field, "dimensions");
});

test("a field the source does not define is reported but allowed", () => {
	// Drift, not a mistake. Blocking an unrelated edit until somebody fixes a
	// name the semantic layer dropped would make the check the problem.
	const problems = validateVisual(
		"barChart",
		{ dimensions: ["Divsion"], measures: ["Net Sales"] },
		source,
	);
	assert.equal(hasError(problems), false);
	assert.equal(problems.length, 1);
	assert.equal(problems[0].severity, "warning");
	assert.match(problems[0].message, /Divsion/);
});

test("a placeholder the page resolves is not treated as a missing field", () => {
	const problems = validateVisual(
		"barChart",
		{ dimensions: ["<selected>"], measures: ["Net Sales"] },
		source,
	);
	assert.deepEqual(problems, []);
});

test("no source means the field names are not checked", () => {
	const problems = validateVisual(
		"barChart",
		{ dimensions: ["anything at all"], measures: ["Net Sales"] },
		null,
	);
	assert.deepEqual(problems, []);
});

test("a filter widget is not asked for an encoding it never had", () => {
	const problems = validateVisual(
		"dropdownFilter",
		{ dimensions: ["Division"], measures: [] },
		source,
	);
	assert.equal(hasError(problems), false);
});

// --- Options ---------------------------------------------------------------

test("a select option outside its choices is refused", () => {
	const problems = validateVisual(
		"dropdownFilter",
		{
			dimensions: ["Division"],
			measures: [],
			options: { match: "sideways" },
		},
		source,
	);
	assert.equal(hasError(problems), true);
	assert.equal(problems[0].field, "options");
});

test("a select option holding one of its choices is fine", () => {
	const problems = validateVisual(
		"dropdownFilter",
		{
			dimensions: ["Division"],
			measures: [],
			options: { match: "exclude" },
		},
		source,
	);
	assert.equal(hasError(problems), false);
});

test("a number option beyond its declared range is refused", () => {
	const problems = validateVisual(
		"barChart",
		{
			dimensions: ["Division"],
			measures: ["Net Sales"],
			options: { topN: 100000 },
		},
		source,
	);
	assert.equal(hasError(problems), true);
	assert.match(describeProblems(problems), /at most/);
});

test("a number option inside its range is fine", () => {
	const problems = validateVisual(
		"barChart",
		{
			dimensions: ["Division"],
			measures: ["Net Sales"],
			options: { topN: 20 },
		},
		source,
	);
	assert.equal(hasError(problems), false);
});

test("a number option holding text is refused", () => {
	const problems = validateVisual(
		"barChart",
		{
			dimensions: ["Division"],
			measures: ["Net Sales"],
			options: { topN: "twenty" },
		},
		source,
	);
	assert.equal(hasError(problems), true);
});

test("a field option naming a field the source dropped is a warning", () => {
	const problems = validateVisual(
		"barChart",
		{
			dimensions: ["Division"],
			measures: ["Net Sales"],
			options: { topN: 10, topBy: "Margin" },
		},
		source,
	);
	assert.equal(hasError(problems), false);
	assert.equal(
		problems.some((p) => /Margin/.test(p.message)),
		true,
	);
});

test("none is always a valid answer for a field option", () => {
	const problems = validateVisual(
		"barChart",
		{
			dimensions: ["Division"],
			measures: ["Net Sales"],
			options: { topBy: "none" },
		},
		source,
	);
	assert.equal(problems.length, 0);
});

test("a setting the type does not declare is reported but allowed", () => {
	// Settings outlive the visual type an author switched away from.
	const problems = validateVisual(
		"barChart",
		{
			dimensions: ["Division"],
			measures: ["Net Sales"],
			options: { pivotColumn: "Division" },
		},
		source,
	);
	assert.equal(hasError(problems), false);
	assert.equal(problems[0].severity, "warning");
});

test("null means unset rather than a wrong value", () => {
	const problems = validateVisual(
		"barChart",
		{
			dimensions: ["Division"],
			measures: ["Net Sales"],
			options: { topN: null, topBy: undefined },
		},
		source,
	);
	assert.deepEqual(problems, []);
});

test("errors sort ahead of warnings", () => {
	const problems = validateVisual(
		"barChart",
		{
			dimensions: ["Divsion"],
			measures: [],
			options: { unknownKey: 1 },
		},
		source,
	);
	assert.equal(problems[0].severity, "error");
	assert.equal(problems[problems.length - 1].severity, "warning");
});

test("describeProblems names only what blocks the write", () => {
	const problems = validateVisual(
		"barChart",
		{ dimensions: ["Divsion"], measures: [] },
		source,
	);
	const described = describeProblems(problems);
	assert.match(described, /measure/i);
	assert.equal(/Divsion/.test(described), false);
});
