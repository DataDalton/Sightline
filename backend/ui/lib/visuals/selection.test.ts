import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canSelect,
	matchesSelection,
	partsFromClauses,
	selectionClauses,
	selectionCovers,
	selectionFromClick,
	selectionLabel,
	selectionValue,
} from "./selection";

// --- Values ------------------------------------------------------------------

test("a plain date is sent unchanged", () => {
	assert.equal(selectionValue("2026-03-01"), "2026-03-01");
});

test("a timestamp at midnight is sent as the plain date", () => {
	assert.equal(selectionValue("2026-03-01T00:00:00"), "2026-03-01");
	assert.equal(selectionValue("2026-03-01 00:00:00.000"), "2026-03-01");
	assert.equal(selectionValue("2026-03-01T00:00:00Z"), "2026-03-01");
});

test("a timestamp with a time of day is left alone", () => {
	assert.equal(selectionValue("2026-03-01T14:30:00"), "2026-03-01T14:30:00");
});

test("a number is sent as its text and a missing value as a blank", () => {
	assert.equal(selectionValue(42), "42");
	assert.equal(selectionValue(null), "");
	assert.equal(selectionValue(undefined), "");
});

// --- Which types take a click ------------------------------------------------

test("a gauge and a histogram have no value to select", () => {
	assert.equal(canSelect("gauge", ["Region"]), false);
	assert.equal(canSelect("histogramChart", ["Customer"]), false);
});

test("a box plot takes a click only when it draws one box per group", () => {
	assert.equal(canSelect("boxPlot", ["Customer"]), false);
	assert.equal(canSelect("boxPlot", ["Region", "Customer"]), true);
});

test("a chart with no dimension has nothing to select", () => {
	assert.equal(canSelect("barChart", []), false);
});

// --- Reading a click back ----------------------------------------------------

test("a bar selects its category on the first dimension", () => {
	assert.deepEqual(
		selectionFromClick("barChart", ["Region"], ["Sales"], {
			name: "North",
			seriesName: "Sales",
		}),
		[{ field: "Region", values: ["North"] }],
	);
});

test("a blank category selects a blank", () => {
	assert.deepEqual(
		selectionFromClick("barChart", ["Region"], ["Sales"], { name: "" }),
		[{ field: "Region", values: [""] }],
	);
});

test("a click with no name selects nothing", () => {
	assert.equal(
		selectionFromClick("barChart", ["Region"], ["Sales"], {}),
		null,
	);
});

test("a gauge click selects nothing", () => {
	assert.equal(
		selectionFromClick("gauge", ["Region"], ["Sales"], { name: "Sales" }),
		null,
	);
});

test("a slope point selects its line rather than its end of the axis", () => {
	assert.deepEqual(
		selectionFromClick("slopeChart", ["Region"], ["Sales"], {
			name: "After",
			seriesName: "North",
		}),
		[{ field: "Region", values: ["North"] }],
	);
});

test("a segment of a split stack selects its category and its series", () => {
	assert.deepEqual(
		selectionFromClick("stackedBarChart", ["Month", "Status"], ["Count"], {
			name: "2026-01-01",
			seriesName: "Open",
		}),
		[
			{ field: "Month", values: ["2026-01-01"] },
			{ field: "Status", values: ["Open"] },
		],
	);
});

test("a stack of several measures selects only the category", () => {
	assert.deepEqual(
		selectionFromClick("stackedBarChart", ["Month"], ["Online", "Retail"], {
			name: "2026-01-01",
			seriesName: "Online",
		}),
		[{ field: "Month", values: ["2026-01-01"] }],
	);
});

test("a treemap group selects the first dimension", () => {
	assert.deepEqual(
		selectionFromClick("treemapChart", ["Division", "Unit"], ["Sales"], {
			name: "Medical",
			treePathInfo: [{ name: "" }, { name: "Medical" }],
		}),
		[{ field: "Division", values: ["Medical"] }],
	);
});

test("a treemap tile selects its group and itself", () => {
	assert.deepEqual(
		selectionFromClick("treemapChart", ["Division", "Unit"], ["Sales"], {
			name: "Spine",
			treePathInfo: [
				{ name: "" },
				{ name: "Medical" },
				{ name: "Spine" },
			],
		}),
		[
			{ field: "Division", values: ["Medical"] },
			{ field: "Unit", values: ["Spine"] },
		],
	);
});

test("a sankey node selects its own side by the row value", () => {
	assert.deepEqual(
		selectionFromClick("sankeyChart", ["From", "To"], ["Count"], {
			dataType: "node",
			name: "to Closed",
			data: { name: "to Closed", raw: "Closed", side: 1 },
		}),
		[{ field: "To", values: ["Closed"] }],
	);
});

test("a sankey link selects both ends", () => {
	assert.deepEqual(
		selectionFromClick("sankeyChart", ["From", "To"], ["Count"], {
			dataType: "edge",
			data: { raws: ["Open", "Closed"] },
		}),
		[
			{ field: "From", values: ["Open"] },
			{ field: "To", values: ["Closed"] },
		],
	);
});

test("a heatmap cell selects its row and its column", () => {
	assert.deepEqual(
		selectionFromClick("heatmapChart", ["Weekday", "Hour"], ["Orders"], {
			data: { value: [3, 1, 12], raws: ["Tuesday", 9] },
		}),
		[
			{ field: "Weekday", values: ["Tuesday"] },
			{ field: "Hour", values: ["9"] },
		],
	);
});

test("a calendar day selects the plain date", () => {
	assert.deepEqual(
		selectionFromClick("calendarChart", ["Order Date"], ["Orders"], {
			value: ["2026-02-14", 31],
		}),
		[{ field: "Order Date", values: ["2026-02-14"] }],
	);
});

test("a map region selects every value in the data that landed on it", () => {
	assert.deepEqual(
		selectionFromClick("choroplethChart", ["Country"], ["Sales"], {
			name: "United States",
			data: { raws: ["USA", "United States of America"] },
		}),
		[{ field: "Country", values: ["USA", "United States of America"] }],
	);
});

test("a map region with no data selects nothing", () => {
	assert.equal(
		selectionFromClick("choroplethChart", ["Country"], ["Sales"], {
			name: "Chad",
		}),
		null,
	);
});

test("the gathered slice of a pie selects nothing", () => {
	assert.equal(
		selectionFromClick("pieChart", ["Channel"], ["Sales"], {
			name: "Other (4)",
			data: { name: "Other (4)", tail: true },
		}),
		null,
	);
});

test("a grouped box selects its group", () => {
	assert.deepEqual(
		selectionFromClick("boxPlot", ["Region", "Customer"], ["Sales"], {
			name: "West",
		}),
		[{ field: "Region", values: ["West"] }],
	);
});

// --- Filters and labels -------------------------------------------------------

test("a selection becomes an equality filter per field", () => {
	assert.deepEqual(
		selectionClauses([
			{ field: "Region", values: ["North"] },
			{ field: "Channel", values: ["Online", "Retail"] },
		]),
		[
			{ field: "Region", op: "eq", values: ["North"] },
			{ field: "Channel", op: "eq", values: ["Online", "Retail"] },
		],
	);
});

test("a blank becomes a missing value test", () => {
	assert.deepEqual(selectionClauses([{ field: "Region", values: [""] }]), [
		{ field: "Region", op: "is_empty" },
	]);
});

test("clauses read back into the selection they came from", () => {
	const parts = [
		{ field: "Region", values: [""] },
		{ field: "Month", values: ["2026-01-01"] },
	];
	assert.deepEqual(partsFromClauses(selectionClauses(parts)), parts);
});

test("a single value clause reads back too", () => {
	assert.deepEqual(
		partsFromClauses([{ field: "Region", op: "eq", value: "North" }]),
		[{ field: "Region", values: ["North"] }],
	);
});

test("the label names the field and the value", () => {
	assert.equal(
		selectionLabel(
			[
				{ field: "region", values: ["North"] },
				{ field: "channel", values: [""] },
			],
			(field) => (field === "region" ? "Region" : field),
		),
		"Region: North, channel: (blank)",
	);
});

test("the label shows a date the way dates are shown elsewhere", () => {
	const label = selectionLabel([{ field: "Month", values: ["2026-01-05"] }]);
	assert.notEqual(label, "Month: 2026-01-05");
	assert.ok(label.startsWith("Month: "));
});

test("the label counts a long list rather than spelling it out", () => {
	assert.equal(
		selectionLabel([{ field: "Month", values: ["a", "b", "c", "d"] }]),
		"Month: 4 selected",
	);
});

// --- Marking --------------------------------------------------------------------

test("a mark matches when every field it carries is selected", () => {
	const parts = [
		{ field: "Division", values: ["Medical"] },
		{ field: "Unit", values: ["Spine"] },
	];
	assert.equal(
		matchesSelection(parts, { Division: "Medical", Unit: "Spine" }),
		true,
	);
	assert.equal(
		matchesSelection(parts, { Division: "Medical", Unit: "Knee" }),
		false,
	);
});

test("a group containing the selected tile counts as selected", () => {
	const parts = [
		{ field: "Division", values: ["Medical"] },
		{ field: "Unit", values: ["Spine"] },
	];
	assert.equal(matchesSelection(parts, { Division: "Medical" }), true);
	assert.equal(matchesSelection(parts, { Division: "Surgical" }), false);
});

test("a timestamp row matches a selection of its plain date", () => {
	assert.equal(
		matchesSelection([{ field: "Day", values: ["2026-01-05"] }], {
			Day: "2026-01-05T00:00:00",
		}),
		true,
	);
});

test("a missing row value matches a blank selection", () => {
	assert.equal(
		matchesSelection([{ field: "Region", values: [""] }], {
			Region: null,
		}),
		true,
	);
});

test("a selection on a field the visual does not draw covers nothing", () => {
	assert.equal(
		selectionCovers([{ field: "Region", values: ["North"] }], ["Channel"]),
		false,
	);
	assert.equal(selectionCovers(undefined, ["Channel"]), false);
	assert.equal(
		selectionCovers([{ field: "Region", values: ["North"] }], ["Region"]),
		true,
	);
});
