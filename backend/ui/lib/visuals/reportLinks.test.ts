import assert from "node:assert/strict";
import { test } from "node:test";
import {
	linkAddress,
	pageReceiving,
	readLinks,
	suggestTargets,
	type LinkTarget,
} from "./reportLinks";

const target: LinkTarget = {
	slug: "customer-detail",
	title: "Customer detail",
	pages: [
		{ title: "Summary", filterFields: ["Region"] },
		{ title: "Orders", filterFields: ["Customer", "Region"] },
	],
};

test("a click opens the target filtered to what was clicked", () => {
	assert.equal(
		linkAddress("customer-detail", [
			{ field: "Customer", op: "eq", values: ["Acme"] },
		]),
		"/r/customer-detail/?customer=Acme",
	);
});

test("a named page goes in the address", () => {
	assert.equal(
		linkAddress("customer-detail", [], "Order History"),
		"/r/customer-detail/?page=orderHistory",
	);
});

test("what was clicked replaces what the page was set to", () => {
	assert.equal(
		linkAddress("r", [
			{ field: "Region", op: "eq", values: ["East", "West"] },
			{ field: "Region", op: "eq", values: ["North"] },
		]),
		"/r/r/?region=North",
	);
});

test("a date range stays one range", () => {
	const address = linkAddress("r", [
		{ field: "Order Date", op: "gte", value: "2026-01-01" },
		{ field: "Order Date", op: "lte", value: "2026-03-31" },
	]);
	assert.equal(
		new URL(address, "http://x").searchParams.get("orderDate"),
		"2026-01-01..2026-03-31",
	);
});

test("the page that can take the most fields is chosen", () => {
	assert.equal(pageReceiving(target, ["Customer", "Region"]), 1);
	assert.equal(pageReceiving(target, ["Region"]), 0);
});

test("a target with no control for the field cannot receive the click", () => {
	assert.equal(pageReceiving(target, ["Product"]), null);
});

test("reports that can receive a click are suggested first", () => {
	const other: LinkTarget = { slug: "o", title: "O", pages: [] };
	const { suggested, others } = suggestTargets([other, target], ["Customer"]);
	assert.deepEqual(
		suggested.map((t) => t.slug),
		["customer-detail"],
	);
	assert.deepEqual(
		others.map((t) => t.slug),
		["o"],
	);
});

test("a malformed stored link is dropped rather than drawn", () => {
	assert.deepEqual(readLinks("nope"), []);
	assert.deepEqual(readLinks([{ title: "No slug" }, null]), []);
	assert.deepEqual(readLinks([{ slug: "a", title: "A", label: "  Go  " }]), [
		{ slug: "a", title: "A", label: "Go" },
	]);
});
