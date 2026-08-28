import { visualByType } from "./catalog";
import type { VisualStyle } from "./style";

// Starting points for a single visual.
//
// A page template sets up a whole page. Nothing set up one visual, so an author
// choosing a bar chart got the type's defaults and then set top N, sort order,
// value labels, palette and axis by hand, every time, for the same handful of
// arrangements they had built before.
//
// A preset is a named bundle of a type, its settings and its formatting. It is
// offered in the picker, at the moment the author is already deciding what to
// place, rather than as something to find afterwards in a panel.
//
// Deliberately not a second catalogue. A preset names a type that already
// exists and carries settings that type already declares, so a preset cannot
// express anything an author could not reach on their own, and a test checks
// that every one of them names a real type and real settings.

export interface VisualPreset {
	key: string;
	label: string;
	// One line saying when to reach for it, shown under the name.
	blurb: string;
	visualType: string;
	options?: Record<string, unknown>;
	style?: VisualStyle;
}

export const visualPresets: VisualPreset[] = [
	{
		key: "ranked-top-ten",
		label: "Top ten, ranked",
		blurb: "The ten largest, biggest first, with the figures printed on the bars.",
		visualType: "horizontalBarChart",
		options: { topN: 10, sortBy: "valueDesc", valueLabels: true },
		style: { legend: { show: false } },
	},
	{
		key: "ranked-bottom-ten",
		label: "Bottom ten, ranked",
		blurb: "The ten smallest. For finding what is failing rather than what is winning.",
		visualType: "horizontalBarChart",
		options: { topN: 10, sortBy: "valueAsc", valueLabels: true },
		style: { legend: { show: false } },
	},
	{
		key: "trend-with-average",
		label: "Trend with its average",
		blurb: "A line with the average drawn across it, so the reader can see which points are above the run rate.",
		visualType: "lineChart",
		options: { nulls: "gap" },
		style: {
			referenceLines: [
				{ id: "average", kind: "average", line: "dashed" },
			],
			yAxis: { beginAtZero: true, showGrid: true, format: "auto" },
		},
	},
	{
		key: "trend-zoomable",
		label: "Long series",
		blurb: "A line with a slider under it, for a series too long to read all at once.",
		visualType: "lineChart",
		options: { nulls: "gap", zoomSlider: true },
		style: { legend: { show: false } },
	},
	{
		key: "year-on-year",
		label: "Against last year",
		blurb: "Tiles carrying the change since the same window a year ago, with the shape of each behind it.",
		visualType: "kpiRow",
		options: { compareTo: "year" },
	},
	{
		key: "dense-table",
		label: "Dense table",
		blurb: "Compact rows and a total at the foot. About a third more rows on a screen.",
		visualType: "table",
		options: {
			density: "compact",
			fillHeight: true,
			showTotals: true,
		},
		style: { stripedRows: true },
	},
	{
		key: "share-table",
		label: "Table with shares",
		blurb: "Each row's share of the total worked out alongside the figure itself.",
		visualType: "table",
		options: { density: "compact", showTotals: true },
	},
	{
		key: "composition-donut",
		label: "Composition, tidied",
		blurb: "The largest six with everything else gathered into one slice, which is the point at which a donut stops being readable.",
		visualType: "donutChart",
		options: { groupTail: 6, sliceLabels: "percent" },
	},
	{
		key: "on-plan",
		label: "On plan or not",
		blurb: "Actual against target, furthest behind at the top, coloured by whether it cleared.",
		visualType: "bulletChart",
		options: { sortBy: "valueAsc", colourByTarget: true },
	},
	{
		key: "vital-few",
		label: "The vital few",
		blurb: "Ranked bars with the running share over them and the eighty percent line drawn in.",
		visualType: "paretoChart",
		options: { cutoff: 80 },
	},
	{
		key: "minimal-sparkline",
		label: "Bare trend",
		blurb: "No axes, no legend, no grid. For a shape sitting beside a figure rather than a chart being read on its own.",
		visualType: "lineChart",
		options: { nulls: "gap" },
		style: {
			legend: { show: false },
			xAxis: { showGrid: false },
			yAxis: { showGrid: false, beginAtZero: false },
			tooltip: { enabled: true, mode: "single" },
		},
	},
];

export const presetsByType = visualPresets.reduce<
	Record<string, VisualPreset[]>
>((map, preset) => {
	(map[preset.visualType] ??= []).push(preset);
	return map;
}, {});

// What a preset actually sets, said in the catalogue's own words.
//
// The drawing beside a preset is the drawing of the type it produces, and a
// static picture of a bar chart cannot show that this one keeps only the top
// ten and prints its values. So the settings are listed instead, read out of
// the catalogue rather than written a second time here: a select's chosen
// label, a toggle as the thing it turns on, a number as itself.
//
// A setting the type no longer declares is left out. It is already reported by
// the test that checks every preset against the catalogue, and repeating a
// stale key to an author choosing a card helps nobody.
export function describePreset(preset: VisualPreset): string[] {
	const definition = visualByType[preset.visualType];
	if (!definition) return [];

	const declared = new Map(
		(definition.options ?? []).map((option) => [option.key, option]),
	);
	const out: string[] = [];

	for (const [key, value] of Object.entries(preset.options ?? {})) {
		const option = declared.get(key);
		if (!option) continue;

		if (option.kind === "select") {
			const choice = option.choices.find((c) => c.value === value);
			if (choice) out.push(choice.label);
			continue;
		}

		if (option.kind === "toggle") {
			// Only when it is on. "Print values on bars: no" is a setting
			// nobody chose, and listing it makes the card longer for nothing.
			if (value === true) out.push(option.label);
			continue;
		}

		if (option.kind === "number" && typeof value === "number") {
			out.push(`${option.label}: ${value}`);
			continue;
		}

		if (option.kind === "text" && typeof value === "string" && value) {
			out.push(`${option.label}: ${value}`);
		}
	}

	// Formatting is part of what a preset carries, and a reader choosing one
	// should know it comes with a reference line rather than find out after.
	const references = preset.style?.referenceLines ?? [];
	for (const line of references) {
		if (line.kind !== "value") out.push(`${line.kind} line drawn across`);
	}
	if (preset.style?.legend?.show === false) out.push("No legend");

	return out;
}

// Presets naming a type this build does not render, which is the way this list
// goes stale: a type is renamed and the preset silently stops working, offering
// an author a card that produces a visual saying it cannot be drawn.
export function unknownPresetTypes(): string[] {
	return visualPresets
		.filter((preset) => !visualByType[preset.visualType])
		.map((preset) => preset.key);
}

// Settings a preset carries that its own type does not declare.
//
// The same failure in the other direction: an option key that no longer exists
// is quietly ignored by the renderer, so the preset produces something subtly
// different from what it promises.
export function unknownPresetOptions(): string[] {
	const bad: string[] = [];
	for (const preset of visualPresets) {
		const definition = visualByType[preset.visualType];
		if (!definition) continue;
		const declared = new Set(
			(definition.options ?? []).map((option) => option.key),
		);
		for (const key of Object.keys(preset.options ?? {})) {
			if (!declared.has(key)) bad.push(`${preset.key}: ${key}`);
		}
	}
	return bad;
}
