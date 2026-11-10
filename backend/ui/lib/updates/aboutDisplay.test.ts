import { test } from "node:test";
import assert from "node:assert/strict";
import { aboutLine, aboutSections, joinNames } from "./aboutDisplay";
import type { AboutItem } from "./model";

const titles: Record<string, string> = {
	orders: "Orders",
	returns: "Returns",
	stock: "Stock",
};
const names = {
	source: (key: string) => titles[key] ?? key,
	category: (id: string) => `Category ${id}`,
	report: (id: string) => `Report ${id}`,
	page: (id: string) => `Page ${id}`,
};

const added = (id: string, sourceKey: string): AboutItem => ({
	kind: "field",
	id,
	sourceKey,
	change: "added",
});

test("fields sit under their dataset, grouped by what happened to them", () => {
	const sections = aboutSections(
		[
			{
				kind: "field",
				id: "Margin",
				sourceKey: "orders",
				change: "removed",
			},
			added("Region", "orders"),
			{
				kind: "field",
				id: "Net Revenue",
				sourceKey: "orders",
				change: "renamed",
				from: "Revenue",
			},
			{ kind: "field", id: "Units", sourceKey: "orders" },
		],
		names,
	);
	assert.equal(sections.length, 1);
	assert.deepEqual(sections[0].names, ["Orders"]);
	assert.deepEqual(
		sections[0].groups.map((group) => group.change),
		["added", "renamed", "removed", null],
	);
	assert.deepEqual(sections[0].groups[1].fields, [
		{ name: "Net Revenue", from: "Revenue" },
	]);
});

test("datasets given the same changes are shown once under both names", () => {
	const sections = aboutSections(
		[
			added("Region", "orders"),
			added("Channel", "orders"),
			added("Region", "returns"),
			added("Channel", "returns"),
			added("Region", "stock"),
		],
		names,
	);
	assert.deepEqual(
		sections.map((section) => section.names),
		[["Orders", "Returns"], ["Stock"]],
	);
});

test("a dataset named on its own keeps what happened to it", () => {
	const sections = aboutSections(
		[{ kind: "source", id: "stock", change: "removed" }],
		names,
	);
	assert.deepEqual(sections, [
		{ kind: "dataset", names: ["Stock"], change: "removed", groups: [] },
	]);
});

test("reports, pages, categories and tables follow the datasets", () => {
	const sections = aboutSections(
		[
			{ kind: "report", id: "r1" },
			added("Region", "orders"),
			{ kind: "table", id: "sales.raw.orders" },
			{ kind: "report", id: "r1" },
		],
		names,
	);
	assert.deepEqual(
		sections.map((section) => [section.kind, section.names[0]]),
		[
			["dataset", "Orders"],
			["report", "Report r1"],
			["table", "sales.raw.orders"],
		],
	);
});

test("tables group under their catalog and schema by short name", () => {
	const sections = aboutSections(
		[
			{ kind: "table", id: "cat.sap.vbak" },
			{ kind: "table", id: "cat.lox.gpo" },
			{ kind: "table", id: "cat.sap.vbap" },
			{ kind: "table", id: "cat.sap.vbak" },
			{ kind: "table", id: "cat.lox.idn" },
		],
		names,
	);
	assert.deepEqual(sections, [
		{
			kind: "tables",
			names: ["cat.sap"],
			change: null,
			groups: [
				{ change: null, fields: [{ name: "vbak" }, { name: "vbap" }] },
			],
		},
		{
			kind: "tables",
			names: ["cat.lox"],
			change: null,
			groups: [
				{ change: null, fields: [{ name: "gpo" }, { name: "idn" }] },
			],
		},
	]);
});

test("a schema with one table shows that table by its full name", () => {
	const sections = aboutSections(
		[
			{ kind: "table", id: "cat.sap.vbak" },
			{ kind: "table", id: "orders_raw" },
		],
		names,
	);
	assert.deepEqual(
		sections.map((section) => [section.kind, section.names[0]]),
		[
			["table", "cat.sap.vbak"],
			["table", "orders_raw"],
		],
	);
});

test("the card line names every field and what happened to it", () => {
	const line = aboutLine(
		aboutSections(
			[
				added("Region", "orders"),
				added("Region", "returns"),
				{
					kind: "field",
					id: "Net Revenue",
					sourceKey: "stock",
					change: "renamed",
					from: "Revenue",
				},
				{ kind: "field", id: "Units", sourceKey: "stock" },
			],
			names,
		),
	);
	assert.equal(
		line,
		"Orders and Returns. Added: Region; Stock. Renamed: Revenue to Net Revenue. Units",
	);
});

test("names join with commas and a final and", () => {
	assert.equal(joinNames(["A"]), "A");
	assert.equal(joinNames(["A", "B"]), "A and B");
	assert.equal(joinNames(["A", "B", "C"]), "A, B and C");
});
