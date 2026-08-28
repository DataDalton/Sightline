import assert from "node:assert/strict";
import { test } from "node:test";
import {
	decodeShareParams,
	encodeShareParams,
	packClauses,
	slug,
	unpackClauses,
	type ShareClause,
	type ShareContext,
	type SharedPageState,
} from "./shareState";

const context: ShareContext = {
	pages: [
		{ pageId: "page-1", title: "Overview" },
		{ pageId: "page-2", title: "Detail by region" },
	],
	widgets: [
		{ visualId: "w-date", field: "Order Date" },
		{ visualId: "w-unit", field: "Business Unit" },
		{ visualId: "w-search", field: "Product Family" },
	],
	dimensions: ["Business Unit", "Product Line", "Order Month"],
	views: [{ viewId: "view-1", name: "My quarter" }],
};

const url = (state: SharedPageState) =>
	decodeURIComponent(encodeShareParams(state, context).toString());

// --- What the address bar actually says -------------------------------------

test("a filtered page reads as something a person could have typed", () => {
	const written = url({
		page: "page-2",
		filters: {
			"w-unit": [
				{
					field: "Business Unit",
					op: "eq",
					values: ["Endoscopy", "Instruments"],
				},
			],
			"w-date": [
				{ field: "Order Date", op: "gte", value: "2026-01-01" },
				{ field: "Order Date", op: "lte", value: "2026-03-31" },
			],
		},
		dimension: "Product Line",
	});

	assert.equal(
		written,
		"page=detailByRegion&businessUnit=Endoscopy,Instruments&orderDate=2026-01-01..2026-03-31&by=productLine",
	);
});

test("the whole thing stays short", () => {
	// The same state cost 704 characters packed into one opaque parameter.
	const written = url({
		page: "page-2",
		view: "view-1",
		filters: {
			"w-date": [
				{ field: "Order Date", op: "gte", value: "2026-01-01" },
				{ field: "Order Date", op: "lte", value: "2026-03-31" },
			],
			"w-unit": [
				{
					field: "Business Unit",
					op: "eq",
					values: ["Endoscopy", "Instruments", "Medical"],
				},
			],
		},
		dimension: "Business Unit",
		grain: "Order Month",
	});
	assert.ok(
		written.length < 200,
		`expected under 200 characters, got ${written.length}: ${written}`,
	);
});

test("a report on its own first page says nothing about the page", () => {
	assert.equal(url({ page: "page-1" }), "");
});

test("a page nobody has touched writes no parameters at all", () => {
	assert.equal(url({}), "");
	assert.equal(url({ filters: {} }), "");
	assert.equal(url({ filters: { "w-unit": [] } }), "");
});

// --- Round trips ------------------------------------------------------------

const roundTrip = (state: SharedPageState) =>
	decodeShareParams(encodeShareParams(state, context), context);

test("a filter naming several values survives", () => {
	const state: SharedPageState = {
		filters: {
			"w-unit": [
				{ field: "Business Unit", op: "eq", values: ["EMEA", "APAC"] },
			],
		},
	};
	assert.deepEqual(roundTrip(state), state);
});

test("a date range survives as both of its ends", () => {
	const state: SharedPageState = {
		filters: {
			"w-date": [
				{ field: "Order Date", op: "gte", value: "2026-01-01" },
				{ field: "Order Date", op: "lte", value: "2026-03-31" },
			],
		},
	};
	assert.deepEqual(roundTrip(state), state);
});

test("an open ended range survives with only the end it has", () => {
	const state: SharedPageState = {
		filters: {
			"w-date": [{ field: "Order Date", op: "gte", value: "2026-01-01" }],
		},
	};
	assert.deepEqual(roundTrip(state), state);
	assert.equal(url(state), "orderDate=2026-01-01..");

	const upper: SharedPageState = {
		filters: {
			"w-date": [{ field: "Order Date", op: "lte", value: "2026-03-31" }],
		},
	};
	assert.deepEqual(roundTrip(upper), upper);
	assert.equal(url(upper), "orderDate=..2026-03-31");
});

test("every operator a filter widget produces survives", () => {
	const cases: [string, ShareClause][] = [
		["~hip", { field: "Product Family", op: "contains", value: "hip" }],
		["^hip", { field: "Product Family", op: "starts_with", value: "hip" }],
		["$hip", { field: "Product Family", op: "ends_with", value: "hip" }],
		["!hip", { field: "Product Family", op: "neq", value: "hip" }],
		["%hip", { field: "Product Family", op: "like", value: "hip" }],
		[">5", { field: "Product Family", op: "gt", value: "5" }],
		["<5", { field: "Product Family", op: "lt", value: "5" }],
	];
	for (const [written, clause] of cases) {
		assert.equal(packClauses([clause]), written, clause.op);
		assert.deepEqual(unpackClauses("Product Family", written), [clause]);
	}
});

test("presence filters survive as a single mark", () => {
	assert.equal(packClauses([{ field: "Region", op: "is_empty" }]), "-");
	assert.equal(packClauses([{ field: "Region", op: "is_not_empty" }]), "*");
	assert.deepEqual(unpackClauses("Region", "-"), [
		{ field: "Region", op: "is_empty" },
	]);
	assert.deepEqual(unpackClauses("Region", "*"), [
		{ field: "Region", op: "is_not_empty" },
	]);
});

test("a value containing a comma is not read as two values", () => {
	const state: SharedPageState = {
		filters: {
			"w-unit": [
				{
					field: "Business Unit",
					op: "eq",
					values: ["Smith, Jones and Co", "Acme"],
				},
			],
		},
	};
	assert.deepEqual(roundTrip(state), state);
});

test("a value containing a backslash survives", () => {
	const state: SharedPageState = {
		filters: {
			"w-unit": [
				{ field: "Business Unit", op: "eq", values: ["a\\b", "c"] },
			],
		},
	};
	assert.deepEqual(roundTrip(state), state);
});

test("the switchers and the saved view survive", () => {
	const state: SharedPageState = {
		dimension: "Product Line",
		grain: "Order Month",
		view: "view-1",
	};
	assert.deepEqual(roundTrip(state), state);
});

test("values outside ascii survive", () => {
	const state: SharedPageState = {
		filters: {
			"w-unit": [
				{ field: "Business Unit", op: "eq", values: ["Zürich"] },
			],
		},
	};
	assert.deepEqual(roundTrip(state), state);
});

// --- What a link is not allowed to do ---------------------------------------

test("a parameter for a field no control owns is dropped", () => {
	assert.equal(
		decodeShareParams(new URLSearchParams("somethingElse=EMEA"), context),
		null,
	);
});

test("two fields writing the same parameter are refused rather than guessed", () => {
	// "Order Date" and "Order date" write the same parameter, and putting a
	// filter on the wrong one of them is a wrong number shown as a right one.
	const twins: ShareContext = {
		...context,
		widgets: [
			{ visualId: "w-a", field: "Order Date" },
			{ visualId: "w-b", field: "Order date" },
		],
	};
	assert.equal(
		decodeShareParams(new URLSearchParams("orderDate=2026-01-01.."), twins),
		null,
	);
});

test("a field named after a parameter this owns does not collide with it", () => {
	const awkward: ShareContext = {
		...context,
		widgets: [{ visualId: "w-page", field: "Page" }],
	};
	const written = encodeShareParams(
		{
			page: "page-2",
			filters: {
				"w-page": [{ field: "Page", op: "eq", values: ["Three"] }],
			},
		},
		awkward,
	);
	assert.equal(written.get("page"), "detailByRegion");
	assert.equal(written.get("page_"), "Three");

	const back = decodeShareParams(written, awkward);
	assert.equal(back?.page, "page-2");
	assert.deepEqual(back?.filters?.["w-page"], [
		{ field: "Page", op: "eq", values: ["Three"] },
	]);
});

test("a link naming a page the report no longer has opens without one", () => {
	const back = decodeShareParams(
		new URLSearchParams("page=goneAway&by=productLine"),
		context,
	);
	assert.equal(back?.page, undefined);
	assert.equal(back?.dimension, "Product Line");
});

test("a link naming a view that has been deleted opens without one", () => {
	assert.equal(
		decodeShareParams(new URLSearchParams("view=notMine"), context),
		null,
	);
});

test("nothing in the address bar means nothing to apply", () => {
	assert.equal(decodeShareParams(new URLSearchParams(""), context), null);
});

test("the editor flag is not read as a filter", () => {
	assert.equal(
		decodeShareParams(new URLSearchParams("edit=1"), context),
		null,
	);
});

// --- Naming -----------------------------------------------------------------

test("a field name becomes something a person would type", () => {
	assert.equal(slug("Business Unit"), "businessUnit");
	assert.equal(slug("Order Date"), "orderDate");
	assert.equal(slug("Net Sales (USD)"), "netSalesUsd");
	assert.equal(slug("Customer Number"), "customerNumber");
	assert.equal(slug("Région"), "region");
	assert.equal(slug("ACCOUNT"), "account");
	assert.equal(slug(""), "");
});

test("a hand typed link works", () => {
	// The whole point of writing it this way: somebody can change the date in
	// the address bar and press enter.
	const back = decodeShareParams(
		new URLSearchParams("businessUnit=Endoscopy&orderDate=2026-06-01.."),
		context,
	);
	assert.deepEqual(back?.filters?.["w-unit"], [
		{ field: "Business Unit", op: "eq", values: ["Endoscopy"] },
	]);
	assert.deepEqual(back?.filters?.["w-date"], [
		{ field: "Order Date", op: "gte", value: "2026-06-01" },
	]);
});
