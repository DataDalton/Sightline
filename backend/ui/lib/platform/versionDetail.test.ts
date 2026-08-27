import assert from "node:assert/strict";
import { test } from "node:test";
import { diffVersions, type FieldRow } from "./versionDetail";
import type { Snapshot } from "./versionDiff";

// A side by side is only worth opening if the rows line up and say the right
// thing on each side. These pin the pairing, the wording of a value, and the
// two cases that are easy to get backwards: a property set on one side only,
// and a property whose name comes from the catalogue rather than from the
// stored key.

const bars = (over: Record<string, unknown> = {}) => ({
	visual_id: "v1",
	page_id: "p1",
	visual_type: "barChart",
	title: "Net sales by division",
	source_key: "sales_bookings",
	config: {
		dimensions: ["Division"],
		measures: ["Net Sales"],
		options: { sortBy: "category" },
	},
	layout_x: 0,
	layout_y: 0,
	layout_w: 6,
	layout_h: 4,
	sort_order: 0,
	is_active: true,
	...over,
});

const page = (over: Record<string, unknown> = {}) => ({
	page_id: "p1",
	title: "Overview",
	config: {},
	sort_order: 0,
	is_active: true,
	...over,
});

const snapshot = (visuals: unknown[], pages: unknown[] = [page()]): Snapshot =>
	({
		visuals,
		pages,
		report: { title: "Sales", description: null },
	}) as Snapshot;

const rowFor = (fields: FieldRow[], label: string) =>
	fields.find((row) => row.label === label);

test("a measure added on one side is paired against the old list", () => {
	const diff = diffVersions(
		snapshot([bars()]),
		snapshot([
			bars({
				config: {
					dimensions: ["Division"],
					measures: ["Net Sales", "Freight"],
					options: { sortBy: "category" },
				},
			}),
		]),
		4,
		5,
	);

	assert.equal(diff.from, 4);
	assert.equal(diff.to, 5);
	assert.equal(diff.visuals.length, 1);
	assert.equal(diff.visuals[0].status, "changed");

	const measures = rowFor(diff.visuals[0].fields, "Measures");
	assert.equal(measures?.before, "Net Sales");
	assert.equal(measures?.after, "Net Sales, Freight");
	assert.equal(measures?.changed, true);
});

test("a property that did not move is carried on both sides and marked unchanged", () => {
	const diff = diffVersions(
		snapshot([bars()]),
		snapshot([bars({ layout_x: 6 })]),
		4,
		5,
	);

	const source = rowFor(diff.visuals[0].fields, "Source");
	assert.equal(source?.before, "sales_bookings");
	assert.equal(source?.after, "sales_bookings");
	assert.equal(source?.changed, false);

	const position = rowFor(diff.visuals[0].fields, "Position");
	assert.equal(position?.before, "column 1, row 1");
	assert.equal(position?.after, "column 7, row 1");
	assert.equal(position?.changed, true);
});

test("an option is named and valued the way the properties panel offers it", () => {
	const diff = diffVersions(
		snapshot([bars()]),
		snapshot([
			bars({
				config: {
					dimensions: ["Division"],
					measures: ["Net Sales"],
					options: { sortBy: "valueDesc" },
				},
			}),
		]),
		4,
		5,
	);

	const order = rowFor(diff.visuals[0].fields, "Order bars by");
	assert.equal(order?.before, "Category");
	assert.equal(order?.after, "Value, largest first");
	assert.equal(order?.changed, true);
});

test("an added visual has no left hand side and every row reads as new", () => {
	const diff = diffVersions(
		snapshot([bars()]),
		snapshot([bars(), bars({ visual_id: "v2", title: "Freight" })]),
		4,
		5,
	);

	const added = diff.visuals.find((v) => v.visualId === "v2");
	assert.equal(added?.status, "added");
	assert.equal(added?.before, null);
	assert.equal(added?.after?.name, "Freight");
	assert.ok(added?.fields.every((row) => row.before === ""));
	assert.ok(added?.fields.every((row) => row.changed));
	assert.equal(diff.counts.added, 1);
	assert.equal(diff.counts.unchanged, 1);
});

test("a removed visual keeps its values on the left and nothing on the right", () => {
	const diff = diffVersions(
		snapshot([bars(), bars({ visual_id: "v2", title: "Freight" })]),
		snapshot([bars()]),
		4,
		5,
	);

	const gone = diff.visuals.find((v) => v.visualId === "v2");
	assert.equal(gone?.status, "removed");
	assert.equal(gone?.after, null);
	assert.equal(rowFor(gone?.fields ?? [], "Title")?.before, "Freight");
	assert.ok(gone?.fields.every((row) => row.after === ""));
	assert.equal(diff.counts.removed, 1);
});

test("a deactivated visual counts as removed, the same as one that is gone", () => {
	const diff = diffVersions(
		snapshot([bars()]),
		snapshot([bars({ is_active: false })]),
		4,
		5,
	);
	assert.equal(diff.visuals[0].status, "removed");
});

test("the first version compares against nothing and adds everything", () => {
	const diff = diffVersions(null, snapshot([bars()]), null, 1);
	assert.equal(diff.from, null);
	assert.equal(diff.counts.added, 1);
	assert.equal(diff.visuals[0].before, null);
});

test("a property set on neither side is not a row", () => {
	const diff = diffVersions(snapshot([bars()]), snapshot([bars()]), 4, 5);
	assert.equal(rowFor(diff.visuals[0].fields, "Filters"), undefined);
	assert.equal(rowFor(diff.visuals[0].fields, "Sort"), undefined);
});

test("a filter clause reads as one line per clause", () => {
	const diff = diffVersions(
		snapshot([bars()]),
		snapshot([
			bars({
				config: {
					dimensions: ["Division"],
					measures: ["Net Sales"],
					filters: [
						{ field: "Region", op: "in", values: ["East", "West"] },
						{ field: "Year", op: "=", value: "2026" },
					],
				},
			}),
		]),
		4,
		5,
	);

	const filters = rowFor(diff.visuals[0].fields, "Filters");
	assert.equal(filters?.before, "");
	assert.equal(filters?.after, "Region in East, West\nYear = 2026");
});

test("a style setting is named rather than reported as restyled", () => {
	const diff = diffVersions(
		snapshot([
			bars({
				config: { style: { legend: { show: true, position: "top" } } },
			}),
		]),
		snapshot([
			bars({
				config: {
					style: { legend: { show: true, position: "right" } },
				},
			}),
		]),
		4,
		5,
	);

	const legend = rowFor(diff.visuals[0].fields, "Legend");
	assert.equal(legend?.before, "show on, position top");
	assert.equal(legend?.after, "show on, position right");
});

test("a visual moved to another page names both pages", () => {
	const pages = [
		page(),
		page({ page_id: "p2", title: "Detail", sort_order: 1 }),
	];
	const diff = diffVersions(
		snapshot([bars()], pages),
		snapshot([bars({ page_id: "p2" })], pages),
		4,
		5,
	);

	const moved = rowFor(diff.visuals[0].fields, "Page");
	assert.equal(moved?.before, "Overview");
	assert.equal(moved?.after, "Detail");
});

test("visuals come back in reading order down the page", () => {
	const top = bars({ visual_id: "top", layout_y: 0, layout_x: 6 });
	const left = bars({ visual_id: "left", layout_y: 0, layout_x: 0 });
	const below = bars({ visual_id: "below", layout_y: 4, layout_x: 0 });

	const diff = diffVersions(
		snapshot([below, top, left]),
		snapshot([below, top, left]),
		4,
		5,
	);
	assert.deepEqual(
		diff.visuals.map((v) => v.visualId),
		["left", "top", "below"],
	);
});

test("a page records how many of its visuals were touched", () => {
	const diff = diffVersions(
		snapshot([bars(), bars({ visual_id: "v2" })]),
		snapshot([bars({ layout_x: 6 }), bars({ visual_id: "v2" })]),
		4,
		5,
	);
	assert.equal(diff.pages.length, 1);
	assert.equal(diff.pages[0].touched, 1);
	assert.equal(diff.pages[0].status, "unchanged");
});

test("a snapshot with no pages recorded still places its visuals", () => {
	// Reports saved before pages went into the snapshot have histories that
	// carry visuals and nothing else. Grouping by page has to survive that or
	// the comparison comes back holding everything and showing nothing.
	const bare = (visuals: unknown[]) => ({ visuals }) as Snapshot;

	const diff = diffVersions(
		bare([bars()]),
		bare([bars({ layout_x: 6 })]),
		4,
		5,
	);

	assert.equal(diff.pages.length, 1);
	assert.equal(diff.pages[0].pageId, "p1");
	assert.equal(diff.pages[0].title, "");
	assert.equal(diff.pages[0].status, "unchanged");
	assert.equal(diff.pages[0].touched, 1);
	assert.equal(diff.pages[0].fields.length, 0);
	// No page row on either side means no name to put in a Page row either.
	assert.equal(rowFor(diff.visuals[0].fields, "Page"), undefined);
});

test("a page added in the newer version is reported as added", () => {
	const before = [page()];
	const after = [
		page(),
		page({ page_id: "p2", title: "Detail", sort_order: 1 }),
	];

	const diff = diffVersions(
		snapshot([bars()], before),
		snapshot([bars(), bars({ visual_id: "v2", page_id: "p2" })], after),
		4,
		5,
	);

	const added = diff.pages.find((p) => p.pageId === "p2");
	assert.equal(added?.status, "added");
	assert.equal(added?.titleBefore, null);
	assert.equal(added?.titleAfter, "Detail");
});

test("a page the newer version no longer has is reported as removed", () => {
	const before = [
		page(),
		page({ page_id: "p2", title: "Detail", sort_order: 1 }),
	];
	const after = [page()];

	const diff = diffVersions(
		snapshot([bars(), bars({ visual_id: "v2", page_id: "p2" })], before),
		snapshot([bars()], after),
		4,
		5,
	);

	const gone = diff.pages.find((p) => p.pageId === "p2");
	assert.equal(gone?.status, "removed");
	assert.equal(gone?.titleBefore, "Detail");
	assert.equal(gone?.titleAfter, null);
	assert.equal(gone?.title, "Detail");
});

test("a renamed page carries both names", () => {
	const diff = diffVersions(
		snapshot([bars()], [page({ title: "Overview" })]),
		snapshot([bars()], [page({ title: "Summary" })]),
		4,
		5,
	);

	assert.equal(diff.pages[0].status, "changed");
	assert.equal(diff.pages[0].titleBefore, "Overview");
	assert.equal(diff.pages[0].titleAfter, "Summary");
	assert.equal(diff.pages[0].title, "Summary");
});

test("a snapshot that recorded no pages never claims one was created", () => {
	// The older format wrote visuals and nothing else. A page absent from it
	// was not deleted and a page present only in the newer one was not
	// created: the save simply never wrote pages down.
	const bare = (visuals: unknown[]) => ({ visuals }) as Snapshot;

	const diff = diffVersions(
		bare([bars()]),
		snapshot([bars()], [page()]),
		4,
		5,
	);

	assert.equal(diff.pagesRecorded.before, false);
	assert.equal(diff.pagesRecorded.after, true);
	assert.equal(diff.pages[0].status, "unchanged");
});

test("a text panel's body is named and compared as what it says", () => {
	const panel = (html: string) =>
		bars({
			visual_id: "t1",
			visual_type: "textPanel",
			title: "Note",
			config: { options: { html } },
		});

	const diff = diffVersions(
		snapshot([panel("<p>Excludes <em>freight</em> charges.</p>")]),
		snapshot([panel("<p>Excludes freight and tax charges.</p>")]),
		4,
		5,
	);

	const text = rowFor(diff.visuals[0].fields, "Text");
	assert.equal(text?.before, "Excludes freight charges.");
	assert.equal(text?.after, "Excludes freight and tax charges.");
	assert.equal(text?.prose, true);
});

test("markup changed with no change to the words is not a change", () => {
	const panel = (html: string) =>
		bars({
			visual_id: "t1",
			visual_type: "textPanel",
			config: { options: { html } },
		});

	const diff = diffVersions(
		snapshot([panel("<p>Excludes <em>freight</em>.</p>")]),
		snapshot([panel("<p>Excludes <strong>freight</strong>.</p>")]),
		4,
		5,
	);

	assert.equal(rowFor(diff.visuals[0].fields, "Text")?.changed, false);
});

test("a title is prose and a setting is not", () => {
	const diff = diffVersions(
		snapshot([bars()]),
		snapshot([bars({ title: "Net sales by region" })]),
		4,
		5,
	);

	assert.equal(rowFor(diff.visuals[0].fields, "Title")?.prose, true);
	assert.equal(rowFor(diff.visuals[0].fields, "Source")?.prose, undefined);
	assert.equal(rowFor(diff.visuals[0].fields, "Position")?.prose, undefined);
});

test("a renamed report shows up on its own rather than against a visual", () => {
	const before = snapshot([bars()]);
	const after = {
		...snapshot([bars()]),
		report: { title: "Sales and margin", description: null },
	} as Snapshot;

	const diff = diffVersions(before, after, 4, 5);
	assert.equal(diff.report.length, 1);
	assert.equal(diff.report[0].label, "Title");
	assert.equal(diff.report[0].before, "Sales");
	assert.equal(diff.report[0].after, "Sales and margin");
});
