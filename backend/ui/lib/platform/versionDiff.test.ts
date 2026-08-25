import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSnapshots, type Snapshot } from "./versionDiff";

// A history is only worth having if the entries say something. These pin the
// wording as much as the detection, because "Removed Freight from the table"
// is the thing that tells someone whether to roll a version back and
// "updateVisual" is not.

const table = (over: Record<string, unknown> = {}) => ({
	visual_id: "v1",
	page_id: "p1",
	visual_type: "table",
	title: "table",
	source_key: "sales_bookings",
	config: { dimensions: ["Division"], measures: ["Net Sales", "Freight"] },
	layout_x: 0,
	layout_y: 0,
	layout_w: 12,
	layout_h: 6,
	is_active: true,
	...over,
});

const snapshot = (visuals: unknown[]): Snapshot =>
	({ visuals }) as Snapshot;

test("the first version is described as a creation, not as a pile of additions", () => {
	const changes = diffSnapshots(null, snapshot([table(), table({ visual_id: "v2" })]));
	assert.equal(changes.length, 1);
	assert.equal(changes[0].text, "Created the report");
});

test("a removed measure is named", () => {
	const changes = diffSnapshots(
		snapshot([table()]),
		snapshot([
			table({ config: { dimensions: ["Division"], measures: ["Net Sales"] } }),
		]),
	);
	assert.ok(changes.some((c) => c.text === "Removed Freight from the table"));
});

test("several added fields read as a sentence", () => {
	const changes = diffSnapshots(
		snapshot([table()]),
		snapshot([
			table({
				config: {
					dimensions: ["Division", "Business Unit", "Franchise"],
					measures: ["Net Sales", "Freight"],
				},
			}),
		]),
	);
	assert.ok(
		changes.some(
			(c) => c.text === "Added Business Unit and Franchise to the table",
		),
	);
});

test("reordering columns is a change, not silence", () => {
	const changes = diffSnapshots(
		snapshot([table()]),
		snapshot([
			table({ config: { dimensions: ["Division"], measures: ["Freight", "Net Sales"] } }),
		]),
	);
	assert.ok(changes.some((c) => c.text === "Reordered the measures on the table"));
});

test("a visual added and one removed are both reported", () => {
	const changes = diffSnapshots(
		snapshot([table()]),
		snapshot([table({ visual_id: "v2", visual_type: "barChart", title: "Sales by division" })]),
	);
	assert.ok(changes.some((c) => c.kind === "added"));
	assert.ok(changes.some((c) => c.kind === "removed"));
});

test("a real title is quoted and a slot name is not", () => {
	const named = diffSnapshots(
		snapshot([table()]),
		snapshot([table(), table({ visual_id: "v2", title: "Contract coverage" })]),
	);
	assert.ok(named.some((c) => c.text === 'Added "Contract coverage"'));

	const slot = diffSnapshots(
		snapshot([table()]),
		snapshot([table(), table({ visual_id: "v2", title: "kpi", visual_type: "kpiRow" })]),
	);
	assert.ok(slot.some((c) => c.text === "Added the kpi row"));
});

test("moving and resizing in one save is one entry", () => {
	const changes = diffSnapshots(
		snapshot([table()]),
		snapshot([table({ layout_x: 6, layout_w: 6 })]),
	);
	const layout = changes.filter((c) => c.kind === "moved");
	assert.equal(layout.length, 1);
	assert.equal(layout[0].text, "Moved and resized the table");
});

test("a save that changed nothing says so rather than showing an empty entry", () => {
	const changes = diffSnapshots(snapshot([table()]), snapshot([table()]));
	assert.equal(changes.length, 1);
	assert.equal(changes[0].text, "Saved with no visible change");
});

test("a subtitle edit is reported", () => {
	const before = { visuals: [table()], report: { title: "Sales", description: "Old" } };
	const after = { visuals: [table()], report: { title: "Sales", description: "New" } };
	const changes = diffSnapshots(before as Snapshot, after as Snapshot);
	assert.ok(changes.some((c) => c.text === "Changed the subtitle"));
});

test("an older snapshot with no layout recorded does not report a phantom move", () => {
	const bare = {
		visual_id: "v1",
		visual_type: "table",
		title: "table",
		config: { dimensions: ["Division"], measures: [] },
		is_active: true,
	};
	const changes = diffSnapshots(snapshot([bare]), snapshot([bare]));
	assert.ok(!changes.some((c) => c.kind === "moved"));
});
