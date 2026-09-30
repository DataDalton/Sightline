import assert from "node:assert/strict";
import { test } from "node:test";
import {
	alertFields,
	allReferenced,
	exploreFields,
	formulaReferences,
	pageFields,
	referencedFields,
	renameInAlert,
	renameInExplore,
	renameInFormula,
	renameInPage,
	renameInSheet,
	renameInVisual,
	roleOf,
	savedViewFields,
	sheetFields,
} from "./fieldRefs";

// The property these tests exist to protect: every place a visual can name a
// field is a dependency the dictionary has to report. A walk that reads only
// dimensions and measures says a filtered field is unused, and somebody
// retires it.

test("dimensions and measures are read as plain name lists", () => {
	const refs = referencedFields({
		dimensions: ["Division", "Region"],
		measures: ["Net Sales"],
	});
	assert.deepEqual(refs.dimension, ["Division", "Region"]);
	assert.deepEqual(refs.measure, ["Net Sales"]);
});

test("a field named only by a filter is still a reference", () => {
	const config = {
		dimensions: ["Division"],
		measures: ["Net Sales"],
		filters: [{ field: "Business Unit", op: "eq", value: "Hardware" }],
	};
	assert.equal(roleOf(config, "Business Unit"), "filter");
	assert.ok(allReferenced(config).includes("Business Unit"));
});

test("a field named only by a sort is still a reference", () => {
	const config = { sort: [{ field: "Revenue", direction: "desc" }] };
	assert.equal(roleOf(config, "Revenue"), "sort");
});

test("a field in two places is reported as the one shaping the query", () => {
	const config = {
		measures: ["Revenue"],
		sort: [{ field: "Revenue", direction: "desc" }],
	};
	assert.equal(roleOf(config, "Revenue"), "measure");
});

test("a dimension outranks a filter naming the same field", () => {
	const config = {
		dimensions: ["Division"],
		filters: [{ field: "Division", op: "in", values: ["A"] }],
	};
	assert.equal(roleOf(config, "Division"), "dimension");
});

test("a field the configuration does not name has no role", () => {
	assert.equal(roleOf({ dimensions: ["Division"] }, "Region"), null);
});

test("each field is listed once however many places name it", () => {
	const config = {
		dimensions: ["Division"],
		measures: ["Revenue"],
		filters: [{ field: "Division", op: "eq", value: "A" }],
		sort: [{ field: "Revenue", direction: "desc" }],
	};
	assert.deepEqual(allReferenced(config).sort(), ["Division", "Revenue"]);
});

// Configurations are stored as free JSON and written by several versions of the
// editor, so the walk meets shapes no current code produces. Every one of these
// reached the old reader as an exception during a page load.
test("a missing, null or wrongly shaped section reads as no references", () => {
	for (const config of [
		{},
		null,
		undefined,
		[],
		"not an object",
		{ dimensions: null, measures: undefined },
		{ dimensions: "Division" },
		{ filters: "Business Unit" },
		{ filters: [null, 3, "text"] },
		{ sort: [{ direction: "desc" }] },
	]) {
		assert.deepEqual(allReferenced(config), [], JSON.stringify(config));
	}
});

test("non-string entries inside a name list are ignored", () => {
	const refs = referencedFields({ dimensions: ["Division", 7, null, {}] });
	assert.deepEqual(refs.dimension, ["Division"]);
});

// --- Every other place a field is named ------------------------------------

test("a field chosen in a visual setting is a reference", () => {
	const config = {
		measures: ["Revenue"],
		options: { topBy: "Margin", drillFields: ["Region", "Country"] },
	};
	assert.equal(roleOf(config, "Margin"), "option");
	assert.equal(roleOf(config, "Country"), "option");
	assert.deepEqual(referencedFields(config).option.sort(), [
		"Country",
		"Margin",
		"Region",
	]);
});

test("a field setting left at none names nothing", () => {
	assert.deepEqual(
		referencedFields({ options: { topBy: "none", compareField: "" } })
			.option,
		[],
	);
});

test("a condition inside a filter group is still a reference", () => {
	const config = {
		filters: [{ any: [{ field: "Region", op: "eq", value: "East" }] }],
	};
	assert.ok(allReferenced(config).includes("Region"));
});

test("a page names the field its data-through stamp reads", () => {
	assert.deepEqual(pageFields({ freshness: { field: "Order Date" } }), [
		"Order Date",
	]);
	assert.deepEqual(pageFields({}), []);
});

test("a saved view names the fields its overlay hides and adds", () => {
	assert.deepEqual(
		savedViewFields({
			hiddenMeasures: ["Freight"],
			addedDimensions: ["Region"],
		}).sort(),
		["Freight", "Region"],
	);
});

test("an Explore view names its columns and conditions", () => {
	assert.deepEqual(
		exploreFields({
			sourceKey: "sales",
			columns: ["Region", "Revenue"],
			conditions: [{ field: "Channel", op: "eq", values: ["Web"] }],
		}).sort(),
		["Channel", "Region", "Revenue"],
	);
});

test("an alert names its measure, split, conditions and history date", () => {
	assert.deepEqual(
		alertFields({
			measure: "Revenue",
			groupBy: "Region",
			conditions: [{ field: "Channel", op: "eq", values: ["Web"] }],
			anomaly: { timeField: "Order Date" },
		}).sort(),
		["Channel", "Order Date", "Region", "Revenue"],
	);
});

test("a sheet names fields in every part of its definition", () => {
	const fields = sheetFields({
		columns: ["Region"],
		conditions: [{ field: "Channel", op: "eq", values: ["Web"] }],
		pivot: { rows: ["Country"], columns: "Year", values: ["Units"] },
		order: ["field:Segment", "formula:f1"],
		settings: { "field:Width Only": { width: 90 } },
		sort: { column: "Sorted", direction: "asc" },
		formulas: [
			{
				id: "f1",
				name: "Share",
				formula: '[Revenue] / [Cost] & "[Not]"',
			},
		],
	});
	for (const name of [
		"Region",
		"Channel",
		"Country",
		"Year",
		"Units",
		"Segment",
		"Width Only",
		"Sorted",
		"Revenue",
		"Cost",
	]) {
		assert.ok(fields.includes(name), name);
	}
	assert.ok(!fields.includes("Not"));
});

test("formula references skip quoted text and trim their brackets", () => {
	assert.deepEqual(formulaReferences('[ Net ] + "[x]" + [Tax]'), [
		"Net",
		"Tax",
	]);
});

// --- Renaming --------------------------------------------------------------

test("renaming a visual reaches every place and nothing else", () => {
	const config = {
		dimensions: ["Region", "Old"],
		measures: ["Revenue"],
		filters: [{ field: "Old", op: "eq", value: "Old" }],
		sort: [{ field: "Old", direction: "desc" }],
		options: { topBy: "Old", drillFields: ["Old", "Country"], note: "Old" },
	};
	const renamed = renameInVisual(config, "Old", "New");
	assert.equal(renamed.changed, true);
	assert.deepEqual(renamed.value, {
		dimensions: ["Region", "New"],
		measures: ["Revenue"],
		filters: [{ field: "New", op: "eq", value: "Old" }],
		sort: [{ field: "New", direction: "desc" }],
		options: { topBy: "New", drillFields: ["New", "Country"], note: "Old" },
	});
	// The original is left as it was.
	assert.deepEqual(config.dimensions, ["Region", "Old"]);
});

test("a rename onto a name already listed keeps it once", () => {
	const renamed = renameInVisual(
		{ dimensions: ["Old", "New"] },
		"Old",
		"New",
	);
	assert.deepEqual(renamed.value, { dimensions: ["New"] });
});

test("a configuration that does not name the field is unchanged", () => {
	const renamed = renameInVisual({ measures: ["Revenue"] }, "Old", "New");
	assert.equal(renamed.changed, false);
});

test("renaming a page, an Explore view and an alert", () => {
	assert.deepEqual(
		renameInPage({ freshness: { field: "Old", label: "x" } }, "Old", "New")
			.value,
		{ freshness: { field: "New", label: "x" } },
	);
	assert.deepEqual(
		renameInExplore(
			{
				sourceKey: "s",
				columns: ["Old"],
				conditions: [{ field: "Old" }],
			},
			"Old",
			"New",
		).value,
		{ sourceKey: "s", columns: ["New"], conditions: [{ field: "New" }] },
	);
	assert.deepEqual(
		renameInAlert(
			{
				measure: "Old",
				groupBy: "Old",
				conditions: [],
				anomaly: { timeField: "Old" },
			},
			"Old",
			"New",
		).value,
		{
			measure: "New",
			groupBy: "New",
			conditions: [],
			anomaly: { timeField: "New" },
		},
	);
});

test("renaming a sheet moves its keys, pivot, sort and formulas", () => {
	const renamed = renameInSheet(
		{
			columns: ["Old"],
			conditions: [{ field: "Old" }],
			pivot: { rows: ["Old"], columns: "Old", values: [] },
			order: ["field:Old", "formula:f1"],
			settings: { "field:Old": { width: 120 } },
			sort: { column: "Old", direction: "asc" },
			formulas: [
				{ id: "f1", name: "Twice", formula: '[Old] * 2 & "[Old]"' },
			],
		},
		"Old",
		"New",
	);
	assert.deepEqual(renamed.value, {
		columns: ["New"],
		conditions: [{ field: "New" }],
		pivot: { rows: ["New"], columns: "New", values: [] },
		order: ["field:New", "formula:f1"],
		settings: { "field:New": { width: 120 } },
		sort: { column: "New", direction: "asc" },
		formulas: [{ id: "f1", name: "Twice", formula: '[New] * 2 & "[Old]"' }],
	});
});

test("a formula keeps references to other columns", () => {
	assert.equal(
		renameInFormula("[Old] + [Older] + [ Old ]", "Old", "New"),
		"[New] + [Older] + [New]",
	);
});
