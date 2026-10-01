import assert from "node:assert/strict";
import { test } from "node:test";
import type { SemanticField, SemanticSource } from "../../semantic/types";
import { alertSurface, type AlertDraft } from "./alert";
import { editorSurface, textToHtml, type EditorOp } from "./editor";
import { exploreSurface } from "./explore";
import { formulaSurface, type FormulaDraft } from "./formula";
import { applyBoardEdit, boardSurface, buildNewBoard } from "./board";
import { buildSurface } from "./index";
import { sheetSurface, type SheetDraft } from "./sheet";

function field(name: string, kind: "dimension" | "measure"): SemanticField {
	return {
		fieldId: name,
		sourceKey: "sales",
		name,
		displayName: null,
		kind,
		sqlExpr: null,
		dataType: null,
		description: null,
		formatHint: null,
		tags: {},
		folder: null,
		sortOrder: 0,
		isDefault: false,
	} as SemanticField;
}

const sales = {
	sourceKey: "sales",
	title: "Sales",
	description: null,
	catalog: "c",
	schema: "s",
	object: "o",
	kind: "table",
	accessMode: "caller",
	hasRowFilter: false,
	cacheTtlSeconds: 0,
	isLive: false,
	defaultTimeField: "Order Date",
	dimensions: [
		field("Region", "dimension"),
		field("Channel", "dimension"),
		field("Order Date", "dimension"),
	],
	measures: [field("Revenue", "measure"), field("Margin Pct", "measure")],
} as unknown as SemanticSource;

const available = [sales];

// --- Alerts -------------------------------------------------------------------

test("an alert is filled in from a complete rule", () => {
	const surface = alertSurface({ definition: {} }, available);
	const out = surface.run("set_alert", {
		sourceKey: "sales",
		measure: "Revenue",
		groupBy: "Region",
		conditions: [{ field: "Channel", op: "eq", value: "Online" }],
		condition: "falls_by",
		threshold: 10,
		frequency: "weekly",
		hour: 9,
		weekday: 1,
	});
	assert.equal(out.ok, true, out.result);
	const draft = out.draft as AlertDraft;
	assert.equal(draft.groupBy, "Region");
	assert.equal(draft.threshold, 10);
	assert.deepEqual(draft.schedule, {
		frequency: "weekly",
		hour: 9,
		weekday: 1,
	});
	assert.equal(draft.conditions[0].field, "Channel");
	// No name was given, so the dialog keeps naming it after the rule.
	assert.equal(draft.name, "");
});

test("an alert refuses a dimension as its measure and an unknown field", () => {
	const surface = alertSurface({}, available);
	const asMeasure = surface.run("set_alert", {
		sourceKey: "sales",
		measure: "Region",
		condition: "changes",
	});
	assert.equal(asMeasure.ok, false);
	assert.match(asMeasure.result, /dimension/);

	const unknown = surface.run("set_alert", {
		sourceKey: "sales",
		measure: "Revenue",
		condition: "changes",
		conditions: [{ field: "Country", op: "eq", value: "US" }],
	});
	assert.equal(unknown.ok, false);
	assert.match(unknown.result, /Country/);
	assert.equal(unknown.draft, undefined);
});

test("an alert above a value needs the value, and an unreadable dataset is refused", () => {
	const surface = alertSurface({}, available);
	const missing = surface.run("set_alert", {
		sourceKey: "sales",
		measure: "Revenue",
		condition: "above",
	});
	assert.equal(missing.ok, false);

	const hidden = surface.run("set_alert", {
		sourceKey: "payroll",
		measure: "Revenue",
		condition: "changes",
	});
	assert.equal(hidden.ok, false);
	assert.match(hidden.result, /list_sources/);
});

test("the dataset already chosen in the dialog is the one questions start from", () => {
	const surface = alertSurface(
		{ definition: { sourceKey: "sales" } },
		available,
	);
	assert.equal(surface.preferredSourceKey, "sales");
});

// --- Formulas -----------------------------------------------------------------

const sheetRows = [
	{ Region: "West", Revenue: 100, Cost: 60 },
	{ Region: "East", Revenue: 50, Cost: 0 },
];

test("a formula is tried on the rows and its first values come back", () => {
	const surface = formulaSurface({
		columns: ["Region", "Revenue", "Cost"],
		formulas: [],
		sampleRows: sheetRows,
	});
	const out = surface.run("set_formula", {
		name: "Profit",
		formula: "[revenue] - [Cost]",
	});
	assert.equal(out.ok, true, out.result);
	assert.deepEqual(out.draft as FormulaDraft, {
		name: "Profit",
		formula: "[revenue] - [Cost]",
	});
	assert.match(out.result, /40, 50/);
});

test("a formula over a missing column, or one that cannot be read, is refused", () => {
	const surface = formulaSurface({
		columns: ["Revenue"],
		formulas: [],
		sampleRows: sheetRows,
	});
	const missing = surface.run("set_formula", {
		name: "Profit",
		formula: "[Revenue] - [Costs]",
	});
	assert.equal(missing.ok, false);
	assert.match(missing.result, /Costs/);

	const broken = surface.run("set_formula", {
		name: "Profit",
		formula: "[Revenue] - ",
	});
	assert.equal(broken.ok, false);
});

test("a formula that fails on every row is sent back, and a taken name is refused", () => {
	const surface = formulaSurface({
		columns: ["Region", "Revenue"],
		formulas: [{ id: "a", name: "Double", formula: "[Revenue] * 2" }],
		sampleRows: [{ Region: "West", Revenue: 0 }],
	});
	const everyRow = surface.run("set_formula", {
		name: "Ratio",
		formula: "1 / [Revenue]",
	});
	assert.equal(everyRow.ok, false);
	assert.match(everyRow.result, /every row/);

	const taken = surface.run("set_formula", {
		name: "double",
		formula: "[Revenue]",
	});
	assert.equal(taken.ok, false);
});

test("the formula being edited may keep its own name", () => {
	const surface = formulaSurface({
		columns: ["Revenue"],
		formulas: [{ id: "a", name: "Double", formula: "[Revenue] * 2" }],
		sampleRows: [{ Revenue: 3 }],
		editing: { name: "Double", formula: "[Revenue] * 2" },
	});
	const out = surface.run("set_formula", {
		name: "Double",
		formula: "[Revenue] * 3",
	});
	assert.equal(out.ok, true, out.result);
	assert.match(out.result, /9/);
});

// --- Sheets -------------------------------------------------------------------

const sheetState = {
	definition: {
		sourceKey: "sales",
		mode: "table",
		columns: ["Region", "Revenue"],
		conditions: [],
		formulas: [{ id: "keep1", name: "Double", formula: "[Revenue] * 2" }],
		notes: [],
		order: [],
		settings: {},
		sort: null,
		pivot: { rows: [], columns: null, values: [] },
		frozen: 0,
	},
	sampleRows: [
		{ Region: "West", Revenue: 100 },
		{ Region: "East", Revenue: 50 },
	],
};

test("a sheet change keeps formula ids by name and names only what changed", () => {
	const surface = sheetSurface(sheetState, available);
	const out = surface.run("edit_sheet", {
		formulas: [
			{ name: "Double", formula: "[Revenue] * 2" },
			{ name: "Share", formula: "SHARE([Revenue])" },
		],
		sort: { column: "Share", direction: "desc" },
	});
	assert.equal(out.ok, true, out.result);
	const draft = out.draft as SheetDraft;
	assert.deepEqual(Object.keys(draft).sort(), ["formulas", "sort"]);
	assert.equal(draft.formulas?.[0].id, "keep1");
	assert.notEqual(draft.formulas?.[1].id, "keep1");
	assert.deepEqual(draft.sort, { column: "Share", direction: "desc" });
});

test("a pivot needs a measure, and an unknown sort column is refused", () => {
	const surface = sheetSurface(sheetState, available);
	const empty = surface.run("edit_sheet", {
		mode: "pivot",
		pivot: { rows: ["Region"], values: [] },
	});
	assert.equal(empty.ok, false);

	const pivot = surface.run("edit_sheet", {
		mode: "pivot",
		pivot: { rows: ["Region"], columns: "Channel", values: ["Revenue"] },
	});
	assert.equal(pivot.ok, true, pivot.result);

	const sort = surface.run("edit_sheet", {
		sort: { column: "Nope", direction: "asc" },
	});
	assert.equal(sort.ok, false);

	const measureDown = surface.run("edit_sheet", {
		pivot: { rows: ["Revenue"], values: ["Revenue"] },
	});
	assert.equal(measureDown.ok, false);
});

// --- Explore ------------------------------------------------------------------

test("an exploration is checked field by field", () => {
	const surface = exploreSurface(
		{ sourceKey: "sales", columns: ["Region"], conditions: [] },
		available,
	);
	assert.equal(surface.preferredSourceKey, "sales");
	const out = surface.run("set_exploration", {
		sourceKey: "sales",
		columns: ["Region", "Revenue"],
		conditions: [
			{ field: "Channel", op: "eq", value: "Online" },
			{ field: "Revenue", op: "gt", value: "100", join: "and" },
		],
	});
	assert.equal(out.ok, true, out.result);

	const bad = surface.run("set_exploration", {
		sourceKey: "sales",
		columns: ["Country"],
	});
	assert.equal(bad.ok, false);

	const none = surface.run("set_exploration", {
		sourceKey: "sales",
		columns: [],
	});
	assert.equal(none.ok, false);
});

// --- The editor ---------------------------------------------------------------

const pageState = {
	reportTitle: "Sales",
	pageTitle: "Overview",
	pageSourceKey: "sales",
	readOnly: false,
	canAddPage: true,
	dirty: false,
	visuals: [
		{
			visualId: "v1",
			visualType: "barChart",
			title: "By region",
			sourceKey: "sales",
			config: { dimensions: ["Region"], measures: ["Revenue"] },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
	],
};

test("visuals are added on the page's dataset and existing ones changed in place", () => {
	const surface = editorSurface(pageState, available);
	const out = surface.run("edit_page", {
		operations: [
			{
				op: "add_visual",
				visualType: "kpiRow",
				title: "Headline",
				measures: ["Revenue", "Margin Pct"],
			},
			{
				op: "update_visual",
				visualId: "v1",
				visualType: "horizontalBarChart",
			},
		],
	});
	assert.equal(out.ok, true, out.result);
	const ops = out.draft as EditorOp[];
	assert.equal(ops.length, 2);
	assert.equal(ops[0].op, "add");
	if (ops[0].op === "add") {
		assert.equal(ops[0].visual.sourceKey, "sales");
		assert.equal(ops[0].visual.layout, null);
	}
	if (ops[1].op === "update") {
		// Only the type was changed, so the fields and place are kept.
		assert.equal(ops[1].visual.visualType, "horizontalBarChart");
		assert.deepEqual(ops[1].visual.config.dimensions, ["Region"]);
		assert.deepEqual(ops[1].visual.layout, { x: 0, y: 0, w: 6, h: 6 });
	}
});

test("one bad edit refuses the whole call, and says which one", () => {
	const surface = editorSurface(pageState, available);
	const out = surface.run("edit_page", {
		operations: [
			{ op: "add_visual", visualType: "table", dimensions: ["Region"] },
			{
				op: "add_visual",
				visualType: "pieChart",
				dimensions: ["Region", "Channel"],
				measures: ["Revenue"],
			},
		],
	});
	assert.equal(out.ok, false);
	assert.match(out.result, /Operation 2/);
	assert.equal(out.draft, undefined);

	const field = surface.run("edit_page", {
		operations: [
			{
				op: "add_visual",
				visualType: "lineChart",
				dimensions: ["Order Date"],
				measures: ["Region"],
			},
		],
	});
	assert.equal(field.ok, false);
	assert.match(field.result, /dimension/);
});

test("a visual added in one call can be changed in the next", () => {
	const surface = editorSurface(pageState, available);
	const first = surface.run("edit_page", {
		operations: [
			{
				op: "add_visual",
				visualType: "table",
				dimensions: ["Region"],
				measures: ["Revenue"],
			},
		],
	});
	const added = (first.draft as EditorOp[])[0];
	assert.equal(added.op, "add");
	const id = added.op === "add" ? added.visual.visualId : "";
	const second = surface.run("edit_page", {
		operations: [{ op: "update_visual", visualId: id, title: "Detail" }],
	});
	assert.equal(second.ok, true, second.result);
	const removed = surface.run("edit_page", {
		operations: [{ op: "remove_visual", visualId: "missing" }],
	});
	assert.equal(removed.ok, false);
});

test("a new page comes first and waits for unsaved changes", () => {
	const surface = editorSurface(pageState, available);
	const late = surface.run("edit_page", {
		operations: [
			{
				op: "add_visual",
				visualType: "table",
				dimensions: ["Region"],
				measures: ["Revenue"],
			},
			{ op: "new_page", title: "Regions" },
		],
	});
	assert.equal(late.ok, false);

	const dirty = editorSurface({ ...pageState, dirty: true }, available).run(
		"edit_page",
		{ operations: [{ op: "new_page", title: "Regions" }] },
	);
	assert.equal(dirty.ok, false);
	assert.match(dirty.result, /unsaved/);

	const fresh = surface.run("edit_page", {
		operations: [
			{ op: "new_page", title: "Regions" },
			{
				op: "add_visual",
				visualType: "table",
				dimensions: ["Region"],
				measures: ["Revenue"],
			},
		],
	});
	assert.equal(fresh.ok, true, fresh.result);
	// What was on the page before is not on the new one.
	const update = surface.run("edit_page", {
		operations: [{ op: "update_visual", visualId: "v1", title: "x" }],
	});
	assert.equal(update.ok, false);
});

test("a locked page offers no edits, and text is escaped rather than read as markup", () => {
	const locked = editorSurface({ ...pageState, readOnly: true }, available);
	assert.equal(locked.tools.length, 0);
	assert.equal(
		textToHtml('<script>x</script>\n\nSecond "line"'),
		"<p>&lt;script&gt;x&lt;/script&gt;</p><p>Second &quot;line&quot;</p>",
	);
});

test("an unknown screen offers nothing", () => {
	assert.equal(buildSurface({ kind: "nope", state: {} }, available), null);
	assert.equal(buildSurface(null, available), null);
	assert.equal(
		buildSurface({ kind: "explore", state: {} }, available)?.kind,
		"explore",
	);
});

test("only settings the visual declares are taken from the model", () => {
	const surface = editorSurface(pageState, available);
	const out = surface.run("edit_page", {
		operations: [
			{
				op: "add_visual",
				visualType: "textPanel",
				options: { html: '<a href="https://example.com">Sign in</a>' },
			},
		],
	});
	assert.equal(out.ok, true, out.result);
	const op = (out.draft as EditorOp[])[0];
	assert.equal(op.op, "add");
	if (op.op === "add") {
		const options = op.visual.config.options as
			| Record<string, unknown>
			| undefined;
		assert.equal(options?.html, undefined);
	}
});

// --- Boards -------------------------------------------------------------------

test("charts, notes and arrows go on a board in rows under what is there", () => {
	const current = {
		items: [
			{
				id: "old",
				kind: "note" as const,
				x: 0,
				y: 0,
				w: 300,
				h: 200,
				text: "Kept",
			},
		],
		links: [],
	};
	const { definition, summary } = applyBoardEdit(
		current,
		{
			add: [
				{ ref: "h", kind: "text", text: "By region" },
				{
					ref: "c",
					kind: "chart",
					visualType: "barChart",
					sourceKey: "sales",
					dimensions: ["Region"],
					measures: ["Revenue"],
				},
				{
					ref: "n",
					kind: "note",
					text: "Europe leads",
					color: "green",
				},
				{ ref: "b", kind: "box", text: "Decide", fill: "teal" },
			],
			connect: [{ from: "n", to: "c", route: "orthogonal", flow: true }],
		},
		available,
		null,
	);
	assert.match(summary, /added 4/);
	const [kept, heading, chart, note, box] = definition.items;
	assert.equal(kept.id, "old");
	// The heading starts a row under the note, and the rest fill the row after it.
	assert.ok(heading.y > kept.y + kept.h);
	assert.equal(chart.y, note.y);
	assert.ok(note.x > chart.x);
	assert.equal(chart.visual?.sourceKey, "sales");
	assert.equal(note.color, "green");
	assert.equal(box.kind, "shape");
	assert.equal(box.style?.fill, "teal");
	assert.deepEqual(
		definition.links.map((l) => [l.from, l.to, l.route, l.flow]),
		[[note.id, chart.id, "orthogonal", true]],
	);
});

test("a chart on a field the dataset does not have is refused", () => {
	const surface = boardSurface(
		{ title: "B", definition: { items: [], links: [] } },
		available,
	);
	const out = surface.run("edit_board", {
		add: [
			{
				kind: "chart",
				visualType: "barChart",
				sourceKey: "sales",
				dimensions: ["Planet"],
				measures: ["Revenue"],
			},
		],
	});
	assert.equal(out.ok, false);
	assert.match(out.result, /Planet/);
});

test("a page filter is not a chart on a board", () => {
	assert.throws(
		() =>
			applyBoardEdit(
				{ items: [], links: [] },
				{
					add: [
						{
							kind: "chart",
							visualType: "dropdownFilter",
							sourceKey: "sales",
							dimensions: ["Region"],
						},
					],
				},
				available,
				null,
			),
		/does nothing on a board/,
	);
});

test("an arrow to something that is not there is refused", () => {
	assert.throws(
		() =>
			applyBoardEdit(
				{ items: [], links: [] },
				{
					add: [{ ref: "n", kind: "note", text: "x" }],
					connect: [{ from: "n", to: "ghost" }],
				},
				available,
				null,
			),
		/ghost/,
	);
});

test("a new board needs a title and something on it", () => {
	assert.throws(
		() =>
			buildNewBoard(
				{ add: [{ kind: "note", text: "x" }] },
				available,
				null,
			),
		/title/,
	);
	const made = buildNewBoard(
		{
			title: "Q3",
			add: [
				{
					kind: "chart",
					visualType: "lineChart",
					sourceKey: "sales",
					dimensions: ["Order Date"],
					measures: ["Revenue"],
				},
			],
		},
		available,
		null,
	);
	assert.equal(made.title, "Q3");
	assert.equal(made.definition.items.length, 1);
});
