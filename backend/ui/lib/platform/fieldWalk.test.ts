import { test } from "node:test";
import assert from "node:assert/strict";
import {
	namesIn,
	removing,
	renaming,
	walkAlert,
	walkBoard,
	walkDeckSteps,
	walkPage,
	walkSavedView,
	walkSheet,
	walkVisual,
} from "./fieldWalk";

const visual = {
	dimensions: ["Region", "Channel"],
	measures: ["Revenue", "Margin"],
	filters: [
		{ field: "Region", op: "in", values: ["East"] },
		{ any: [{ field: "Margin", op: "gt", value: "0" }] },
	],
	sort: [{ field: "Revenue", direction: "desc" }],
	transforms: [
		{
			kind: "ratio",
			measure: "Margin",
			denominator: "Revenue",
			as: "Margin rate",
		},
		{ kind: "rank", measure: "Revenue", as: "Rank" },
	],
	options: {
		topBy: "Revenue",
		drillFields: ["Region", "City"],
		requireFilter: ["Region"],
		targets: {
			Revenue: {
				basis: { kind: "measure", measure: "Budget" },
				change: 0,
			},
			Margin: { basis: { kind: "fixed", value: 5 }, change: 0 },
		},
		tooltips: { Revenue: "Booked revenue" },
	},
	style: {
		series: [{ measure: "Margin", color: "blue" }, { color: "grey" }],
		conditions: [
			{ field: "Margin", operator: "lt", value: 0, applyTo: "row" },
			{ field: "Revenue", operator: "gt", value: 9, applyTo: "Region" },
			{ field: "Margin rate", operator: "lt", value: 0 },
		],
		colorScales: [{ field: "Revenue", kind: "sequential" }],
		tooltip: { extraFields: ["Channel", "Budget"] },
		referenceLines: [{ id: "a", kind: "average", measure: "Revenue" }],
	},
};

test("every field a visual names is found, styling and settings included", () => {
	const found = namesIn((visit) => walkVisual(visual, visit)).sort();
	assert.deepEqual(found, [
		"Budget",
		"Channel",
		"City",
		"Margin",
		"Margin rate",
		"Region",
		"Revenue",
	]);
});

test("a rename reaches every place a visual names the field", () => {
	const { value, changed } = walkVisual(visual, renaming("Revenue", "Sales"));
	assert.equal(changed, true);
	const text = JSON.stringify(value);
	assert.equal(text.includes('"Revenue"'), false);
	assert.deepEqual(value.measures, ["Sales", "Margin"]);
	assert.equal(value.options.topBy, "Sales");
	assert.deepEqual(Object.keys(value.options.targets), ["Sales", "Margin"]);
	assert.deepEqual(Object.keys(value.options.tooltips), ["Sales"]);
	assert.equal(value.transforms[0].denominator, "Sales");
	assert.equal(value.style.colorScales[0].field, "Sales");
	assert.equal(value.style.referenceLines[0].measure, "Sales");
});

test("a rename onto a name already in a list keeps it once", () => {
	const { value } = walkVisual(
		{ dimensions: ["Region", "Area"] },
		renaming("Region", "Area"),
	);
	assert.deepEqual(value.dimensions, ["Area"]);
});

test("removing a measure takes out what reads it and nothing else", () => {
	const { value } = walkVisual(visual, removing("Margin"));
	assert.deepEqual(value.measures, ["Revenue"]);
	// The filter group held only a Margin clause, so it goes.
	assert.deepEqual(value.filters, [
		{ field: "Region", op: "in", values: ["East"] },
	]);
	// The ratio read Margin, so it goes, and the rule on its result goes too.
	assert.deepEqual(
		value.transforms.map((t: { kind: string }) => t.kind),
		["rank"],
	);
	assert.deepEqual(
		value.style.conditions.map((c: { field: string }) => c.field),
		["Revenue"],
	);
	// The default series styling with no measure stays.
	assert.deepEqual(value.style.series, [{ color: "grey" }]);
	assert.deepEqual(Object.keys(value.options.targets), ["Revenue"]);
	assert.equal(JSON.stringify(value).includes('"Margin"'), false);
});

test("removing a target's basis measure takes out that target", () => {
	const { value } = walkVisual(visual, removing("Budget"));
	assert.deepEqual(Object.keys(value.options.targets), ["Margin"]);
	assert.deepEqual(value.style.tooltip.extraFields, ["Channel"]);
});

test("removing a single-field setting clears it", () => {
	const { value } = walkVisual(visual, removing("Revenue"));
	assert.equal("topBy" in value.options, false);
	assert.deepEqual(value.sort, []);
	// A rule painting another column goes with that column's tested field.
	assert.equal(
		value.style.conditions.some(
			(c: { field: string }) => c.field === "Revenue",
		),
		false,
	);
	assert.deepEqual(value.style.referenceLines, []);
});

test("a rule painting a removed column goes rather than painting another", () => {
	const { value } = walkVisual(visual, removing("Region"));
	assert.deepEqual(
		value.style.conditions.map((c: { field: string }) => c.field),
		["Margin", "Margin rate"],
	);
	assert.deepEqual(value.options.requireFilter, []);
	assert.deepEqual(value.options.drillFields, ["City"]);
});

test("placeholders are never taken for fields", () => {
	const found = namesIn((visit) =>
		walkVisual({ dimensions: ["<selected>", "<grain>", "Day"] }, visit),
	);
	assert.deepEqual(found, ["Day"]);
});

test("nothing changes when the field is not named", () => {
	const { value, changed } = walkVisual(visual, removing("Nowhere"));
	assert.equal(changed, false);
	assert.deepEqual(value, visual);
});

test("a page's stamp and required filters follow a rename and a removal", () => {
	const page = {
		freshness: { field: "Order Date", label: "x" },
		requireFilter: ["Region"],
	};
	assert.deepEqual(walkPage(page, renaming("Order Date", "Booked")).value, {
		freshness: { field: "Booked", label: "x" },
		requireFilter: ["Region"],
	});
	assert.deepEqual(walkPage(page, removing("Order Date")).value, {
		freshness: { label: "x" },
		requireFilter: ["Region"],
	});
	assert.deepEqual(
		walkPage(page, removing("Region")).value.requireFilter,
		[],
	);
});

test("a saved view's per-visual state follows the field", () => {
	const view = {
		dimensions: ["Region"],
		columnOrder: ["Region", "Revenue"],
		pinnedColumns: ["Region"],
		columnWidths: { Region: 120, Revenue: 90 },
		dimension: "Region",
		pageFilters: {
			v1: [{ field: "Region", op: "in", values: ["East"] }],
			"v2:Region": [{ field: "Region", op: "in", values: ["West"] }],
		},
		gridStates: {
			v3: {
				sort: { key: "Region", direction: "asc" },
				filters: { Region: ["East"] },
			},
		},
	};
	const renamed = walkSavedView(view, renaming("Region", "Area")).value;
	assert.equal(JSON.stringify(renamed).includes("Region"), false);
	assert.deepEqual(Object.keys(renamed.pageFilters), ["v1", "v2:Area"]);
	assert.equal(renamed.gridStates.v3.sort.key, "Area");

	const removed = walkSavedView(view, removing("Region")).value;
	assert.deepEqual(removed.columnOrder, ["Revenue"]);
	assert.deepEqual(removed.columnWidths, { Revenue: 90 });
	assert.equal("dimension" in removed, false);
	assert.deepEqual(removed.pageFilters, {});
	assert.deepEqual(removed.gridStates.v3, { filters: {} });
});

test("an alert on a removed measure is orphaned, and on a removed split is not", () => {
	const alert = {
		measure: "Revenue",
		groupBy: "Region",
		conditions: [{ field: "Channel", op: "eq", value: "Web" }],
		anomaly: { timeField: "Order Date" },
	};
	assert.equal(walkAlert(alert, removing("Revenue")).orphaned, true);
	const split = walkAlert(alert, removing("Region"));
	assert.equal(split.orphaned, false);
	assert.equal("groupBy" in split.value, false);
	assert.equal(
		"anomaly" in walkAlert(alert, removing("Order Date")).value,
		false,
	);
	assert.equal(
		walkAlert(alert, renaming("Revenue", "Sales")).value.measure,
		"Sales",
	);
});

test("a sheet formula reading a removed column goes, with what reads it", () => {
	const sheet = {
		columns: ["Region", "Revenue"],
		formulas: [
			{ id: "f1", name: "Doubled", formula: "[Revenue] * 2" },
			{ id: "f2", name: "Quadrupled", formula: "[Doubled] * 2" },
			{ id: "f3", name: "Label", formula: '"[Revenue]" & [Region]' },
		],
		order: [
			"field:Region",
			"field:Revenue",
			"formula:f1",
			"formula:f2",
			"formula:f3",
		],
		settings: {
			"field:Revenue": { width: 80 },
			"formula:f1": { width: 60 },
		},
		sort: { column: "Doubled", direction: "desc" },
		pivot: { rows: [], columns: null, values: ["Revenue"] },
	};
	const { value } = walkSheet(sheet, removing("Revenue"));
	assert.deepEqual(
		value.formulas.map((f: { id: string }) => f.id),
		["f3"],
	);
	assert.deepEqual(value.order, ["field:Region", "formula:f3"]);
	assert.deepEqual(value.settings, {});
	assert.equal("sort" in value, false);
	assert.deepEqual(value.pivot.values, []);

	const renamed = walkSheet(sheet, renaming("Revenue", "Sales")).value;
	assert.equal(renamed.formulas[0].formula, "[Sales] * 2");
	// Quoted text is not a reference.
	assert.equal(renamed.formulas[2].formula, '"[Revenue]" & [Region]');
	assert.deepEqual(Object.keys(renamed.settings), [
		"field:Sales",
		"formula:f1",
	]);
});

test("a tour's step filters follow the field", () => {
	const steps = [
		{ id: "s", filters: { Region: ["East"], Channel: ["Web"] } },
	];
	assert.deepEqual(
		walkDeckSteps(steps, removing("Region")).value[0].filters,
		{
			Channel: ["Web"],
		},
	);
	assert.deepEqual(
		Object.keys(
			walkDeckSteps(steps, renaming("Region", "Area")).value[0].filters,
		),
		["Area", "Channel"],
	);
});

test("a board only changes items reading the changed source", () => {
	const board = {
		items: [
			{
				id: "a",
				visual: {
					sourceKey: "sales",
					config: { measures: ["Revenue"] },
				},
			},
			{
				id: "b",
				visual: {
					sourceKey: "other",
					config: { measures: ["Revenue"] },
				},
			},
		],
		links: [],
	};
	const { value } = walkBoard(board, "sales", renaming("Revenue", "Sales"));
	assert.deepEqual(value.items[0].visual.config.measures, ["Sales"]);
	assert.deepEqual(value.items[1].visual.config.measures, ["Revenue"]);
});
