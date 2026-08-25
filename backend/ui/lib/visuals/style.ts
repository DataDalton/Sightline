// Visual styling: colours, fills, conditional formatting and tooltips.
//
// Style lives in the visual's config, which is JSONB, so adding an option needs
// no migration and an older deployment ignores what it does not understand.
//
// Two rules run through all of it:
//
//   Colour is never the only carrier of meaning. A conditional rule that turns
//   a cell red also changes its value formatting or adds a marker, because a
//   reader with colour vision deficiency, or one printing to greyscale, still
//   has to be able to read the result.
//
//   Palette entries are token names rather than hex. A chart resolves them
//   against the active theme at render time, so the same visual stays legible
//   in light and dark without storing two versions.

export type PaletteToken =
	| "chart-1"
	| "chart-2"
	| "chart-3"
	| "chart-4"
	| "chart-5"
	| "chart-6"
	| "chart-7"
	| "chart-8"
	| "brand"
	| "success"
	| "warning"
	| "danger"
	| "info";

export const paletteTokens: PaletteToken[] = [
	"chart-1",
	"chart-2",
	"chart-3",
	"chart-4",
	"chart-5",
	"chart-6",
	"chart-7",
	"chart-8",
	"brand",
	"success",
	"warning",
	"danger",
	"info",
];

// A colour is either a palette token or an explicit hex value. Tokens are
// preferred and are what the picker offers first; hex exists because a brand
// requirement sometimes names an exact colour.
export type ColorSpec = { token: PaletteToken } | { hex: string };

export function isHexColor(value: string): boolean {
	return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

// --- Series styling --------------------------------------------------------

export type FillMode = "none" | "solid" | "gradient";

export interface SeriesStyle {
	// Measure this styling applies to. Absent means it is the default for
	// every series that has no entry of its own.
	measure?: string;
	color?: ColorSpec;
	// Area fill under a line, or bar body opacity.
	fill?: FillMode;
	// 0 to 1. Applied to the fill, not to the line, so a series stays readable
	// at low fill opacity.
	fillOpacity?: number;
	// Where a gradient fades to. Defaults to fully transparent, which is the
	// usual look for an area chart.
	gradientTo?: ColorSpec | "transparent";
	lineWidth?: number;
	// Smooths a line. Off by default: a smoothed line implies data between
	// points that was never measured.
	smooth?: boolean;
	showPoints?: boolean;
	// Renders this series on a second axis, for a measure on a different scale
	// such as a percentage beside a currency.
	axis?: "left" | "right";
	// Overrides the chart type for one series, which is how a combo chart is
	// expressed.
	type?: "line" | "bar" | "area";
	stack?: string;
}

// --- Conditional formatting ------------------------------------------------

export type ConditionOperator =
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "eq"
	| "neq"
	| "between"
	| "top"
	| "bottom";

export interface ConditionRule {
	// Field the rule tests. For a table this is also the cell it paints unless
	// applyTo names another.
	field: string;
	operator: ConditionOperator;
	value?: number;
	// Upper bound for "between", or N for "top" and "bottom".
	value2?: number;
	background?: ColorSpec;
	textColor?: ColorSpec;
	bold?: boolean;
	// Text prefixed to the value when the rule matches, so the meaning
	// survives greyscale printing and colour vision deficiency.
	marker?: string;
	// Paints a different column than the one tested, for "highlight the whole
	// row where margin is negative".
	applyTo?: string | "row";
}

// A continuous scale across a column's range, which reads faster than a stack
// of threshold rules when the question is "where are the extremes".
export interface ColorScale {
	field: string;
	kind: "sequential" | "diverging";
	// Diverging scales pivot here, defaulting to zero, which is what makes
	// profit and loss read correctly.
	midpoint?: number;
	low?: ColorSpec;
	mid?: ColorSpec;
	high?: ColorSpec;
	// Renders an in-cell bar rather than a background wash. Easier to compare
	// precisely, and it survives greyscale.
	asDataBar?: boolean;
}

// The ramps offered in the editor.
//
// Named presets rather than three colour pickers, because the choice that
// matters is which ramp, not which endpoints: a gradient assembled from two
// arbitrary colours usually has a muddy middle and no ordering a reader can
// read. Custom endpoints stay available underneath for a brand requirement.
//
// Every entry is expressed in palette tokens, so a ramp follows the theme
// rather than being three hex values that look wrong in dark mode.

export interface ScaleRamp {
	id: string;
	label: string;
	kind: ColorScale["kind"];
	// What the ramp is good for, shown with it. Ramp choice is where colour
	// scales usually go wrong, so the reason sits next to the choice.
	note?: string;
	low?: ColorSpec;
	mid?: ColorSpec;
	high?: ColorSpec;
}

export const scaleRamps: ScaleRamp[] = [
	// Sequential: one direction, for finding the big values.
	{
		id: "blue",
		label: "Blue",
		kind: "sequential",
		note: "The safe default. Reads as intensity without implying good or bad.",
		high: { token: "info" },
	},
	{
		id: "teal",
		label: "Teal",
		kind: "sequential",
		high: { token: "chart-4" },
	},
	{
		id: "violet",
		label: "Violet",
		kind: "sequential",
		high: { token: "chart-3" },
	},
	{
		id: "gold",
		label: "Gold",
		kind: "sequential",
		note: "Matches the accent, so it stands out on a page that is otherwise neutral.",
		high: { token: "brand" },
	},
	{
		id: "green",
		label: "Green",
		kind: "sequential",
		note: "Implies more is better, so only use it where that is true.",
		high: { token: "success" },
	},
	{
		id: "red",
		label: "Red",
		kind: "sequential",
		note: "Implies more is worse. Right for backlog, credits or exposure.",
		high: { token: "danger" },
	},

	// Diverging: two directions from a midpoint, for above and below.
	{
		id: "red-green",
		label: "Red to green",
		kind: "diverging",
		note: "What most people expect for profit and loss. Around one man in twelve cannot separate the two ends.",
		low: { token: "danger" },
		high: { token: "success" },
	},
	{
		id: "green-red",
		label: "Green to red",
		kind: "diverging",
		note: "Reversed, for a figure where high is the bad end.",
		low: { token: "success" },
		high: { token: "danger" },
	},
	{
		id: "orange-blue",
		label: "Orange to blue",
		kind: "diverging",
		note: "The same job as red to green and legible to everyone. Prefer it where the number matters.",
		low: { token: "warning" },
		high: { token: "info" },
	},
	{
		id: "blue-orange",
		label: "Blue to orange",
		kind: "diverging",
		low: { token: "info" },
		high: { token: "warning" },
	},
];

export const rampsById: Record<string, ScaleRamp> = Object.fromEntries(
	scaleRamps.map((r) => [r.id, r]),
);

function sameSpec(a: ColorSpec | undefined, b: ColorSpec | undefined): boolean {
	if (!a || !b) return a === b;
	if ("token" in a && "token" in b) return a.token === b.token;
	if ("hex" in a && "hex" in b) return a.hex.toLowerCase() === b.hex.toLowerCase();
	return false;
}

// Which preset a scale currently matches, so the picker can show the selection
// without storing a second copy of it that could drift from the colours.
export function rampFor(scale: ColorScale): ScaleRamp | undefined {
	return scaleRamps.find(
		(ramp) =>
			ramp.kind === scale.kind &&
			sameSpec(ramp.low, scale.low) &&
			sameSpec(ramp.high, scale.high),
	);
}

// --- Tooltips --------------------------------------------------------------

export interface TooltipStyle {
	enabled?: boolean;
	// "single" shows the hovered point; "axis" shows every series at that
	// position, which is what makes a multi-series chart comparable.
	mode?: "single" | "axis";
	// Extra fields to show beyond the ones the mark encodes.
	extraFields?: string[];
	// Adds each series as a share of the total at that position.
	showShare?: boolean;
}

// --- Axes and grid ---------------------------------------------------------

export interface AxisStyle {
	label?: string;
	// A truncated axis exaggerates differences, so the default is to include
	// zero and any departure from it is a deliberate choice.
	beginAtZero?: boolean;
	min?: number;
	max?: number;
	format?: "auto" | "currency" | "percent" | "integer" | "decimal";
	showGrid?: boolean;
	// Rotates category labels when they collide.
	labelRotation?: number;
}

export interface VisualStyle {
	palette?: PaletteToken[];
	series?: SeriesStyle[];
	conditions?: ConditionRule[];
	colorScales?: ColorScale[];
	tooltip?: TooltipStyle;
	xAxis?: AxisStyle;
	yAxis?: AxisStyle;
	rightAxis?: AxisStyle;
	legend?: { show?: boolean; position?: "top" | "bottom" | "right" };
	// Bars and points; a value of 0 is square.
	cornerRadius?: number;
	// Alternating row shading in a grid. On unless turned off.
	stripedRows?: boolean;
	// Placeholder shown while the visual loads. The right choice depends on
	// what is coming: a chart-shaped skeleton holds the layout, a spinner
	// suits a tile too small for one.
	loadingAnimation?:
		| "skeleton"
		| "bars"
		| "spinner"
		| "pulse"
		| "none";
}

export const defaultStyle: VisualStyle = {
	series: [],
	conditions: [],
	colorScales: [],
	tooltip: { enabled: true, mode: "axis" },
	xAxis: { showGrid: false },
	yAxis: { beginAtZero: true, showGrid: true, format: "auto" },
	legend: { show: true, position: "top" },
	cornerRadius: 2,
	stripedRows: true,
	loadingAnimation: "skeleton",
};

// Style for one measure: its own entry if it has one, otherwise the default
// entry, otherwise nothing.
export function styleForMeasure(
	style: VisualStyle | undefined,
	measure: string,
	index: number,
): SeriesStyle {
	const entries = style?.series ?? [];
	const own = entries.find((s) => s.measure === measure);
	const fallback = entries.find((s) => !s.measure);
	const palette = style?.palette ?? [];

	return {
		// Palette position is by series index, so a chart's colours stay
		// stable as measures are added rather than reshuffling.
		color:
			own?.color ??
			fallback?.color ??
			(palette.length > 0
				? { token: palette[index % palette.length] }
				: undefined),
		fill: own?.fill ?? fallback?.fill ?? "none",
		fillOpacity: own?.fillOpacity ?? fallback?.fillOpacity ?? 0.25,
		gradientTo: own?.gradientTo ?? fallback?.gradientTo ?? "transparent",
		lineWidth: own?.lineWidth ?? fallback?.lineWidth ?? 2,
		smooth: own?.smooth ?? fallback?.smooth ?? false,
		showPoints: own?.showPoints ?? fallback?.showPoints,
		axis: own?.axis ?? fallback?.axis ?? "left",
		type: own?.type ?? fallback?.type,
		stack: own?.stack ?? fallback?.stack,
	};
}

// Evaluates the conditional rules against one row.
//
// Rules are applied in order and later matches win, so a specific rule placed
// after a general one overrides it. Returning every match rather than the
// first lets a caller combine a background from one rule with a marker from
// another.
export interface ConditionMatch {
	background?: ColorSpec;
	textColor?: ColorSpec;
	bold?: boolean;
	marker?: string;
}

export function evaluateConditions(
	rules: ConditionRule[],
	row: Record<string, unknown>,
	column: string,
	rank?: { position: number; total: number },
): ConditionMatch | null {
	// Accumulated rather than reassigned from itself, so control flow analysis
	// can see the type through the loop.
	const accumulated: ConditionMatch = {};
	let matched = false;

	for (const rule of rules) {
		const target = rule.applyTo ?? rule.field;
		if (target !== "row" && target !== column) continue;

		const raw = row[rule.field];
		const value = typeof raw === "number" ? raw : Number(raw);

		let hit = false;
		switch (rule.operator) {
			case "gt":
				hit = Number.isFinite(value) && value > (rule.value ?? 0);
				break;
			case "gte":
				hit = Number.isFinite(value) && value >= (rule.value ?? 0);
				break;
			case "lt":
				hit = Number.isFinite(value) && value < (rule.value ?? 0);
				break;
			case "lte":
				hit = Number.isFinite(value) && value <= (rule.value ?? 0);
				break;
			case "eq":
				hit = Number.isFinite(value)
					? value === rule.value
					: String(raw) === String(rule.value);
				break;
			case "neq":
				hit = Number.isFinite(value)
					? value !== rule.value
					: String(raw) !== String(rule.value);
				break;
			case "between":
				hit =
					Number.isFinite(value) &&
					value >= (rule.value ?? 0) &&
					value <= (rule.value2 ?? 0);
				break;
			case "top":
				hit = rank !== undefined && rank.position < (rule.value ?? 0);
				break;
			case "bottom":
				hit =
					rank !== undefined &&
					rank.position >= rank.total - (rule.value ?? 0);
				break;
		}

		if (!hit) continue;
		matched = true;
		// Later rules win field by field, so a specific rule placed after a
		// general one overrides only what it actually sets.
		if (rule.background !== undefined) accumulated.background = rule.background;
		if (rule.textColor !== undefined) accumulated.textColor = rule.textColor;
		if (rule.bold !== undefined) accumulated.bold = rule.bold;
		if (rule.marker !== undefined) accumulated.marker = rule.marker;
	}

	return matched ? accumulated : null;
}

// Position of a value within a column's range, for a colour scale or data bar.
// Returns null when the range is degenerate, so a column of identical values
// renders flat rather than all at one extreme.
export function scalePosition(
	value: number,
	min: number,
	max: number,
	midpoint?: number,
): { ratio: number; side: "low" | "high" } | null {
	if (!Number.isFinite(value) || min === max) return null;

	if (midpoint === undefined) {
		return { ratio: (value - min) / (max - min), side: "high" };
	}

	if (value >= midpoint) {
		const span = max - midpoint;
		return {
			ratio: span === 0 ? 0 : (value - midpoint) / span,
			side: "high",
		};
	}
	const span = midpoint - min;
	return { ratio: span === 0 ? 0 : (midpoint - value) / span, side: "low" };
}
