import assert from "node:assert/strict";
import { test } from "node:test";
import { allReferenced, referencedFields, roleOf } from "./fieldRefs";

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
