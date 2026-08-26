import assert from "node:assert/strict";
import { test } from "node:test";
import { visualByType } from "./catalog";
import { checkEncoding } from "./catalog";
import {
	buildPage,
	pageTemplates,
	slotCandidates,
	suggestedSlots,
	templateByKey,
	templateFits,
	templatesFor,
} from "./templates";

const source = {
	dimensions: [
		{ name: "Order Date", formatHint: "date" },
		{ name: "Ship Date", dataType: "TIMESTAMP" },
		{ name: "Division" },
		{ name: "Region" },
	],
	measures: [{ name: "Net Sales" }, { name: "Units" }],
	defaultTimeField: "Order Date",
};

const noDates = {
	dimensions: [{ name: "Division" }],
	measures: [{ name: "Net Sales" }],
};

// --- The templates themselves are coherent ----------------------------------

test("every template names visual types this build renders", () => {
	// The failure this catches: a template referring to a type that was renamed
	// or removed, which produces a page of empty frames.
	for (const template of pageTemplates) {
		for (const visual of template.visuals) {
			assert.ok(
				visualByType[visual.type],
				`${template.key} names ${visual.type}, which is not in the catalogue`,
			);
		}
	}
});

test("every template names only its own slots", () => {
	for (const template of pageTemplates) {
		const keys = new Set(template.slots.map((s) => s.key));
		const referenced = template.visuals.flatMap((v) => [
			...(v.dimensions ?? []),
			...(v.measures ?? []),
			...Object.values(v.options ?? {}).filter(
				(o): o is string => typeof o === "string",
			),
		]);
		for (const name of referenced) {
			const match = /^\{(.+)\}$/.exec(name);
			if (!match) continue;
			assert.ok(
				keys.has(match[1]),
				`${template.key} refers to {${match[1]}}, which is not one of its slots`,
			);
		}
	}
});

test("every template names only settings its visuals declare", () => {
	// A setting nothing reads is silently ignored, so a template that carries
	// one produces a page that quietly does not do what the template promised.
	for (const template of pageTemplates) {
		for (const visual of template.visuals) {
			const declared = new Set(
				(visualByType[visual.type].options ?? []).map((o) => o.key),
			);
			for (const key of Object.keys(visual.options ?? {})) {
				assert.ok(
					declared.has(key),
					`${template.key} sets ${key} on ${visual.type}, which does not declare it`,
				);
			}
		}
	}
});

test("a fully filled template produces visuals that satisfy their encodings", () => {
	for (const template of pageTemplates) {
		const filled = Object.fromEntries(
			template.slots.map((s) => [
				s.key,
				s.scope === "measure" ? "Net Sales" : "Division",
			]),
		);
		const page = buildPage(template, filled);
		assert.deepEqual(page.unfilled, []);
		assert.ok(page.visuals.length > 0, template.key);

		for (const visual of page.visuals) {
			const problem = checkEncoding(
				visual.visualType,
				visual.dimensions,
				visual.measures,
			);
			assert.equal(
				problem,
				null,
				`${template.key}/${visual.visualType}: ${problem?.message}`,
			);
		}
	}
});

// --- Slots ------------------------------------------------------------------

test("a temporal slot offers only dates, with the source default first", () => {
	const trend = templateByKey.trend;
	const slot = trend.slots.find((s) => s.key === "date")!;
	const candidates = slotCandidates(slot, source).map((f) => f.name);

	assert.deepEqual(candidates, ["Order Date", "Ship Date"]);
});

test("a plain slot offers everything of its kind", () => {
	const trend = templateByKey.trend;
	const split = trend.slots.find((s) => s.key === "split")!;
	assert.equal(slotCandidates(split, source).length, 4);

	const measure = trend.slots.find((s) => s.key === "measure")!;
	assert.deepEqual(
		slotCandidates(measure, source).map((f) => f.name),
		["Net Sales", "Units"],
	);
});

test("a suggestion is made where there is a defensible one and not otherwise", () => {
	const suggested = suggestedSlots(templateByKey.trend, source);

	// The source names its own time field, so this is not a guess.
	assert.equal(suggested.date, "Order Date");
	// Two measures and nothing to choose between them.
	assert.equal(suggested.measure, undefined);
	// Picking a breakdown for somebody would be arbitrary.
	assert.equal(suggested.split, undefined);
});

test("a single measure is suggested because there is nothing to choose", () => {
	const suggested = suggestedSlots(templateByKey.breakdown, noDates);
	assert.equal(suggested.measure, "Net Sales");
});

// --- Building ---------------------------------------------------------------

test("an unfilled required slot is reported and the page is not built", () => {
	const page = buildPage(templateByKey.trend, { date: "Order Date" });
	assert.deepEqual(page.unfilled, ["measure"]);
});

test("an unfilled optional slot narrows the page rather than breaking it", () => {
	const page = buildPage(templateByKey.trend, {
		date: "Order Date",
		measure: "Net Sales",
	});
	assert.deepEqual(page.unfilled, []);

	const line = page.visuals.find((v) => v.visualType === "lineChart")!;
	// One line in total, not one per value of a split nobody chose.
	assert.deepEqual(line.dimensions, ["Order Date"]);
	assert.deepEqual(line.measures, ["Net Sales"]);
});

test("filling an optional slot adds it to the visuals that use it", () => {
	const page = buildPage(templateByKey.trend, {
		date: "Order Date",
		measure: "Net Sales",
		split: "Division",
	});
	const line = page.visuals.find((v) => v.visualType === "lineChart")!;
	assert.deepEqual(line.dimensions, ["Order Date", "Division"]);
});

test("a visual left with nothing to read is dropped", () => {
	// The detail template puts a dropdown on its optional filter slot. With
	// nothing chosen, the dropdown has no field and is not placed.
	const page = buildPage(templateByKey.detail, {
		primary: "Division",
		measure: "Net Sales",
	});
	assert.equal(
		page.visuals.some((v) => v.visualType === "dropdownFilter"),
		false,
	);
	assert.equal(
		page.visuals.some((v) => v.visualType === "table"),
		true,
	);
});

test("a slot named in a setting is resolved like one named in a field", () => {
	const page = buildPage(templateByKey.comparison, {
		rows: "Division",
		columns: "Region",
		measure: "Net Sales",
	});
	const matrix = page.visuals.find((v) => v.visualType === "matrixTable")!;
	assert.equal(matrix.options.columnDimension, "Region");
});

test("a setting that is not a slot reference is carried through", () => {
	const page = buildPage(templateByKey.breakdown, {
		by: "Division",
		measure: "Net Sales",
	});
	const bars = page.visuals.find(
		(v) => v.visualType === "horizontalBarChart",
	)!;
	assert.equal(bars.options.topN, 20);
});

test("the template key travels with the built page", () => {
	const page = buildPage(templateByKey.breakdown, {
		by: "Division",
		measure: "Net Sales",
	});
	assert.equal(page.templateKey, "breakdown");
});

// --- Offering ---------------------------------------------------------------

test("a template needing a date does not fit a source without one", () => {
	assert.equal(templateFits(templateByKey.trend, noDates), false);
	assert.equal(templateFits(templateByKey.breakdown, noDates), true);
});

test("only the templates a source can complete are offered", () => {
	const offered = templatesFor(noDates).map((t) => t.key);
	assert.equal(offered.includes("trend"), false);
	assert.equal(offered.includes("overview"), false);
	assert.equal(offered.includes("breakdown"), true);

	// Everything fits a source with dates and two dimensions.
	assert.equal(templatesFor(source).length, pageTemplates.length);
});
