import assert from "node:assert/strict";
import { test } from "node:test";
import { openingFilters, resolvePreset } from "./pageDefaults";

// A page can open already narrowed. Two things then have to agree: what the
// reader's page is filtered to on arrival, and what the server warmed. They come
// from this function on both sides, so what is worth pinning here is that it is
// deterministic given a date, and that it produces nothing at all when no
// default was set.

const day = new Date(2026, 7, 25);

test("a preset resolves to the same range whoever asks", () => {
	assert.deepEqual(resolvePreset("30d", day), ["2026-07-26", "2026-08-25"]);
	assert.deepEqual(resolvePreset("YTD", day), ["2026-01-01", "2026-08-25"]);
	assert.deepEqual(resolvePreset("MTD", day), ["2026-08-01", "2026-08-25"]);
	// Quarter starting July for an August date.
	assert.deepEqual(resolvePreset("QTD", day), ["2026-07-01", "2026-08-25"]);
});

test("an unknown preset is nothing rather than a guess", () => {
	assert.equal(resolvePreset("lastFortnight", day), null);
});

test("a page with no defaults opens on everything", () => {
	const opening = openingFilters(
		[
			{
				visualId: "a",
				visualType: "dateRangeFilter",
				config: { dimensions: ["orderDate"] },
			},
			{
				visualId: "b",
				visualType: "dropdownFilter",
				config: { dimensions: ["region"] },
			},
		],
		day,
	);
	assert.deepEqual(opening, {});
});

test("a date default becomes the range the page opens on", () => {
	const opening = openingFilters(
		[
			{
				visualId: "a",
				visualType: "dateRangeFilter",
				config: {
					dimensions: ["orderDate"],
					options: { defaultPreset: "30d" },
				},
			},
		],
		day,
	);
	assert.deepEqual(opening.a, [
		{ field: "orderDate", op: "gte", value: "2026-07-26" },
		{ field: "orderDate", op: "lte", value: "2026-08-25" },
	]);
});

test("a single-choice dropdown takes one value however many were typed", () => {
	const opening = openingFilters(
		[
			{
				visualId: "b",
				visualType: "dropdownFilter",
				config: {
					dimensions: ["region"],
					options: {
						defaultValues: "North, South",
						multiple: false,
					},
				},
			},
		],
		day,
	);
	assert.deepEqual(opening.b, [
		{ field: "region", op: "eq", values: ["North"] },
	]);
});

test("a threshold default cuts the way its direction says", () => {
	const below = openingFilters(
		[
			{
				visualId: "c",
				visualType: "thresholdControl",
				config: {
					measures: ["revenue"],
					options: { defaultValue: 1000, direction: "below" },
				},
			},
		],
		day,
	);
	assert.deepEqual(below.c, [{ field: "revenue", op: "lte", value: "1000" }]);

	// Above is the fallback the catalogue declares, so an unset direction is
	// not an unset filter.
	const above = openingFilters(
		[
			{
				visualId: "c",
				visualType: "thresholdControl",
				config: {
					measures: ["revenue"],
					options: { defaultValue: 1000 },
				},
			},
		],
		day,
	);
	assert.equal(above.c?.[0]?.op, "gte");
});

test("a cutoff of zero is a cutoff, not an absence", () => {
	const opening = openingFilters(
		[
			{
				visualId: "c",
				visualType: "thresholdControl",
				config: {
					measures: ["revenue"],
					options: { defaultValue: 0 },
				},
			},
		],
		day,
	);
	assert.equal(opening.c?.[0]?.value, "0");
});

test("a flag left off contributes nothing", () => {
	const opening = openingFilters(
		[
			{
				visualId: "f",
				visualType: "toggleFilter",
				config: { dimensions: ["isOpen"] },
			},
		],
		day,
	);
	assert.deepEqual(opening, {});
});

test("a flag set on opens the page already filtered", () => {
	const opening = openingFilters(
		[
			{
				visualId: "f",
				visualType: "toggleFilter",
				config: {
					dimensions: ["isOpen"],
					options: { defaultOn: true, onValue: "Y" },
				},
			},
		],
		day,
	);
	assert.deepEqual(opening.f, [{ field: "isOpen", op: "eq", values: ["Y"] }]);
});

test("a flag with no configured value takes the catalogue's", () => {
	const opening = openingFilters(
		[
			{
				visualId: "f",
				visualType: "toggleFilter",
				config: {
					dimensions: ["isOpen"],
					options: { defaultOn: true },
				},
			},
		],
		day,
	);
	assert.deepEqual(opening.f?.[0]?.values, ["true"]);
});
