import { test } from "node:test";
import assert from "node:assert/strict";
import {
	checkReportPlan,
	checkVisual,
	layoutPage,
	newFieldEdits,
	parseJson,
	placeBelow,
	withoutFigures,
	type ReportShape,
} from "./decide";

const source = {
	sourceKey: "orders",
	dimensions: ["Region", "Channel", "Order Date", "Discount Band"],
	measures: ["Revenue", "Orders"],
};

test("a reply's JSON is found inside prose or a code fence", () => {
	assert.deepEqual(parseJson('Here it is:\n```json\n{"a": 1}\n```'), {
		a: 1,
	});
	assert.deepEqual(parseJson("[1, 2]"), [1, 2]);
	assert.equal(parseJson("no json here"), null);
	assert.equal(parseJson("{broken"), null);
});

test("a proposed visual must name real fields as the right kind", () => {
	assert.ok(
		checkVisual(
			{
				visualType: "barChart",
				title: "By band",
				dimensions: ["Discount Band"],
				measures: ["Revenue"],
			},
			source,
		).value,
	);
	assert.match(
		checkVisual(
			{
				visualType: "barChart",
				dimensions: ["Revenue"],
				measures: ["Orders"],
			},
			source,
		).reason ?? "",
		/not a dimension/,
	);
	assert.match(
		checkVisual(
			{
				visualType: "barChart",
				dimensions: ["Region"],
				measures: ["Profit"],
			},
			source,
		).reason ?? "",
		/not a measure/,
	);
	assert.match(
		checkVisual(
			{ visualType: "madeUpChart", dimensions: [], measures: [] },
			source,
		).reason ?? "",
		/not a type/,
	);
	// Page controls and text are left to people.
	assert.ok(checkVisual({ visualType: "textPanel" }, source).reason);
	assert.ok(
		checkVisual({ visualType: "filterBar", dimensions: ["Region"] }, source)
			.reason,
	);
});

test("a proposed visual must fit what its type takes", () => {
	const checked = checkVisual(
		{
			visualType: "pieChart",
			dimensions: ["Region", "Channel", "Order Date"],
			measures: ["Revenue"],
		},
		source,
	);
	assert.match(checked.reason ?? "", /takes/);
});

test("a new visual goes under everything already on the page", () => {
	const layout = placeBelow(
		[
			{ layout: { x: 0, y: 0, w: 6, h: 4 }, isActive: true },
			{ layout: { x: 6, y: 2, w: 6, h: 5 }, isActive: true },
			{ layout: { x: 0, y: 20, w: 6, h: 4 }, isActive: false },
		],
		"barChart",
	);
	assert.equal(layout.x, 0);
	assert.equal(layout.y, 7);
});

function reports(protectedReport = false): ReportShape[] {
	return [
		{
			reportId: "r1",
			slug: "orders",
			title: "Orders",
			description: null,
			protected: protectedReport,
			pages: [
				{
					pageId: "p1",
					title: "Overview",
					protected: false,
					visuals: [
						{
							visualId: "t1",
							visualType: "table",
							title: "Every order",
							sourceKey: "orders",
							dimensions: ["Region"],
							measures: ["Revenue"],
							config: {
								dimensions: ["Region"],
								measures: ["Revenue"],
								options: { pageSize: 50 },
							},
							layout: { x: 0, y: 0, w: 12, h: 6 },
							isActive: true,
						},
					],
				},
			],
		},
	];
}

test("a new field is added where the plan says, keeping the rest of the visual", () => {
	let n = 0;
	const { byReport, done, skipped } = newFieldEdits(
		{
			edits: [
				{ do: "addToVisual", visualId: "t1" },
				{
					do: "addVisual",
					pageId: "p1",
					visualType: "barChart",
					title: "By band",
					dimensions: ["Discount Band"],
					measures: ["Revenue"],
				},
				{
					do: "addVisual",
					pageId: "p1",
					visualType: "barChart",
					title: "Not about it",
					dimensions: ["Region"],
					measures: ["Revenue"],
				},
				{ do: "addToVisual", visualId: "nowhere" },
			],
		},
		"Discount Band",
		"dimension",
		source,
		reports(),
		() => `new-${++n}`,
	);
	const operations = byReport.get("r1") ?? [];
	assert.equal(operations.length, 2);
	const update = operations[0] as { config: Record<string, unknown> };
	assert.deepEqual(update.config.dimensions, ["Region", "Discount Band"]);
	assert.deepEqual(update.config.options, { pageSize: 50 });
	const added = operations[1] as { layout: { y: number } };
	assert.equal(added.layout.y, 6);
	assert.equal(done.length, 2);
	assert.equal(skipped.length, 2);
});

test("a protected report is not changed by a new field", () => {
	const { byReport, skipped } = newFieldEdits(
		{ edits: [{ do: "addToVisual", visualId: "t1" }] },
		"Discount Band",
		"dimension",
		source,
		reports(true),
		() => "x",
	);
	assert.equal(byReport.size, 0);
	assert.match(skipped[0], /protected/);
});

test("a report plan keeps its valid visuals and says what it dropped", () => {
	const { report, skipped } = checkReportPlan(
		{
			title: "Orders at a glance",
			pages: [
				{
					title: "Overview",
					visuals: [
						{
							visualType: "kpiRow",
							measures: ["Revenue", "Orders"],
						},
						{
							visualType: "lineChart",
							dimensions: ["Order Date"],
							measures: ["Revenue"],
						},
						{
							visualType: "barChart",
							dimensions: ["Region"],
							measures: ["Profit"],
						},
					],
				},
				{ title: "Empty", visuals: [{ visualType: "nope" }] },
			],
		},
		source,
		"Orders",
	);
	assert.equal(report?.pages.length, 1);
	assert.equal(report?.pages[0].visuals.length, 2);
	assert.equal(skipped.length, 2);
	assert.equal(checkReportPlan({ pages: [] }, source, "Orders").report, null);
});

test("a page is laid out in rows across the grid", () => {
	const placed = layoutPage([
		{
			visualType: "barChart",
			title: "a",
			dimensions: ["Region"],
			measures: ["Revenue"],
		},
		{
			visualType: "barChart",
			title: "b",
			dimensions: ["Region"],
			measures: ["Revenue"],
		},
		{
			visualType: "barChart",
			title: "c",
			dimensions: ["Region"],
			measures: ["Revenue"],
		},
	]);
	for (const { layout } of placed) assert.ok(layout.x + layout.w <= 12);
	assert.ok(placed[2].layout.y >= placed[0].layout.y);
});

test("written text keeps no figures", () => {
	assert.equal(
		withoutFigures(
			"Discount band splits revenue clearly. Online is 41% of it. Use it as a filter.",
		),
		"Discount band splits revenue clearly. Use it as a filter.",
	);
});
