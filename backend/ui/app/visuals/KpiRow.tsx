"use client";

import { useMemo } from "react";
import { useVisualQuery } from "../hooks/useVisualQuery";
import { queryForVisual } from "../../lib/query/visualSpec";
import { resolveKpiGroups, type KpiGroup } from "../../lib/visuals/kpiGroups";
import { formatCompact, toNumber, type FormatHint } from "../../lib/format";
import { evaluateConditions, type VisualStyle } from "../../lib/visuals/style";
import { readThemeColors, withAlpha } from "./colors";
import { VisualError } from "./VisualFrame";
import { VisualLoadingState } from "./LoadingState";
import { fieldTooltip, type FieldMeta } from "./types";
import styles from "./Visual.module.css";

// A row of headline figures. No dimensions, so the query returns exactly one
// row and each measure becomes a tile.
//
// Conditional rules are evaluated per tile against that single row, so "Net
// Sales greater than zero is green" colours the tile that holds Net Sales. An
// explicit rule always wins over the built-in growth colouring below, because
// an author who wrote a rule meant it.

interface KpiRowProps {
	sourceKey: string;
	measures: string[];
	filters?: unknown[];
	fields: Map<string, FieldMeta>;
	style?: VisualStyle;
	// Bands to split the tiles into. One query either way: the grouping is
	// about how the answer is laid out, not about what is asked for.
	groups?: KpiGroup[];
}

// A growth measure carries its own sign, so a tile colours it without anyone
// configuring a rule. Everything else stays neutral: colouring an absolute
// figure implies a judgement the data does not support.
function isSigned(name: string): boolean {
	const n = name.toLowerCase();
	return n.includes("growth") || n.includes("variance") || n.includes(" vs ");
}

export function KpiRow({
	sourceKey,
	measures,
	filters,
	fields,
	style,
	groups,
}: KpiRowProps) {
	const { rows, error, isLoading } = useVisualQuery(
		queryForVisual("kpiRow", {
			sourceKey,
			dimensions: [],
			measures,
			filters,
		}),
	);

	const colors = useMemo(
		() => (typeof window === "undefined" ? null : readThemeColors()),
		// Recomputed when the data changes, which is often enough to pick up a
		// theme switch without observing one directly.
		[rows.length, isLoading],
	);

	if (error) return <VisualError error={error} />;

	// One list, sliced. The query asked for every measure at once, so this is
	// only about how the answer is laid out.
	const bands = resolveKpiGroups(measures, groups);

	if (isLoading && rows.length === 0) {
		return (
			<div className={styles.kpiBands}>
				{bands.map((band, i) => (
					<div key={band.label ?? i} className={styles.kpiBand}>
						{band.label && (
							<span className={styles.kpiBandLabel}>
								{band.label}
							</span>
						)}
						<div className={styles.kpiRow}>
							{band.measures.map((m) => (
								<div key={m} className={styles.kpi}>
									<span className={styles.kpiLabel}>{m}</span>
									{/* Shaped like the figure that is coming, so
									    the tile does not change size when it
									    lands and the label is not left sitting
									    above an empty gap. */}
									<VisualLoadingState
										variant={
											style?.loadingAnimation ??
											"skeleton"
										}
										height={34}
										rows={1}
									/>
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		);
	}

	const row = rows[0] ?? {};
	const rules = style?.conditions ?? [];

	const tile = (name: string) => {
		const hint: FormatHint =
			(fields.get(name)?.formatHint as FormatHint) ?? "decimal";
		const raw = row[name];
		const numeric = toNumber(raw);

		// The rule tests this tile's own measure, so the row handed to
		// the evaluator is the single-row result and the column is the
		// measure the tile shows.
		const match = colors ? evaluateConditions(rules, row, name) : null;

		const signed = isSigned(name);
		const fallbackTone =
			signed && numeric !== null
				? numeric > 0
					? styles.kpiPositive
					: numeric < 0
						? styles.kpiNegative
						: ""
				: "";

		// An explicit rule overrides the built-in growth colouring.
		const explicitColor =
			match?.textColor && colors
				? colors.resolve(match.textColor, colors.text)
				: undefined;
		const background =
			match?.background && colors
				? withAlpha(
						colors.resolve(match.background, colors.series[0]),
						0.14,
					)
				: undefined;

		return (
			<div key={name} className={styles.kpi} style={{ background }}>
				<span
					className={styles.kpiLabel}
					title={fieldTooltip(fields.get(name), name)}
				>
					{name}
				</span>
				<span
					className={`${styles.kpiValue} ${explicitColor ? "" : fallbackTone}`}
					style={{
						color: explicitColor,
						fontWeight: match?.bold ? 700 : undefined,
					}}
				>
					{/* The marker carries the same meaning as the
							    colour, so the tile still reads in greyscale and
							    for a reader who cannot distinguish the hue. */}
					{match?.marker && (
						<span className={styles.kpiMarker}>{match.marker}</span>
					)}
					{signed && numeric !== null && numeric > 0 ? "+" : ""}
					{formatCompact(raw, hint)}
				</span>
			</div>
		);
	};

	return (
		<div className={styles.kpiBands}>
			{bands.map((band, i) => (
				<div key={band.label ?? i} className={styles.kpiBand}>
					{band.label && (
						<span className={styles.kpiBandLabel}>
							{band.label}
						</span>
					)}
					<div className={styles.kpiRow}>
						{band.measures.map(tile)}
					</div>
				</div>
			))}
		</div>
	);
}
