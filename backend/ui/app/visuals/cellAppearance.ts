import { toNumber } from "../../lib/format";
import {
	evaluateConditions,
	scalePosition,
	type ColorScale,
	type ConditionRule,
} from "../../lib/visuals/style";
import { mix, withAlpha, type ThemeColors } from "./colors";

// How one table cell is drawn, from its threshold rules and colour scales.
//
// A rule that paints a background also carries a marker or a weight change, so
// the meaning survives greyscale printing and does not rely on the reader
// distinguishing hues.

export interface CellAppearance {
	background?: string;
	color?: string;
	bold?: boolean;
	marker?: string;
	bar?: { width: number; color: string };
}

export interface ColumnRange {
	min: number;
	max: number;
}

export function cellAppearance(
	row: Record<string, unknown>,
	column: string,
	{
		rank,
		conditions,
		scales,
		stats,
		colors,
	}: {
		// The row's place among the others, for a top or bottom rule. Left out
		// where the rows have no one order to rank by.
		rank?: { position: number; total: number };
		conditions: ConditionRule[];
		scales: ColorScale[];
		stats: Map<string, ColumnRange>;
		colors: ThemeColors;
	},
): CellAppearance {
	const result: CellAppearance = {};

	const match = evaluateConditions(conditions, row, column, rank);
	if (match) {
		if (match.background) {
			result.background = withAlpha(
				colors.resolve(match.background, colors.series[0]),
				0.18,
			);
		}
		if (match.textColor) {
			result.color = colors.resolve(match.textColor, colors.text);
		}
		result.bold = match.bold;
		result.marker = match.marker;
	}

	const scale = scales.find((s) => s.field === column);
	if (!scale) return result;
	const range = stats.get(column);
	const value = toNumber(row[column]);
	if (!range || value === null) return result;

	const position = scalePosition(
		value,
		range.min,
		range.max,
		scale.kind === "diverging" ? (scale.midpoint ?? 0) : undefined,
	);
	if (!position) return result;

	const endpoint =
		position.side === "low"
			? colors.resolve(scale.low, colors.negative)
			: colors.resolve(scale.high, colors.positive);

	if (scale.asDataBar) {
		// A bar compares more precisely than a colour wash and reads without
		// colour at all.
		result.bar = {
			width: Math.round(position.ratio * 100),
			color: withAlpha(endpoint, 0.25),
		};
	} else {
		result.background = mix(
			colors.resolve(scale.mid, colors.surface),
			endpoint,
			position.ratio * 0.7,
		);
	}
	return result;
}
