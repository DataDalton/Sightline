"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useVisualQuery } from "../hooks/useVisualQuery";
import { queryForVisual } from "../../lib/query/visualSpec";
import { resolveKpiGroups, type KpiGroup } from "../../lib/visuals/kpiGroups";
import {
	formatCompact,
	formatDelta,
	toNumber,
	type FormatHint,
} from "../../lib/format";
import {
	comparePeriodLabels,
	relativeChange,
	shiftDateFilters,
	type ComparePeriod,
	type DateClause,
} from "../../lib/query/compare";
import { Sparkline } from "./Sparkline";
import { evaluateConditions, type VisualStyle } from "../../lib/visuals/style";
import { readThemeColors, withAlpha } from "./colors";
import { useTheme } from "../context/ThemeContext";
import { VisualError } from "./VisualFrame";
import { VisualLoadingState } from "./LoadingState";
import { fieldTooltip, type FieldMeta } from "./types";
import {
	describeBasis,
	readTargets,
	resolveTarget,
	targetProgress,
	targetStatusLabels,
	type TargetPeriod,
	type TargetProgress,
	type TargetStatus,
} from "../../lib/visuals/kpiTargets";
import styles from "./Visual.module.css";
import targetStyles from "./KpiTarget.module.css";

// Loaded when somebody asks, since every scorecard carries the way in and few
// are followed.
const ExplainDialog = dynamic(
	() => import("../explain/ExplainDialog").then((m) => m.ExplainDialog),
	{ ssr: false },
);

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
	// What to compare each figure against, and which date the page's range
	// filter sits on. Both are needed: without the field there is no window to
	// move, and without a period there is nothing to move it to.
	compareTo?: ComparePeriod | null;
	compareField?: string | null;
	// The dimension each tile is trended over. One extra query for the row
	// rather than one per tile, since every tile reads the same shape.
	sparkline?: string | null;
	// The "targets" option as stored, a map of measure name to a target value
	// and which way is better. Read through readTargets, so a half-filled
	// entry is dropped rather than drawn against nothing.
	targets?: unknown;
}

// The shape of the status mark, so on track, close and off target differ by
// more than colour.
function StatusMark({ status }: { status: TargetStatus }) {
	return (
		<svg
			className={targetStyles.mark}
			width="10"
			height="10"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="3.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{status === "good" ? (
				<path d="M5 12.5l4.5 4.5L19 7.5" />
			) : status === "warn" ? (
				<path d="M12 5v9M12 19v0.5" />
			) : (
				<path d="M6 6l12 12M18 6L6 18" />
			)}
		</svg>
	);
}

function TargetLine({ progress }: { progress: TargetProgress }) {
	return (
		<div
			className={targetStyles.target}
			data-status={progress.status}
			title={progress.title}
		>
			<span className={targetStyles.track} aria-hidden="true">
				<span
					className={targetStyles.fill}
					style={{ width: `${progress.fill * 100}%` }}
				/>
			</span>
			<span className={targetStyles.label}>
				<StatusMark status={progress.status} />
				<span className={targetStyles.hidden}>
					{targetStatusLabels[progress.status]}.
				</span>
				{progress.text}
				<span className={targetStyles.hidden}>. {progress.title}.</span>
			</span>
		</div>
	);
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
	compareTo,
	compareField,
	sparkline,
	targets,
}: KpiRowProps) {
	// The tile whose change is being broken down, if any.
	const [explaining, setExplaining] = useState<string | null>(null);

	const { rows, error, isLoading } = useVisualQuery(
		queryForVisual("kpiRow", {
			sourceKey,
			dimensions: [],
			measures,
			filters,
		}),
	);

	// The same question about an earlier window.
	//
	// The shifted filters are an ordinary spec, so this goes through the same
	// batcher and the same cache as everything else on the page and arrives in
	// the same round trip. Null whenever the window cannot be moved, which
	// leaves the tiles showing their figures with no comparison rather than
	// comparing against a period nobody chose.
	//
	// Keyed on the serialised filters rather than the array, because the page
	// rebuilds that array on every render and keying on its identity would
	// hand back a new window every time.
	const filterKey = JSON.stringify(filters ?? []);
	const comparisonFilters = useMemo(() => {
		if (!compareTo || !compareField) return null;
		return shiftDateFilters(
			(filters ?? []) as DateClause[],
			compareField,
			compareTo,
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [compareTo, compareField, filterKey]);

	const comparison = useVisualQuery(
		comparisonFilters
			? queryForVisual("kpiRow", {
					sourceKey,
					dimensions: [],
					measures,
					filters: comparisonFilters,
				})
			: null,
	);

	// One query for the whole row rather than one per tile: every tile trends
	// over the same dimension, so they are all columns of the same answer.
	const trend = useVisualQuery(
		sparkline
			? queryForVisual("lineChart", {
					sourceKey,
					dimensions: [sparkline],
					measures,
					filters,
				})
			: null,
	);

	// Keyed on the serialised option for the same reason as the filters.
	const targetKey = JSON.stringify(targets ?? null);
	const targetByMeasure = useMemo(
		() => readTargets(targets),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[targetKey],
	);

	// The figures relative targets are measured from. Each earlier window a
	// target names is one question for every measure on the row, and the
	// other measures targets name are one more under the row's own filters.
	// A window that matches the comparison asks the same question, which the
	// batcher and cache answer once.
	const targetList = Object.values(targetByMeasure);
	const wantsPeriod = (period: TargetPeriod) =>
		Boolean(compareField) &&
		targetList.some(
			(t) => t.basis.kind === "period" && t.basis.period === period,
		);
	const periodFilters = (period: TargetPeriod) =>
		wantsPeriod(period) && compareField
			? shiftDateFilters(
					(filters ?? []) as DateClause[],
					compareField,
					period,
				)
			: null;
	const periodQuery = (period: TargetPeriod) => {
		const shifted = periodFilters(period);
		return shifted
			? queryForVisual("kpiRow", {
					sourceKey,
					dimensions: [],
					measures,
					filters: shifted,
				})
			: null;
	};
	const yearBase = useVisualQuery(periodQuery("year"));
	const quarterBase = useVisualQuery(periodQuery("quarter"));
	const monthBase = useVisualQuery(periodQuery("month"));
	const previousBase = useVisualQuery(periodQuery("previous"));
	const periodRows: Record<TargetPeriod, Record<string, unknown> | null> = {
		year: yearBase.rows[0] ?? null,
		quarter: quarterBase.rows[0] ?? null,
		month: monthBase.rows[0] ?? null,
		previous: previousBase.rows[0] ?? null,
	};
	const baseMeasures = [
		...new Set(
			targetList.flatMap((t) =>
				t.basis.kind === "measure" &&
				!measures.includes(t.basis.measure)
					? [t.basis.measure]
					: [],
			),
		),
	].sort();
	const measureBase = useVisualQuery(
		baseMeasures.length > 0
			? queryForVisual("kpiRow", {
					sourceKey,
					dimensions: [],
					measures: baseMeasures,
					filters,
				})
			: null,
	);

	const { resolved: resolvedTheme } = useTheme();
	const colors = useMemo(
		() => (typeof window === "undefined" ? null : readThemeColors()),
		// Read again when the data arrives and when the theme switches, since
		// the palette is read off the document.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[rows.length, isLoading, resolvedTheme],
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
	const earlier = comparison.rows[0] ?? null;
	const rules = style?.conditions ?? [];

	// The trend series per measure, in the order the rows came back.
	const trendFor = (measure: string): (number | null)[] =>
		trend.rows.map((r) => toNumber(r[measure]));

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

		// The change since the earlier window, when there is one to report.
		//
		// A measure that already carries its own sign is left alone: putting a
		// delta under a figure that is itself a delta gives a tile two
		// different changes and no way to tell which is which.
		const previous = earlier ? toNumber(earlier[name]) : null;
		const absolute =
			signed || numeric === null || previous === null
				? null
				: numeric - previous;
		// A percentage already is a share, so its change is the difference in
		// percentage points. A relative change of a rate reads as a second
		// percentage and is easily taken for the points.
		const inPoints = hint === "percent";
		const change = signed
			? null
			: inPoints
				? absolute
				: relativeChange(numeric, previous);

		const spark = sparkline ? trendFor(name) : [];

		const target = targetByMeasure[name];
		const base =
			!target || target.basis.kind === "fixed"
				? null
				: target.basis.kind === "period"
					? toNumber(periodRows[target.basis.period]?.[name])
					: toNumber(
							(measures.includes(target.basis.measure)
								? row
								: (measureBase.rows[0] ?? {}))[
								target.basis.measure
							],
						);
		const resolved = target ? resolveTarget(target, base) : null;
		const measured = resolved
			? targetProgress(numeric, resolved, hint)
			: null;
		// Where a relative target came from, beside how far off it is.
		const basisWords = target ? describeBasis(target, hint) : null;
		const progress =
			measured && basisWords
				? {
						...measured,
						text: `${measured.text}, ${basisWords}`,
						title: `${measured.title}. Taken from ${basisWords}`,
					}
				: measured;

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

				{/* The change, under the figure rather than beside it, so a
				    row of tiles keeps one column of figures to read down. */}
				{/* The change is also the way to what drove it, so the
				    question it raises is one click from its answer. */}
				{change !== null && (
					<button
						type="button"
						className={`${styles.kpiChange} ${styles.kpiChangeButton} ${
							change > 0
								? styles.kpiPositive
								: change < 0
									? styles.kpiNegative
									: ""
						}`}
						onClick={() => setExplaining(name)}
						title={`${
							absolute === null || inPoints
								? ""
								: `${formatDelta(absolute, hint)} against the earlier window. `
						}Click to see what drove it.`}
					>
						<span aria-hidden="true">
							{change > 0 ? "▲" : change < 0 ? "▼" : "="}
						</span>
						{inPoints
							? Math.abs(change) < 0.05
								? "no change"
								: `${change > 0 ? "+" : "-"}${Math.abs(change).toFixed(1)} pts`
							: Math.abs(change * 100) < 0.05
								? "no change"
								: `${change > 0 ? "+" : "-"}${Math.abs(change * 100).toFixed(1)}%`}
						<span className={styles.kpiWhy}>Why?</span>
					</button>
				)}

				{/* Waiting for the comparison rather than reporting there is
				    none. An empty space that later fills in reads as a tile
				    that moved; nothing at all reads as a tile with no
				    comparison, which is a different thing. */}
				{change === null && comparisonFilters !== null && (
					<span className={styles.kpiChange} aria-hidden="true">
						&nbsp;
					</span>
				)}

				{progress && <TargetLine progress={progress} />}

				{spark.length > 1 && (
					<Sparkline
						values={spark}
						label={`${name} over ${sparkline}`}
						color={explicitColor}
					/>
				)}
			</div>
		);
	};

	return (
		<div className={styles.kpiBands}>
			{explaining && comparisonFilters && compareTo && (
				<ExplainDialog
					sourceKey={sourceKey}
					measure={explaining}
					hint={
						(fields.get(explaining)?.formatHint as FormatHint) ??
						"decimal"
					}
					filters={filters ?? []}
					previousFilters={comparisonFilters}
					against={comparePeriodLabels[compareTo].toLowerCase()}
					onClose={() => setExplaining(null)}
				/>
			)}
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
