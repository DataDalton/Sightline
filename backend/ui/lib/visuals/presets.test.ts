import assert from "node:assert/strict";
import { test } from "node:test";
import { visualByType } from "./catalog";
import {
	describePreset,
	presetsByType,
	unknownPresetOptions,
	unknownPresetTypes,
	visualPresets,
} from "./presets";

test("every preset names a visual type this build renders", () => {
	assert.deepEqual(unknownPresetTypes(), []);
});

test("every setting a preset carries is one its type declares", () => {
	assert.deepEqual(unknownPresetOptions(), []);
});

test("preset keys are unique", () => {
	const keys = visualPresets.map((p) => p.key);
	assert.equal(new Set(keys).size, keys.length);
});

test("every preset says what it is and when to use it", () => {
	for (const preset of visualPresets) {
		assert.ok(preset.label.trim().length > 0, preset.key);
		assert.ok(preset.blurb.trim().length > 0, preset.key);
	}
});

test("a preset's encoding limits are its type's own", () => {
	// A preset carries settings and formatting, never fields, so it can never
	// conflict with what the type will accept.
	for (const preset of visualPresets) {
		assert.equal("dimensions" in preset, false, preset.key);
		assert.equal("measures" in preset, false, preset.key);
	}
});

test("presets are grouped under the type they produce", () => {
	for (const [type, presets] of Object.entries(presetsByType)) {
		assert.ok(visualByType[type], type);
		for (const preset of presets) {
			assert.equal(preset.visualType, type);
		}
	}
});

test("every grouped preset appears exactly once", () => {
	const grouped = Object.values(presetsByType).flat();
	assert.equal(grouped.length, visualPresets.length);
});

// --- What a preset says it does --------------------------------------------

const byKey = (key: string) => visualPresets.find((p) => p.key === key)!;

test("a preset lists the settings it carries in the catalogue's words", () => {
	const said = describePreset(byKey("ranked-top-ten"));
	// The select's chosen label rather than its stored value, taken from the
	// catalogue so the card and the properties panel say the same words.
	assert.ok(said.includes("Value, largest first"), said.join(" | "));
	// The number, with the label that explains it.
	assert.ok(
		said.some((s) => s.startsWith("Keep only the top")),
		said.join(" | "),
	);
});

test("a toggle is listed only when it is on", () => {
	const on = describePreset(byKey("ranked-top-ten"));
	assert.ok(on.includes("Print values on bars"), on.join(" | "));

	// A preset that turns nothing on says nothing about it, rather than
	// listing a setting nobody chose.
	const off = describePreset(byKey("composition-donut"));
	assert.equal(
		off.some((s) => s.toLowerCase().includes("no ")),
		false,
		off.join(" | "),
	);
});

test("formatting a preset carries is described too", () => {
	// A reader choosing this should know it comes with a line across it rather
	// than find out afterwards.
	const said = describePreset(byKey("trend-with-average"));
	assert.ok(
		said.some((s) => s.includes("average")),
		said.join(" | "),
	);
});

test("every preset can say something about itself", () => {
	for (const preset of visualPresets) {
		const said = describePreset(preset);
		assert.ok(
			said.length > 0 || Object.keys(preset.options ?? {}).length === 0,
			`${preset.key} carries settings but describes none`,
		);
	}
});

test("a setting the type no longer declares is left out", () => {
	assert.deepEqual(
		describePreset({
			key: "made-up",
			label: "Made up",
			blurb: "For the test.",
			visualType: "barChart",
			options: { notASetting: true },
		}),
		[],
	);
});

test("a preset naming a type nobody renders describes nothing", () => {
	assert.deepEqual(
		describePreset({
			key: "gone",
			label: "Gone",
			blurb: "For the test.",
			visualType: "notAThing",
			options: { topN: 5 },
		}),
		[],
	);
});
