"use client";

import { Select } from "../components/shared/Select";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import useSWR from "swr";
import { formatValue, type FormatHint } from "../../lib/format";
import {
	escapeForHtml,
	fillNarrative,
	paceToTarget,
	parseNarrative,
	scoreForecasts,
	type ForecastRecord,
	type OddOne,
	paceFromRows,
	rankForecasts,
	type Scenario,
} from "../../lib/insight/insight";
import {
	forecastRows,
	localToday,
	periodKey,
	type ForecastResult,
} from "../../lib/visuals/forecast";
import { runBatchedQuery } from "../hooks/queryBatch";
import { useVisualQuery } from "../hooks/useVisualQuery";
import type { SourceMeta } from "./types";
import { TextPanel } from "./TextPanel";
import styles from "./Insight.module.css";

// The pieces of the insight features that sit on a page. A simulation across it, a list of
// what stands out on it, a report card under a forecast, and the visuals built on forecasts.

// --- What if -------------------------------------------------------------------------

export function ScenarioBar({
	sourceKey,
	measures,
	dimensions,
	scenarios,
	onChange,
	onClose,
}: {
	sourceKey: string | null;
	measures: string[];
	dimensions: string[];
	scenarios: Scenario[];
	onChange: (next: Scenario[]) => void;
	onClose: () => void;
}) {
	const blank = (): Scenario => ({
		measure: measures[0] ?? "",
		percent: 0,
		field: null,
		value: null,
	});
	const shown = scenarios.length > 0 ? scenarios : [blank()];
	const [collapsed, setCollapsed] = useState(false);
	const set = (index: number, patch: Partial<Scenario>) =>
		onChange(
			shown.map((held, i) =>
				i === index ? { ...held, ...patch } : held,
			),
		);
	const moving = shown.filter((held) => held.percent !== 0);
	const summary =
		moving.length === 0
			? "Move a figure and watch this page change"
			: moving
					.map(
						(held) =>
							`${held.measure} ${held.percent > 0 ? "+" : ""}${held.percent}%${
								held.field && held.value
									? ` for ${held.value}`
									: ""
							}`,
					)
					.join(", ");
	return (
		<div className={styles.dock} role="group" aria-label="What if">
			<div className={styles.dockHead}>
				<span className={styles.dockTag}>Simulation</span>
				<strong>What if</strong>
				<span
					className={styles.dockSummary}
					title="On your screen only. Nothing is saved, nobody else sees it, and no data changes. Every chart, tile and table on this page moves by these percentages. A measure worked out from another keeps its own figure unless it has an assumption of its own."
				>
					{summary}
				</span>
				<span className={styles.scenarioSpacer} />
				{!collapsed && (
					<>
						<button
							type="button"
							className={styles.button}
							onClick={() => onChange([...shown, blank()])}
						>
							Add an assumption
						</button>
						<button
							type="button"
							className={styles.button}
							disabled={moving.length === 0}
							onClick={() => onChange([])}
						>
							Reset
						</button>
					</>
				)}
				<button
					type="button"
					className={styles.button}
					aria-expanded={!collapsed}
					onClick={() => setCollapsed((held) => !held)}
				>
					{collapsed ? "Show" : "Hide"}
				</button>
				<button
					type="button"
					className={styles.button}
					onClick={onClose}
				>
					End
				</button>
			</div>
			{!collapsed && (
				<div className={styles.dockRows}>
					{shown.map((scenario, index) => (
						<ScenarioRow
							key={index}
							sourceKey={sourceKey}
							scenario={scenario}
							measures={measures}
							dimensions={dimensions}
							onChange={(patch) => set(index, patch)}
							onRemove={
								shown.length > 1
									? () =>
											onChange(
												shown.filter(
													(_, i) => i !== index,
												),
											)
									: undefined
							}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ScenarioRow({
	sourceKey,
	scenario,
	measures,
	dimensions,
	onChange,
	onRemove,
}: {
	sourceKey: string | null;
	scenario: Scenario;
	measures: string[];
	dimensions: string[];
	onChange: (patch: Partial<Scenario>) => void;
	onRemove?: () => void;
}) {
	// The values to choose from, as this person can see them.
	const { data } = useSWR<{ values: string[] }>(
		sourceKey && scenario.field
			? ["/api/query/values", sourceKey, scenario.field]
			: null,
		async ([address, source, field]: [string, string, string]) => {
			const response = await fetch(address, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sourceKey: source,
					field,
					search: "",
					filters: [],
					limit: 200,
				}),
			});
			return response.json();
		},
	);
	return (
		<div className={styles.scenarioRow}>
			<span className={styles.rowField}>
				<Select
					value={scenario.measure}
					ariaLabel="Which measure"
					searchable={measures.length > 8}
					onChange={(measure) => onChange({ measure })}
					options={measures.map((name) => ({
						value: name,
						label: name,
					}))}
				/>
			</span>
			<input
				type="range"
				className={styles.slider}
				min={-100}
				max={100}
				step={1}
				value={Math.max(-100, Math.min(100, scenario.percent))}
				aria-label="How much"
				onChange={(e) => onChange({ percent: Number(e.target.value) })}
			/>
			<span className={styles.percentBox}>
				<input
					type="number"
					className={styles.percentInput}
					value={scenario.percent}
					aria-label="Percent"
					onChange={(e) =>
						onChange({ percent: Number(e.target.value) || 0 })
					}
				/>
				%
			</span>
			<span className={styles.rowField}>
				<Select
					value={scenario.field ?? ""}
					ariaLabel="Limited to"
					onChange={(field) =>
						onChange({ field: field || null, value: null })
					}
					options={[
						{ value: "", label: "Across everything" },
						...dimensions.map((name) => ({
							value: name,
							label: `For one ${name}`,
						})),
					]}
				/>
			</span>
			{scenario.field && (
				<span className={styles.rowField}>
					<Select
						value={scenario.value ?? ""}
						placeholder="Choose one"
						ariaLabel="Which value"
						searchable
						onChange={(value) => onChange({ value: value || null })}
						options={(data?.values ?? []).map((value) => ({
							value,
							label: value,
						}))}
					/>
				</span>
			)}
			{onRemove && (
				<button
					type="button"
					className={styles.button}
					onClick={onRemove}
				>
					Remove
				</button>
			)}
		</div>
	);
}

// --- What's unusual --------------------------------------------------------------------

interface UnusualEntry extends OddOne {
	visualId: string;
	visualTitle: string;
	key: string;
}

const UnusualContext = createContext<{
	report: (visualId: string, title: string, items: OddOne[]) => void;
} | null>(null);

// What the visuals reported, for the button in the report's header. Apart from the context the
// visuals write to, so a new list redraws the button and not every visual on the page.
const UnusualEntriesContext = createContext<UnusualEntry[]>([]);

export function useReportUnusual(
	visualId: string | undefined,
	title: string | null | undefined,
	items: OddOne[],
) {
	const context = useContext(UnusualContext);
	const report = context?.report;
	const fingerprint = items.map((item) => item.label).join("\u0000");
	useEffect(() => {
		if (report && visualId) report(visualId, title ?? "A visual", items);
		// By what stands out, since the page hands over a new array each render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [report, visualId, title, fingerprint]);
}

export function UnusualProvider({ children }: { children: ReactNode }) {
	const [held, setHeld] = useState<Record<string, UnusualEntry[]>>({});
	const report = useCallback(
		(visualId: string, title: string, items: OddOne[]) =>
			setHeld((current) => ({
				...current,
				[visualId]: items.map((item) => ({
					...item,
					visualId,
					visualTitle: title,
					key: `${visualId}:${item.label}`,
				})),
			})),
		[],
	);
	const value = useMemo(() => ({ report }), [report]);
	const entries = useMemo(
		() =>
			Object.values(held)
				.flat()
				.sort((a, b) => b.score - a.score),
		[held],
	);
	return (
		<UnusualContext.Provider value={value}>
			<UnusualEntriesContext.Provider value={entries}>
				{children}
			</UnusualEntriesContext.Provider>
		</UnusualContext.Provider>
	);
}

// Matches the menu's width in Insight.module.css.
const insightsMenuWidth = 420;

// One button in the report's header for looking into the page: the figures that stand out, and
// what if. The count of unusual figures rides on the button, so it is seen without opening it.
export function InsightsMenu({
	className,
	whatIf,
}: {
	className: string;
	// Offered on a page with a measure to change.
	whatIf: { available: boolean; open: boolean; onToggle: () => void };
}) {
	const entries = useContext(UnusualEntriesContext);
	const [open, setOpen] = useState(false);
	// Opens toward whichever side has room, since the header row sits left on a narrow page
	// and right on a wide one.
	const [openLeftward, setOpenLeftward] = useState(false);
	const box = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", key);
		};
	}, [open]);

	if (entries.length === 0 && !whatIf.available) return null;
	return (
		<div ref={box} className={styles.unusualWrap}>
			<button
				type="button"
				className={className}
				aria-haspopup="menu"
				aria-expanded={open}
				data-on={whatIf.open || undefined}
				title="What stands out on this page, and what if a figure changed"
				onClick={() => {
					const at = box.current?.getBoundingClientRect();
					setOpenLeftward(
						Boolean(
							at &&
							at.left + insightsMenuWidth > window.innerWidth,
						),
					);
					setOpen((held) => !held);
				}}
			>
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
				</svg>
				Insights
				{entries.length > 0 && (
					<span className={styles.unusualCount}>
						{entries.length}
					</span>
				)}
			</button>
			{open && (
				<div
					className={`${styles.unusualMenu} ${openLeftward ? styles.unusualMenuLeftward : ""}`}
					role="menu"
				>
					{whatIf.available && (
						<button
							type="button"
							role="menuitemcheckbox"
							aria-checked={whatIf.open}
							className={styles.insightsItem}
							onClick={() => {
								setOpen(false);
								whatIf.onToggle();
							}}
						>
							<span className={styles.insightsItemHead}>
								<strong>What if</strong>
								{whatIf.open && (
									<span className={styles.insightsOn}>
										On
									</span>
								)}
							</span>
							<span className={styles.unusualReason}>
								{whatIf.open
									? "Close the bar at the foot of the page and put the figures back"
									: "Change a figure across this page and see the effect"}
							</span>
						</button>
					)}
					<div className={styles.insightsSection}>
						<span className={styles.insightsHeading}>
							What&apos;s unusual
						</span>
						{entries.length === 0 ? (
							<p className={styles.unusualIntro}>
								Nothing stands apart on this page right now.
							</p>
						) : (
							<>
								<p className={styles.unusualIntro}>
									Figures that stand apart from the rest of
									their chart. Pick one to go to it, then
									click it on the chart to ask why.
								</p>
								<ol className={styles.unusualList}>
									{entries.map((entry) => (
										<li key={entry.key}>
											<button
												type="button"
												role="menuitem"
												className={styles.unusualItem}
												onClick={() => {
													setOpen(false);
													document
														.querySelector(
															`[data-visual-id="${CSS.escape(entry.visualId)}"]`,
														)
														?.scrollIntoView({
															behavior: "smooth",
															block: "center",
														});
												}}
											>
												<span>
													<strong>
														{entry.label}
													</strong>{" "}
													in {entry.visualTitle}
												</span>
												<span
													className={
														styles.unusualReason
													}
												>
													{entry.reason}
												</span>
											</button>
										</li>
									))}
								</ol>
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

// --- Forecast report card -----------------------------------------------------------------

// Saves this forecast the first time it is made, fills in what actually happened, and says
// how past ones here have done. Kept per person, since row filters can make the same chart
// show different figures to different people.
export function ForecastTrack({
	visualId,
	sourceKey,
	result,
	rows,
	periodField,
}: {
	visualId: string | undefined;
	sourceKey: string;
	result: ForecastResult | null;
	rows: Record<string, unknown>[];
	periodField: string | null;
}) {
	const measure = result?.series[0]?.measure;
	const address =
		visualId && measure
			? `/api/forecast-card?visualId=${encodeURIComponent(visualId)}&measure=${encodeURIComponent(measure)}`
			: null;
	const { data, mutate } = useSWR<{ records: ForecastRecord[] }>(address);

	const signature = result
		? JSON.stringify([result.periods, result.series[0]?.values])
		: "";
	useEffect(() => {
		if (!result || !visualId || !measure || !periodField) return;
		const series = result.series[0];
		const actuals = rows.flatMap((row) => {
			const period = periodKey(row[periodField]);
			const value = Number(row[measure]);
			return period &&
				Number.isFinite(value) &&
				period <= result.anchorPeriod
				? [{ period, value }]
				: [];
		});
		void fetch("/api/forecast-card", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				visualId,
				sourceKey,
				measure,
				forecasts: result.periods.map((period, index) => ({
					period,
					predicted: series.values[index],
					low: series.lower[index],
					high: series.upper[index],
				})),
				actuals,
			}),
		})
			.then(() => mutate())
			.catch(() => {});
		// Once for each forecast worked out.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [signature, visualId]);

	const score = scoreForecasts(data?.records ?? []);
	if (score.scored === 0) return null;
	return (
		<p className={styles.track}>
			Past forecasts here landed in their likely range {score.withinRange}{" "}
			of {score.scored} times
			{score.typicalMissPercent !== null
				? `, typically off by ${score.typicalMissPercent.toFixed(1)}%`
				: ""}
			.
		</p>
	);
}

// --- Visuals built on forecasts --------------------------------------------------------

function useSeries(
	sourceKey: string,
	dimensions: string[],
	measures: string[],
	filters: unknown[],
) {
	return useVisualQuery({
		sourceKey,
		dimensions,
		measures,
		filters,
		sort: dimensions.map((field) => ({ field, direction: "asc" as const })),
		limit: 5000,
	});
}

const noRows: Record<string, unknown>[] = [];

// Where a figure is heading by the end of this year, against a target.
export function PaceTile({
	sourceKey,
	periodField,
	measure,
	target,
	filters,
	hint,
}: {
	sourceKey: string;
	periodField: string;
	measure: string;
	target: number | null;
	filters: unknown[];
	hint: FormatHint;
}) {
	const { rows, isLoading } = useSeries(
		sourceKey,
		[periodField],
		[measure],
		filters,
	);
	const today = localToday();
	const worked = useMemo(
		() =>
			target === null
				? null
				: paceFromRows(
						rows ?? noRows,
						periodField,
						measure,
						target,
						today,
					),
		[rows, periodField, measure, target, today],
	);
	if (isLoading) return <p className={styles.muted}>Working it out.</p>;
	if (target === null || !worked) {
		return (
			<p className={styles.muted}>
				Set a target in this visual&apos;s settings.
			</p>
		);
	}
	const { pace, year } = worked;
	return (
		<div className={styles.pace}>
			<span className={styles.paceValue}>
				{formatValue(pace.expected, hint)}
			</span>
			<span className={pace.onPace ? styles.good : styles.bad}>
				{pace.onPace ? "On pace" : "Behind pace"} for{" "}
				{formatValue(target, hint)} by the end of {year}
			</span>
			<div className={styles.paceBar} aria-hidden="true">
				<div
					className={
						pace.onPace ? styles.paceFillGood : styles.paceFillBad
					}
					style={{ width: `${Math.min(pace.percent, 100)}%` }}
				/>
			</div>
			<span className={styles.muted}>
				{worked.forecasted
					? "What has happened so far, plus a forecast for the rest."
					: "Not enough history to forecast, so this is what has happened so far."}
			</span>
		</div>
	);
}

// Which group is heading where, from one query by group and date.
export function ForecastRanking({
	sourceKey,
	groupField,
	periodField,
	measure,
	filters,
	hint,
}: {
	sourceKey: string;
	groupField: string;
	periodField: string;
	measure: string;
	filters: unknown[];
	hint: FormatHint;
}) {
	const { rows, isLoading } = useSeries(
		sourceKey,
		[groupField, periodField],
		[measure],
		filters,
	);
	const today = localToday();
	const ranked = useMemo(
		() =>
			rankForecasts(
				rows ?? noRows,
				groupField,
				periodField,
				measure,
				today,
			),
		[rows, groupField, periodField, measure, today],
	);

	if (isLoading) return <p className={styles.muted}>Working it out.</p>;
	if (ranked.length === 0) {
		return (
			<p className={styles.muted}>
				Not enough history to forecast these.
			</p>
		);
	}
	return (
		<table className={styles.ranking}>
			<thead>
				<tr>
					<th>{groupField}</th>
					<th className={styles.number}>Next period</th>
					<th className={styles.number}>Likely range</th>
					<th>Heading</th>
				</tr>
			</thead>
			<tbody>
				{ranked.map((row) => (
					<tr key={row.group}>
						<td>{row.group}</td>
						<td className={styles.number}>
							{formatValue(row.next, hint)}
						</td>
						<td className={styles.number}>
							{formatValue(row.low, hint)} to{" "}
							{formatValue(row.high, hint)}
						</td>
						<td>{row.trend ?? "-"}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

// --- Living narrative ------------------------------------------------------------------

// Text with live figures in it, asked for as the reader so the sentence stays true for them.
export function LiveText({
	html,
	source,
	filters,
}: {
	html: string;
	source: SourceMeta | undefined;
	filters: unknown[];
}) {
	const tokens = useMemo(() => parseNarrative(html), [html]);
	const [answers, setAnswers] = useState<Map<string, string>>(new Map());
	const filterKey = JSON.stringify(filters);

	useEffect(() => {
		if (!source || tokens.length === 0) return;
		let current = true;
		const hintFor = (measure: string) =>
			(source.measures.find((f) => f.name === measure)?.formatHint ??
				"decimal") as FormatHint;
		void Promise.all(
			tokens.map(async (token): Promise<[string, string]> => {
				const known = source.measures.some(
					(f) => f.name === token.measure,
				);
				if (!known) return [token.text, "-"];
				const single = token.kind === "value";
				const body = JSON.stringify({
					sourceKey: source.sourceKey,
					dimensions: single ? [] : [token.dimension],
					measures: [token.measure],
					filters: JSON.parse(filterKey),
					...(single
						? {}
						: {
								sort: [
									{
										field: token.measure,
										direction:
											token.which === "top"
												? "desc"
												: "asc",
									},
								],
								limit: 1,
							}),
				});
				const answer = await runBatchedQuery(body as never).catch(
					() => null,
				);
				const row = answer?.rows[0];
				if (!row) return [token.text, "-"];
				return [
					token.text,
					single
						? formatValue(
								row[token.measure],
								hintFor(token.measure),
							)
						: String(row[token.dimension] ?? "-"),
				];
			}),
		).then((settled) => {
			if (current) setAnswers(new Map(settled));
		});
		return () => {
			current = false;
		};
	}, [tokens, source, filterKey]);

	return (
		<TextPanel
			html={
				tokens.length === 0
					? html
					: fillNarrative(
							html,
							new Map(
								tokens.map((token) => [
									token.text,
									answers.get(token.text) ?? "...",
								]),
							),
						)
			}
		/>
	);
}

export { escapeForHtml };
