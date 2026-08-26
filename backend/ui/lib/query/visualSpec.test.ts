import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalizeSpec, parseQuerySpec } from "./spec";
import {
	chartRows,
	fieldsForVisual,
	gridPageSize,
	initialQueryForVisual,
	queryForVisual,
} from "./visualSpec";

// Warming is only worth anything if the query it runs is the query the page
// then asks for. Both go through parseQuerySpec and are keyed on
// canonicalizeSpec, so "the same query" means precisely that these two strings
// match. When they do not, the warm entry sits under a key nobody reads: a
// warehouse query spent, nothing saved, and no error anywhere to say so.

const source = {
	dimensions: [{ name: "region" }, { name: "orderDate" }],
	measures: [{ name: "revenue" }, { name: "units" }],
};

function keyFor(shape: unknown): string {
	return canonicalizeSpec(parseQuerySpec(shape));
}

test("what the server warms is what the page asks for", () => {
	const config = {
		dimensions: ["region"],
		measures: ["revenue"],
		filters: [{ field: "region", op: "eq", values: ["North"] }],
	};

	// The server, walking a stored report before anything is rendered.
	const fields = fieldsForVisual(config, source);
	const warmed = queryForVisual("barChart", {
		sourceKey: "orders",
		dimensions: fields.dimensions,
		measures: fields.measures,
		filters: config.filters,
	});

	// The page, having resolved the same visual with nothing yet touched.
	const asked = queryForVisual("barChart", {
		sourceKey: "orders",
		dimensions: ["region"],
		measures: ["revenue"],
		filters: config.filters,
	});

	assert.ok(warmed && asked);
	assert.equal(keyFor(warmed), keyFor(asked));
});

test("an unresolved placeholder is absent from both, not sent as itself", () => {
	// A page opens with no breakdown chosen, so <selected> resolves to nothing
	// and the renderer drops it. Warming a spec that still carried the literal
	// would key on a dimension the warehouse has never heard of.
	const fields = fieldsForVisual(
		{ dimensions: ["<selected>", "region"], measures: ["revenue"] },
		source,
	);
	assert.deepEqual(fields.dimensions, ["region"]);
});

test("a field the source no longer defines is dropped before the warehouse", () => {
	const fields = fieldsForVisual(
		{
			dimensions: ["region", "retiredColumn"],
			measures: ["revenue", "gone"],
		},
		source,
	);
	assert.deepEqual(fields.dimensions, ["region"]);
	assert.deepEqual(fields.measures, ["revenue"]);
});

test("no filters and empty filters are one key, not two", () => {
	const withNone = queryForVisual("barChart", {
		sourceKey: "orders",
		dimensions: ["region"],
		measures: ["revenue"],
	});
	const withEmpty = queryForVisual("barChart", {
		sourceKey: "orders",
		dimensions: ["region"],
		measures: ["revenue"],
		filters: [],
	});
	assert.ok(withNone && withEmpty);
	assert.equal(keyFor(withNone), keyFor(withEmpty));
});

test("each visual type keeps the shape its component asks for", () => {
	const base = {
		sourceKey: "orders",
		dimensions: ["region"],
		measures: ["revenue"],
	};

	// A scorecard is one aggregate, ungrouped.
	const kpi = queryForVisual("kpiRow", base);
	assert.equal(kpi?.limit, 1);
	assert.equal(kpi?.dimensions, undefined);

	// A grid takes its first page and nothing more.
	assert.equal(queryForVisual("table", base)?.limit, gridPageSize);

	// A record panel is not a grid, whatever it looks like.
	assert.equal(queryForVisual("definitionList", base)?.limit, 2);

	// A chart sorts by its first dimension.
	const chart = queryForVisual("barChart", base);
	assert.deepEqual(chart?.sort, [{ field: "region", direction: "asc" }]);
	assert.equal(chart?.limit, chartRows);

	// An author's own limit wins over the default.
	assert.equal(queryForVisual("barChart", { ...base, limit: 50 })?.limit, 50);
});

test("a visual that asks the warehouse nothing warms nothing", () => {
	const base = { sourceKey: "orders", dimensions: [], measures: [] };
	for (const type of [
		"textPanel",
		"blockedNotice",
		"dimensionSwitch",
		"periodSwitch",
	]) {
		assert.equal(queryForVisual(type, base), null, type);
	}
	// And neither does a chart with nothing encoded yet.
	assert.equal(queryForVisual("barChart", base), null);
	// Nor a type this build does not render, which would otherwise fall
	// through to whatever the last branch happened to be.
	assert.equal(
		queryForVisual("someTypeFromANewerBuild", {
			sourceKey: "orders",
			dimensions: ["region"],
			measures: ["revenue"],
		}),
		null,
	);
	// Nor one with no source.
	assert.equal(queryForVisual("barChart", { ...base, sourceKey: "" }), null);
});

test("a chart with a drill hierarchy is warmed at the top of it", () => {
	// The renderer shows the first drill field on arrival, not the dimension
	// the author encoded. Warming the encoded one would key on a grouping the
	// page never asks for.
	const warmed = initialQueryForVisual(
		{
			visualType: "barChart",
			config: {
				dimensions: ["orderDate"],
				measures: ["revenue"],
				options: { drillFields: ["region", "orderDate"] },
			},
		},
		"orders",
		source,
	);
	assert.deepEqual(warmed?.dimensions, ["region"]);
	assert.deepEqual(warmed?.sort, [{ field: "region", direction: "asc" }]);
});

test("one drill field is not a hierarchy, so the encoding stands", () => {
	const warmed = initialQueryForVisual(
		{
			visualType: "barChart",
			config: {
				dimensions: ["orderDate"],
				measures: ["revenue"],
				options: { drillFields: ["region"] },
			},
		},
		"orders",
		source,
	);
	assert.deepEqual(warmed?.dimensions, ["orderDate"]);
});

test("a top N ranks by its measure and asks for only that many", () => {
	const q = queryForVisual("barChart", {
		sourceKey: "orders",
		dimensions: ["region"],
		measures: ["revenue", "units"],
		options: { topN: 10 },
	});
	assert.deepEqual(q?.sort, [{ field: "revenue", direction: "desc" }]);
	assert.equal(q?.limit, 10);
});

test("a top N can rank by a measure that is not the first", () => {
	const q = queryForVisual("barChart", {
		sourceKey: "orders",
		dimensions: ["region"],
		measures: ["revenue", "units"],
		options: { topN: 5, topBy: "units" },
	});
	assert.deepEqual(q?.sort, [{ field: "units", direction: "desc" }]);
});

test("a top N ranked by a measure the visual does not read is ignored", () => {
	// The author renamed or removed the measure and left the setting behind.
	// Ranking by a field that is not in the query would fail at the warehouse.
	const q = queryForVisual("barChart", {
		sourceKey: "orders",
		dimensions: ["region"],
		measures: ["revenue"],
		options: { topN: 10, topBy: "retired" },
	});
	assert.deepEqual(q?.sort, [{ field: "region", direction: "asc" }]);
	assert.equal(q?.limit, chartRows);
});

test("a top N with nothing to group by is ignored", () => {
	// A top ten of one row is ten of nothing.
	const q = queryForVisual("kpiRow", {
		sourceKey: "orders",
		dimensions: [],
		measures: ["revenue"],
		options: { topN: 10 },
	});
	assert.equal(q?.limit, 1);
});

test("the warmed top N is the one the page asks for", () => {
	const config = {
		dimensions: ["region"],
		measures: ["revenue"],
		options: { topN: 10 },
	};
	const warmed = initialQueryForVisual(
		{ visualType: "barChart", config },
		"orders",
		source,
	);
	const asked = queryForVisual("barChart", {
		sourceKey: "orders",
		dimensions: ["region"],
		measures: ["revenue"],
		options: config.options,
	});
	assert.ok(warmed && asked);
	assert.equal(keyFor(warmed), keyFor(asked));
});
