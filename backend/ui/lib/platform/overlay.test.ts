import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFields, toOverlay, type ViewOverlay } from "./overlay";

// The property these tests exist to protect: an editor's change reaches a
// reader who has personalised the page. Get this wrong and edits silently
// apply to some people and not others.

const available = {
	dimensions: new Set(["Division", "Business Unit", "Product Number"]),
	measures: new Set(["Net Sales", "Units", "Freight", "Discount Pct"]),
};

test("a reader with no saved view sees exactly the report", () => {
	const resolved = resolveFields(
		["Division"],
		["Net Sales", "Units"],
		null,
		available,
	);
	assert.deepEqual(resolved.dimensions, ["Division"]);
	assert.deepEqual(resolved.measures, ["Net Sales", "Units"]);
	assert.deepEqual(resolved.missing, []);
});

test("a measure an editor adds reaches a reader who saved a view", () => {
	// The reader saved when the report had Net Sales and Units, hiding Units.
	const overlay: ViewOverlay = { hiddenMeasures: ["Units"] };

	// The editor has since published Freight.
	const resolved = resolveFields(
		["Division"],
		["Net Sales", "Units", "Freight"],
		overlay,
		available,
	);

	assert.ok(
		resolved.measures.includes("Freight"),
		"a newly published measure must reach readers with saved views",
	);
	assert.ok(!resolved.measures.includes("Units"), "an explicit hide sticks");
});

test("a reader keeps a field they added that the report never had", () => {
	const overlay: ViewOverlay = { addedMeasures: ["Discount Pct"] };
	const resolved = resolveFields(["Division"], ["Net Sales"], overlay, available);
	assert.deepEqual(resolved.measures, ["Net Sales", "Discount Pct"]);
});

test("a field removed from the source is dropped and reported", () => {
	const overlay: ViewOverlay = { addedMeasures: ["Retired Measure"] };
	const resolved = resolveFields(["Division"], ["Net Sales"], overlay, available);

	assert.ok(!resolved.measures.includes("Retired Measure"));
	assert.ok(resolved.missing.includes("Retired Measure"));
});

test("hiding a field that later disappears is not reported as drift", () => {
	// The reader did not want it, and it is gone. Nothing to tell them.
	const overlay: ViewOverlay = { hiddenMeasures: ["Retired Measure"] };
	const resolved = resolveFields(
		["Division"],
		["Net Sales", "Retired Measure"],
		overlay,
		available,
	);
	assert.deepEqual(resolved.missing, []);
});

test("explicit ordering is kept and new fields follow it", () => {
	const overlay: ViewOverlay = {
		measureOrder: ["Units", "Net Sales"],
	};
	const resolved = resolveFields(
		["Division"],
		["Net Sales", "Units", "Freight"],
		overlay,
		available,
	);
	// The reader's order first, then whatever the editor added since.
	assert.deepEqual(resolved.measures, ["Units", "Net Sales", "Freight"]);
});

test("a concrete selection round-trips through the overlay", () => {
	const reportDimensions = ["Division", "Business Unit"];
	const reportMeasures = ["Net Sales", "Units"];

	// The reader drops Business Unit and Units, and adds Discount Pct.
	const overlay = toOverlay(
		reportDimensions,
		reportMeasures,
		["Division"],
		["Net Sales", "Discount Pct"],
	);

	assert.deepEqual(overlay.hiddenDimensions, ["Business Unit"]);
	assert.deepEqual(overlay.hiddenMeasures, ["Units"]);
	assert.deepEqual(overlay.addedMeasures, ["Discount Pct"]);

	const resolved = resolveFields(
		reportDimensions,
		reportMeasures,
		overlay,
		available,
	);
	assert.deepEqual(resolved.dimensions, ["Division"]);
	assert.deepEqual(resolved.measures, ["Net Sales", "Discount Pct"]);
});

test("a round-tripped selection still receives later editor additions", () => {
	const overlay = toOverlay(
		["Division"],
		["Net Sales", "Units"],
		["Division"],
		["Net Sales"],
	);

	// The editor publishes Freight after the view was saved.
	const resolved = resolveFields(
		["Division"],
		["Net Sales", "Units", "Freight"],
		overlay,
		available,
	);

	assert.ok(
		resolved.measures.includes("Freight"),
		"a saved selection must not freeze the report",
	);
	assert.ok(!resolved.measures.includes("Units"));
});
