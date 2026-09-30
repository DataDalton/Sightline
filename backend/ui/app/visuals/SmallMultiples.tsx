"use client";

import { useMemo } from "react";
import { useVisualQuery } from "../hooks/useVisualQuery";
import { queryForVisual } from "../../lib/query/visualSpec";
import { formatCompact, toNumber, type FormatHint } from "../../lib/format";
import { readThemeColors } from "./colors";
import { useTheme } from "../context/ThemeContext";
import { Sparkline } from "./Sparkline";
import { VisualError, VisualEmpty } from "./VisualFrame";
import { VisualLoadingState } from "./LoadingState";
import type { VisualStyle } from "../../lib/visuals/style";
import {
	matchesSelection,
	selectionCovers,
	selectionValue,
	type SelectionPart,
} from "../../lib/visuals/selection";
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
	// Fires when a reader clicks a panel, with the value of the splitting
	// dimension that panel draws.
	onSelect?: (selection: SelectionPart[]) => void;
	// The page selection this visual made, so the chosen panel stays solid
	// and the others fade.
	selection?: SelectionPart[];
}

export function SmallMultiples({
	sourceKey,
	dimensions,
	measures,
	filters,
	fields,
	options,
	onSelect,
	selection,
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

	const { resolved: resolvedTheme } = useTheme();
	const colors = useMemo(
		() => (typeof window === "undefined" ? null : readThemeColors()),
		// Read again when the theme switches, since the palette is read off the
		// document.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[rows.length, isLoading, resolvedTheme],
	);

	const panels = useMemo(() => {
		const grouped = new Map<
			string,
			{ at: string; value: number | null }[]
		>();
		// The value each panel stands for as the row carries it, which is
		// what a click on the panel filters by.
		const raws = new Map<string, unknown>();
		for (const row of rows) {
			const key = String(row[splitField] ?? "");
			const entry = {
				at: String(row[axisField] ?? ""),
				value: toNumber(row[measure]),
			};
			const bucket = grouped.get(key);
			if (bucket) bucket.push(entry);
			else grouped.set(key, [entry]);
			if (!raws.has(key)) raws.set(key, row[splitField]);
		}

		// Ordered by how large each panel is overall, so the ones worth reading
		// come first. A dimension's own order is rarely meaningful and is
		// never a ranking.
		return [...grouped.entries()]
			.map(([label, series]) => ({
				label,
				raw: raws.get(label),
				series,
				total: series.reduce((sum, p) => sum + (p.value ?? 0), 0),
			}))
			.sort((a, b) => b.total - a.total);
	}, [rows, splitField, axisField, measure]);

	// Every period any panel has, in the order the query returned them. Each
	// panel is drawn against this whole run, so a panel missing a period leaves
	// a gap there and its points stay under the same periods as every other
	// panel's.
	const periods = useMemo(() => sharedPeriods(panels), [panels]);

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
	const marking = selectionCovers(selection, [splitField]) ? selection : null;
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
				const byPeriod = new Map(
					panel.series.map((p) => [p.at, p.value] as const),
				);
				const values = periods.map((at) => byPeriod.get(at) ?? null);
				// The latest figure rather than the total: these are read as
				// series, and where one has got to is the number beside it.
				const latest = [...values].reverse().find((v) => v !== null);
				const chosen =
					marking !== null &&
					matchesSelection(marking, { [splitField]: panel.raw });
				const pick = () =>
					onSelect?.([
						{
							field: splitField,
							values: [selectionValue(panel.raw)],
						},
					]);
				return (
					<div
						key={panel.label}
						className={`${styles.multiple} ${
							onSelect ? styles.multiplePickable : ""
						} ${chosen ? styles.multipleChosen : ""} ${
							marking && !chosen ? styles.multipleDimmed : ""
						}`}
						{...(onSelect
							? {
									role: "button",
									tabIndex: 0,
									"aria-pressed": chosen,
									onClick: pick,
									onKeyDown: (e: React.KeyboardEvent) => {
										if (
											e.key === "Enter" ||
											e.key === " "
										) {
											e.preventDefault();
											pick();
										}
									},
								}
							: {})}
					>
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
							keepSlots
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

// One order over the periods of every panel. Each panel arrives sorted by the
// query, so each is a run in the warehouse's own order, and joining the runs
// with each period placed after the ones it follows in any panel reproduces
// that order without sorting the labels again on the client.
function sharedPeriods(panels: { series: { at: string }[] }[]): string[] {
	const following = new Map<string, Set<string>>();
	const waitingOn = new Map<string, number>();
	for (const panel of panels) {
		panel.series.forEach(({ at }, index) => {
			if (!waitingOn.has(at)) {
				waitingOn.set(at, 0);
				following.set(at, new Set());
			}
			if (index === 0) return;
			const before = panel.series[index - 1].at;
			const after = following.get(before)!;
			if (before === at || after.has(at)) return;
			after.add(at);
			waitingOn.set(at, waitingOn.get(at)! + 1);
		});
	}

	// Map order is first appearance, which settles ties between periods no
	// panel relates.
	const ordered: string[] = [];
	const ready = [...waitingOn.keys()].filter((at) => waitingOn.get(at) === 0);
	while (ready.length > 0) {
		const at = ready.shift()!;
		ordered.push(at);
		for (const next of following.get(at)!) {
			const left = waitingOn.get(next)! - 1;
			waitingOn.set(next, left);
			if (left === 0) ready.push(next);
		}
	}
	// A period left over would mean two panels disagreed on the order. Kept
	// rather than dropped, at the end.
	for (const at of waitingOn.keys()) {
		if (!ordered.includes(at)) ordered.push(at);
	}
	return ordered;
}
