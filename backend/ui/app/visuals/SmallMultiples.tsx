"use client";

import { useMemo } from "react";
import { useVisualQuery } from "../hooks/useVisualQuery";
import { queryForVisual } from "../../lib/query/visualSpec";
import { formatCompact, toNumber, type FormatHint } from "../../lib/format";
import { readThemeColors } from "./colors";
import { Sparkline } from "./Sparkline";
import { VisualError, VisualEmpty } from "./VisualFrame";
import { VisualLoadingState } from "./LoadingState";
import type { VisualStyle } from "../../lib/visuals/style";
import type { FieldMeta } from "./types";
import styles from "./Visual.module.css";

// One small chart per category, on a shared scale.
//
// Twelve regions overlaid on one line chart is twelve lines crossing each
// other, and the only thing readable in it is the top one. The same twelve as
// twelve small charts is readable at a glance, because the eye compares shapes
// side by side far better than it separates overlapping ones.
//
// The shared scale is the whole point and the thing that is easy to get wrong.
// Each panel scaled to its own range makes every region look identical, which
// is the opposite of what the reader came for: it is the differences in level
// that matter as much as the differences in shape.
//
// One query, split here. The alternative is one query per panel, which for
// twelve regions is twelve round trips for an answer the warehouse can give in
// one.
//
// Drawn as SVG rather than through ECharts. The charting library is the largest
// asset the client downloads and it is loaded only when a real chart is on the
// page, so pulling it in to draw twelve outlines would make a page of these pay
// for a renderer none of them needs.

interface SmallMultiplesProps {
	sourceKey: string;
	// The dimension that splits the panels, then the one along the bottom of
	// each.
	dimensions: string[];
	measures: string[];
	filters?: unknown[];
	fields: Map<string, FieldMeta>;
	style?: VisualStyle;
	options?: Record<string, unknown>;
}

export function SmallMultiples({
	sourceKey,
	dimensions,
	measures,
	filters,
	fields,
	options,
}: SmallMultiplesProps) {
	const [splitField, axisField] = dimensions;
	const measure = measures[0];

	const { rows, error, isLoading } = useVisualQuery(
		queryForVisual("smallMultiples", {
			sourceKey,
			dimensions,
			measures,
			filters,
			options,
		}),
	);

	const colors = useMemo(
		() => (typeof window === "undefined" ? null : readThemeColors()),
		[rows.length, isLoading],
	);

	const panels = useMemo(() => {
		const grouped = new Map<
			string,
			{ at: string; value: number | null }[]
		>();
		for (const row of rows) {
			const key = String(row[splitField] ?? "");
			const entry = {
				at: String(row[axisField] ?? ""),
				value: toNumber(row[measure]),
			};
			const bucket = grouped.get(key);
			if (bucket) bucket.push(entry);
			else grouped.set(key, [entry]);
		}

		// Ordered by how large each panel is overall, so the ones worth reading
		// come first. A dimension's own order is rarely meaningful and is
		// never a ranking.
		return [...grouped.entries()]
			.map(([label, series]) => ({
				label,
				series,
				total: series.reduce((sum, p) => sum + (p.value ?? 0), 0),
			}))
			.sort((a, b) => b.total - a.total);
	}, [rows, splitField, axisField, measure]);

	// One scale across every panel, which is what makes them comparable.
	const domain = useMemo(() => {
		const values = rows
			.map((row) => toNumber(row[measure]))
			.filter((v): v is number => v !== null);
		if (values.length === 0) return null;
		const min = Math.min(...values);
		const max = Math.max(...values);
		// Zero included, because a set of panels is read for level as well as
		// shape and a truncated axis exaggerates both.
		return { min: Math.min(0, min), max: max === min ? min + 1 : max };
	}, [rows, measure]);

	if (error) return <VisualError error={error} />;
	if (isLoading && rows.length === 0) {
		return <VisualLoadingState variant="skeleton" height={140} rows={2} />;
	}
	if (panels.length === 0 || !domain) return <VisualEmpty />;

	const hint = (fields.get(measure)?.formatHint as FormatHint) ?? "decimal";
	const columns = Math.max(1, Math.min(6, Number(options?.columns) || 3));
	const stroke = colors?.series[0];

	return (
		<div
			className={styles.multiples}
			style={{
				gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
			}}
		>
			{panels.map((panel) => {
				const values = panel.series.map((p) => p.value);
				// The latest figure rather than the total: these are read as
				// series, and where one has got to is the number beside it.
				const latest = [...values].reverse().find((v) => v !== null);
				return (
					<div key={panel.label} className={styles.multiple}>
						<div className={styles.multipleHead}>
							<span className={styles.multipleLabel}>
								{panel.label}
							</span>
							<span className={styles.multipleValue}>
								{latest === undefined
									? ""
									: formatCompact(latest, hint)}
							</span>
						</div>
						<Sparkline
							values={values}
							width={160}
							height={44}
							stretch
							domain={domain}
							color={stroke}
							fill
							label={`${panel.label}, ${measure} across ${axisField}`}
						/>
					</div>
				);
			})}
		</div>
	);
}
