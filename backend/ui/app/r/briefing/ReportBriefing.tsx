"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import type { FormatHint } from "../../../lib/format";
import { formatCompact, formatValue } from "../../../lib/format";
import {
	comparePeriodLabels,
	shiftDateFilters,
	type ComparePeriod,
	type DateClause,
} from "../../../lib/query/compare";
import { queryForVisual } from "../../../lib/query/visualSpec";
import {
	describeBasis,
	resolveTarget,
	type TargetDirection,
} from "../../../lib/visuals/kpiTargets";
import {
	judge,
	lastFullMonth,
	monthName,
	orderSections,
	planSections,
	readBriefingSettings,
	settledWindow,
	startsFolded,
	usualWindows,
	whyLine,
	windowField,
	type BriefingSettings,
	type SectionPlan,
	type Verdict,
} from "../../../lib/visuals/briefing";
import { useVisualQuery } from "../../hooks/useVisualQuery";
import { LiveText } from "../../visuals/InsightParts";
import { usePageFilters } from "../../visuals/PageFilters";
import {
	fieldMap,
	isTemporalField,
	type SourceMeta,
} from "../../visuals/types";
import { VisualRenderer, type VisualSpec } from "../../visuals/VisualRenderer";
import styles from "./Briefing.module.css";

// The Briefing form of a report page. See lib/visuals/briefing for how the
// sections are drafted and judged. Every figure here is asked for as the reader
// with the page's filters, through the same batched queries the page's visuals
// use, so the Briefing and the Analysis grid never disagree.

// How tall the charts beside a section's figures are drawn.
const detailHeight = 280;

function toNumber(raw: unknown): number | null {
	if (raw === null || raw === undefined || raw === "") return null;
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) ? n : null;
}

function isoToday(): string {
	const now = new Date();
	const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
	return local.toISOString().slice(0, 10);
}

// What the earlier window is called in a sentence.
function previousLabel(period: ComparePeriod): string {
	return period === "previous"
		? "the period before"
		: comparePeriodLabels[period].toLowerCase();
}

// The window a page is filtered to, in words, such as "Nov 1 to Nov 17, 2026".
function windowWords(filters: DateClause[], field: string): string | null {
	const from = filters.find(
		(c) => c.field === field && (c.op === "gte" || c.op === "gt"),
	);
	const to = filters.find(
		(c) => c.field === field && (c.op === "lt" || c.op === "lte"),
	);
	if (!from?.value || !to?.value) return null;
	const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
	const end = day(to.value);
	if (to.op === "lt") end.setUTCDate(end.getUTCDate() - 1);
	const short = (d: Date, year: boolean) =>
		d.toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: year ? "numeric" : undefined,
			timeZone: "UTC",
		});
	return `${short(day(from.value), false)} to ${short(end, true)}`;
}

interface SectionState {
	verdict: Verdict;
	loaded: boolean;
}

export function ReportBriefing({
	visuals,
	sources,
	reportId,
	pageId,
	pageSourceKey,
	pageConfig,
	canEdit,
	onSaveSettings,
}: {
	visuals: VisualSpec[];
	sources: Record<string, SourceMeta>;
	reportId: string;
	pageId: string;
	pageSourceKey: string | null;
	pageConfig: Record<string, unknown> | null | undefined;
	canEdit: boolean;
	onSaveSettings: (next: BriefingSettings) => Promise<boolean>;
}) {
	const plans = useMemo(
		() => planSections(visuals, pageSourceKey),
		[visuals, pageSourceKey],
	);
	const stored = useMemo(
		() => readBriefingSettings(pageConfig?.briefing),
		[pageConfig],
	);
	// Shown at once while a change saves, so the page answers the click.
	const [settings, setSettings] = useState<BriefingSettings>(stored);
	useEffect(() => setSettings(stored), [stored]);
	const save = useCallback(
		async (next: BriefingSettings) => {
			setSettings(next);
			if (!(await onSaveSettings(next))) setSettings(stored);
		},
		[onSaveSettings, stored],
	);

	const [states, setStates] = useState<Record<string, SectionState>>({});
	const report = useCallback((measure: string, state: SectionState) => {
		setStates((held) =>
			held[measure]?.verdict === state.verdict &&
			held[measure]?.loaded === state.loaded
				? held
				: { ...held, [measure]: state },
		);
	}, []);

	const shown = plans.filter((p) => !settings.hidden.includes(p.measure));
	const hidden = plans.filter((p) => settings.hidden.includes(p.measure));
	const allLoaded = shown.every((p) => states[p.measure]?.loaded);
	// Put in order once every section knows how it stands, so the page moves
	// once rather than each time a figure lands.
	const ordered = useMemo(() => {
		if (!allLoaded) return shown;
		return orderSections(
			shown.map((p) => ({ ...p, verdict: states[p.measure].verdict })),
			settings.order,
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [allLoaded, JSON.stringify(settings.order), shown.length]);
	const position = new Map(ordered.map((p, i) => [p.measure, i]));
	// A chart showing two measures is drawn once, in whichever of their
	// sections reads first, rather than repeated further down.
	const chartsFor = new Map<string, string[]>();
	const placed = new Set<string>();
	for (const p of ordered) {
		const own = p.supporting.filter((id) => !placed.has(id));
		own.forEach((id) => placed.add(id));
		chartsFor.set(p.measure, own);
	}

	// Sections that are fine fold only when something else needs a look.
	// With nothing off, folding them would leave a page of bare headlines.
	const anyOff = shown.some((p) => {
		const v = states[p.measure]?.verdict;
		return Boolean(v && (v.off || v.tone === "bad" || v.tone === "warn"));
	});
	const counts = { attention: 0, unusual: 0, fine: 0 };
	for (const p of shown) {
		const v = states[p.measure]?.verdict;
		if (!v) continue;
		if (v.tone === "bad" || v.tone === "warn") counts.attention++;
		else if (v.off) counts.unusual++;
		else counts.fine++;
	}

	const { clausesFor } = usePageFilters();
	const firstAnchor = visuals.find((v) => v.visualId === plans[0]?.anchorId);
	const pageFilters = firstAnchor
		? ([
				...clausesFor(firstAnchor.visualId),
				...((firstAnchor.config.filters ?? []) as unknown[]),
			] as DateClause[])
		: [];
	const field = plans[0]?.compareField || windowField(pageFilters);
	// A page of all dates is briefed on its last full month, so the summary
	// names that month.
	const monthField = windowField(pageFilters)
		? null
		: plans[0]?.compareField ||
			sources[plans[0]?.sourceKey ?? ""]?.defaultTimeField ||
			null;
	const period = monthField
		? `${monthName(lastFullMonth([], monthField, isoToday()), monthField)}, the last full month`
		: field
			? windowWords(pageFilters, field)
			: null;

	const move = (measure: string, step: -1 | 1) => {
		const current = ordered.map((p) => p.measure);
		const at = current.indexOf(measure);
		const to = at + step;
		if (at === -1 || to < 0 || to >= current.length) return;
		[current[at], current[to]] = [current[to], current[at]];
		void save({ ...settings, order: current });
	};

	return (
		<div className={styles.briefing}>
			<div className={styles.summary}>
				<span className={styles.summaryPeriod}>
					{period ?? "All dates"}
				</span>
				{allLoaded ? (
					<span className={styles.summaryCounts}>
						{counts.attention > 0 && (
							<span data-tone="bad">
								{counts.attention} need
								{counts.attention === 1 ? "s" : ""} attention
							</span>
						)}
						{counts.unusual > 0 && (
							<span data-tone="neutral">
								{counts.unusual} unusual
							</span>
						)}
						{counts.fine > 0 && (
							<span data-tone="good">
								{counts.fine} as expected
							</span>
						)}
					</span>
				) : (
					<span className={styles.summaryCounts}>Checking…</span>
				)}
				<span
					className={styles.summaryHow}
					title="Each figure is judged against its target when it has one, otherwise against what the same span of days usually comes to, otherwise against the period before. A figure is only called good or bad once somebody has said which way is better."
				>
					How this is judged
				</span>
			</div>

			<div className={styles.sections}>
				{shown.map((plan) => (
					<Section
						key={`${plan.sourceKey}|${plan.measure}`}
						plan={plan}
						order={position.get(plan.measure) ?? 0}
						visuals={visuals}
						sources={sources}
						reportId={reportId}
						pageId={pageId}
						settings={settings}
						canEdit={canEdit}
						onState={report}
						onSave={save}
						onMove={(step) => move(plan.measure, step)}
						foldFine={anyOff}
						charts={chartsFor.get(plan.measure) ?? []}
						first={position.get(plan.measure) === 0}
						last={position.get(plan.measure) === ordered.length - 1}
					/>
				))}
			</div>

			{canEdit && hidden.length > 0 && (
				<p className={styles.hiddenList}>
					Left out of the Briefing:{" "}
					{hidden.map((p, i) => (
						<span key={p.measure}>
							{i > 0 && ", "}
							{fieldMap(sources[p.sourceKey]).get(p.measure)
								?.displayName || p.measure}{" "}
							<button
								type="button"
								className={styles.link}
								onClick={() =>
									void save({
										...settings,
										hidden: settings.hidden.filter(
											(m) => m !== p.measure,
										),
									})
								}
							>
								Show
							</button>
						</span>
					))}
				</p>
			)}
		</div>
	);
}

function Section({
	plan,
	order,
	visuals,
	sources,
	reportId,
	pageId,
	settings,
	canEdit,
	onState,
	onSave,
	onMove,
	first,
	last,
	foldFine,
	charts,
}: {
	plan: SectionPlan;
	order: number;
	visuals: VisualSpec[];
	sources: Record<string, SourceMeta>;
	reportId: string;
	pageId: string;
	settings: BriefingSettings;
	canEdit: boolean;
	onState: (measure: string, state: SectionState) => void;
	onSave: (next: BriefingSettings) => Promise<void>;
	onMove: (step: -1 | 1) => void;
	first: boolean;
	last: boolean;
	foldFine: boolean;
	charts: string[];
}) {
	const { measure, sourceKey, anchorMeasures } = plan;
	const source = sources[sourceKey];
	const field = fieldMap(source).get(measure);
	const label = field?.displayName || measure;
	const hint = (field?.formatHint as FormatHint) ?? "decimal";

	// The anchor's filters, as its own visual sees them.
	const { clausesFor } = usePageFilters();
	const anchor = visuals.find((v) => v.visualId === plan.anchorId);
	const pageFilters = [
		...clausesFor(plan.anchorId),
		...((anchor?.config.filters ?? []) as unknown[]),
	] as DateClause[];
	const pageWindow = windowField(pageFilters);
	// A page showing all dates is briefed on its last full month, against the
	// months before it, on the date field the anchor compares on or the
	// source's own.
	const monthField = pageWindow
		? null
		: plan.compareField || source?.defaultTimeField || null;
	const filters = useMemo(
		() =>
			monthField
				? lastFullMonth(pageFilters, monthField, isoToday())
				: pageFilters,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[JSON.stringify(pageFilters), monthField],
	);
	const filterKey = JSON.stringify(filters);
	const dateField = monthField || plan.compareField || pageWindow;
	const month = monthField ? monthName(filters, monthField) : null;
	const period: ComparePeriod = monthField
		? "month"
		: (plan.compareTo ?? "previous");

	// The same question the anchor asks, so the batcher answers both at once.
	const ask = (asked: DateClause[] | null, measures = anchorMeasures) =>
		asked
			? queryForVisual("kpiRow", {
					sourceKey,
					dimensions: [],
					measures,
					filters: asked,
				})
			: null;

	const windows = useMemo(() => {
		if (!dateField) return null;
		const today = isoToday();
		const settled = settledWindow(filters, dateField, today) ?? filters;
		const previous = shiftDateFilters(settled, dateField, period);
		const earlier: DateClause[][] = [];
		let step: DateClause[] | null = settled;
		for (let i = 0; i < usualWindows && step; i++) {
			// Whole months step back by the calendar, anything else by its
			// own length.
			step = shiftDateFilters(
				step,
				dateField,
				monthField ? "month" : "previous",
			);
			if (step) earlier.push(step);
		}
		return { settled, previous, earlier };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filterKey, dateField, period]);

	const current = useVisualQuery(ask(filters));
	const previous = useVisualQuery(ask(windows?.previous ?? null));
	// A fixed number of questions, so the hooks are the same on every render.
	const e0 = useVisualQuery(ask(windows?.earlier[0] ?? null));
	const e1 = useVisualQuery(ask(windows?.earlier[1] ?? null));
	const e2 = useVisualQuery(ask(windows?.earlier[2] ?? null));
	const e3 = useVisualQuery(ask(windows?.earlier[3] ?? null));
	const e4 = useVisualQuery(ask(windows?.earlier[4] ?? null));
	const e5 = useVisualQuery(ask(windows?.earlier[5] ?? null));
	const earlierQueries = [e0, e1, e2, e3, e4, e5].slice(
		0,
		windows?.earlier.length ?? 0,
	);

	// The figure a relative target is measured from, asked the way the tile
	// asks it.
	const target = plan.target;
	const targetFilters =
		target?.basis.kind === "period" && dateField
			? shiftDateFilters(filters, dateField, target.basis.period)
			: target?.basis.kind === "measure"
				? filters
				: null;
	const targetBase = useVisualQuery(
		ask(
			targetFilters,
			target?.basis.kind === "measure" &&
				!anchorMeasures.includes(target.basis.measure)
				? [target.basis.measure]
				: anchorMeasures,
		),
	);

	const loading =
		current.isLoading ||
		previous.isLoading ||
		earlierQueries.some((q) => q.isLoading) ||
		(targetFilters !== null && targetBase.isLoading);

	const value = toNumber(current.rows[0]?.[measure]);
	const baseFigure =
		!target || target.basis.kind === "fixed"
			? null
			: toNumber(
					targetBase.rows[0]?.[
						target.basis.kind === "measure"
							? target.basis.measure
							: measure
					],
				);
	const resolved = target ? resolveTarget(target, baseFigure) : null;
	const direction: TargetDirection | null =
		target?.direction ?? settings.directions[measure] ?? null;

	const earlierFigures = earlierQueries
		.map((q) => toNumber(q.rows[0]?.[measure]))
		.filter((n): n is number => n !== null);
	const previousFigure = toNumber(previous.rows[0]?.[measure]);

	const verdict = useMemo(
		() =>
			judge({
				label: month ? `${label} in ${month}` : label,
				hint,
				value,
				target: resolved,
				targetBasis: target ? describeBasis(target, hint) : null,
				earlier: earlierFigures,
				previous: windows?.previous ? previousFigure : null,
				periodNoun: month ? "month" : null,
				previousLabel: windows?.previous
					? month
						? (monthName(windows.previous, dateField ?? "") ??
							previousLabel(period))
						: previousLabel(period)
					: null,
				direction,
			}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[
			label,
			hint,
			value,
			resolved?.value,
			resolved?.direction,
			JSON.stringify(earlierFigures),
			previousFigure,
			direction,
			Boolean(windows?.previous),
		],
	);

	useEffect(() => {
		onState(measure, { verdict, loaded: !loading });
	}, [measure, verdict, loading, onState]);

	// What moved it, for a section worth explaining that has an earlier window
	// to explain the change against.
	const explainKey =
		!loading && verdict.off && windows?.previous
			? JSON.stringify({
					sourceKey,
					measure,
					filters: windows.settled,
					previousFilters: windows.previous,
				})
			: null;
	const { data: explained } = useSWR<{
		breakdowns?: {
			dimension: string;
			members: {
				value: string;
				change: number;
				share: number | null;
			}[];
		}[];
	}>(
		explainKey,
		async (body: string) => {
			const response = await fetch("/api/explain", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			return response.ok ? response.json() : {};
		},
		{ revalidateOnFocus: false },
	);
	const strongest = explained?.breakdowns?.[0];
	const mover = strongest?.members[0];
	const why =
		strongest && mover
			? whyLine(
					fieldMap(source).get(strongest.dimension)?.displayName ||
						strongest.dimension,
					mover,
					hint,
				)
			: null;

	const [open, setOpen] = useState<boolean | null>(null);
	const isOpen = open ?? (!foldFine || !startsFolded(verdict));
	const [adjusting, setAdjusting] = useState(false);
	const headline = settings.headlines[measure];
	const note = settings.notes[measure];
	const definition = field?.description?.trim();
	// The month a page of all dates is briefed on, as filters a chart can
	// take, so a breakdown beside the month's figure is of that month. A
	// chart along dates keeps every date, since one month of a trend is a
	// single point.
	const monthClauses = monthField ? filters.slice(pageFilters.length) : [];
	const supporting = charts
		.map((id) => visuals.find((v) => v.visualId === id))
		.filter((v): v is VisualSpec => Boolean(v))
		.map((v) => {
			const along = Array.isArray(v.config.dimensions)
				? (v.config.dimensions[0] as string | undefined)
				: undefined;
			if (
				monthClauses.length === 0 ||
				(along && isTemporalField(source, along))
			)
				return v;
			return {
				...v,
				config: {
					...v.config,
					filters: [
						...((v.config.filters ?? []) as unknown[]),
						...monthClauses,
					],
				},
			} as VisualSpec;
		});

	return (
		<section
			className={styles.section}
			data-tone={loading ? "loading" : verdict.tone}
			data-off={verdict.off || undefined}
			style={{ order }}
			aria-label={label}
		>
			<button
				type="button"
				className={styles.head}
				aria-expanded={isOpen}
				onClick={() => setOpen(!isOpen)}
			>
				<span className={styles.status} data-tone={verdict.tone}>
					{loading ? "Checking" : verdict.label}
				</span>
				<span className={styles.headline}>
					{loading ? (
						label
					) : headline ? (
						<LiveText
							html={headline}
							source={source}
							filters={filters}
						/>
					) : (
						verdict.sentence
					)}
				</span>
				<svg
					className={styles.chevron}
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M6 9l6 6 6-6" />
				</svg>
			</button>

			{isOpen && (
				<div
					className={styles.body}
					data-detail={supporting.length > 0 || undefined}
				>
					<div className={styles.facts}>
						<div className={styles.figure}>
							<span className={styles.figureLabel}>
								{month ? `${label}, ${month}` : label}
							</span>
							<span
								className={styles.figureValue}
								title={
									value === null
										? undefined
										: formatValue(value, hint)
								}
							>
								{value === null
									? "–"
									: formatCompact(value, hint)}
							</span>
						</div>
						<dl className={styles.explain}>
							<dt>What it measures</dt>
							<dd>
								{definition || (
									<span className={styles.missing}>
										No definition yet. The report&apos;s
										owner can add one in the Dictionary.
									</span>
								)}
							</dd>
							<dt>Compared with</dt>
							<dd>{verdict.comparedWith}</dd>
							{why && (
								<>
									<dt>Why</dt>
									<dd>{why}</dd>
								</>
							)}
							{note && (
								<>
									<dt>Next</dt>
									<dd className={styles.next}>{note}</dd>
								</>
							)}
						</dl>

						{canEdit && !adjusting && (
							<div className={styles.adjustBar}>
								<button
									type="button"
									className={styles.link}
									onClick={() => setAdjusting(true)}
								>
									Adjust this section
								</button>
								<button
									type="button"
									className={styles.iconButton}
									aria-label={`Move ${label} up`}
									title="Move up"
									disabled={first}
									onClick={() => onMove(-1)}
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<path d="M12 19V5M5 12l7-7 7 7" />
									</svg>
								</button>
								<button
									type="button"
									className={styles.iconButton}
									aria-label={`Move ${label} down`}
									title="Move down"
									disabled={last}
									onClick={() => onMove(1)}
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<path d="M12 5v14M5 12l7 7 7-7" />
									</svg>
								</button>
							</div>
						)}
						{canEdit && adjusting && (
							<SectionSettings
								measure={measure}
								label={label}
								targetDirection={target?.direction ?? null}
								settings={settings}
								onSave={async (next) => {
									await onSave(next);
									setAdjusting(false);
								}}
								onCancel={() => setAdjusting(false)}
							/>
						)}
					</div>
					{supporting.length > 0 && (
						<div className={styles.detail}>
							{supporting.map((visual) => (
								<div
									key={visual.visualId}
									className={styles.detailItem}
									style={{ height: detailHeight }}
								>
									<VisualRenderer
										visual={visual}
										sources={sources}
										reportId={reportId}
										pageId={pageId}
										frameHeight={detailHeight}
									/>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</section>
	);
}

// What an author changes about one section: which way is good, the headline,
// what to do, and whether it shows at all.
function SectionSettings({
	measure,
	label,
	targetDirection,
	settings,
	onSave,
	onCancel,
}: {
	measure: string;
	label: string;
	targetDirection: TargetDirection | null;
	settings: BriefingSettings;
	onSave: (next: BriefingSettings) => Promise<void>;
	onCancel: () => void;
}) {
	const [direction, setDirection] = useState<string>(
		settings.directions[measure] ?? "",
	);
	const [headline, setHeadline] = useState(settings.headlines[measure] ?? "");
	const [note, setNote] = useState(settings.notes[measure] ?? "");
	const [saving, setSaving] = useState(false);

	const without = (record: Record<string, string>) => {
		const next = { ...record };
		delete next[measure];
		return next;
	};

	return (
		<div className={styles.settings}>
			<label className={styles.settingField}>
				<span>Which way is better</span>
				{targetDirection ? (
					<span className={styles.settingNote}>
						{targetDirection === "higher" ? "Higher" : "Lower"} is
						better, set with the KPI tile&apos;s target.
					</span>
				) : (
					<select
						value={direction}
						onChange={(e) => setDirection(e.target.value)}
					>
						<option value="">Not set, describe it neutrally</option>
						<option value="higher">Higher is better</option>
						<option value="lower">Lower is better</option>
					</select>
				)}
			</label>
			<label className={styles.settingField}>
				<span>Headline</span>
				<input
					value={headline}
					placeholder="Leave blank for the drafted headline"
					onChange={(e) => setHeadline(e.target.value)}
				/>
				<span className={styles.settingNote}>
					Live figures go in double braces, such as {"{{"}
					{measure}
					{"}}"}.
				</span>
			</label>
			<label className={styles.settingField}>
				<span>Next step</span>
				<textarea
					rows={3}
					value={note}
					placeholder={`What a reader should do when ${label} is off, such as who to talk to or which report to check`}
					onChange={(e) => setNote(e.target.value)}
				/>
			</label>
			<div className={styles.settingActions}>
				<button
					type="button"
					className={styles.danger}
					disabled={saving}
					onClick={async () => {
						setSaving(true);
						await onSave({
							...settings,
							hidden: [...settings.hidden, measure],
						});
						setSaving(false);
					}}
				>
					Leave out of the Briefing
				</button>
				<span className={styles.spacer} />
				<button
					type="button"
					className={styles.secondary}
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					type="button"
					className={styles.primary}
					disabled={saving}
					onClick={async () => {
						setSaving(true);
						const directions = { ...settings.directions };
						if (direction === "higher" || direction === "lower")
							directions[measure] = direction;
						else delete directions[measure];
						await onSave({
							...settings,
							directions,
							headlines: headline.trim()
								? {
										...settings.headlines,
										[measure]: headline.trim(),
									}
								: without(settings.headlines),
							notes: note.trim()
								? { ...settings.notes, [measure]: note.trim() }
								: without(settings.notes),
						});
						setSaving(false);
					}}
				>
					Save
				</button>
			</div>
		</div>
	);
}
