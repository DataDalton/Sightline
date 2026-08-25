"use client";

import { useMemo, useState } from "react";
import {
	visualByType,
	checkEncoding,
	type VisualTypeDefinition,
} from "../../lib/visuals/catalog";
import {
	paletteTokens,
	type ColorSpec,
	type PaletteToken,
	type VisualStyle,
} from "../../lib/visuals/style";
import { readThemeColors } from "../visuals/colors";
import { ConditionsEditor } from "./ConditionsEditor";
import { HistoryPanel } from "./HistoryPanel";
import { PageSettings } from "./PageSettings";
import type { PageConfig } from "./ReportEditor";
import type { SourceMeta } from "../visuals/types";
import type { EditableVisual } from "./types";
import styles from "./Editor.module.css";

// Editing one visual: what it shows, and how it looks.
//
// The panel is driven by the catalogue rather than hardcoded per type, so a
// pie chart is not offered an axis label and a table is not offered a fill
// mode. Adding a type to the catalogue makes it configurable here without
// touching this file.

interface PropertiesPanelProps {
	visual: EditableVisual | null;
	source: SourceMeta | undefined;
	onChange: (next: EditableVisual) => void;
	onRemove: (visualId: string) => void;
	// The page's own settings, shown here when no visual is selected.
	pageSource: SourceMeta | undefined;
	pageConfig: PageConfig;
	pageTitle: string;
	reportDescription: string;
	onPageChange: (next: PageConfig) => void;
	onPageTitleChange: (next: string) => void;
	onDescriptionChange: (next: string) => void;
	// With nothing selected the panel is about the page, and the history is
	// about the page too, so they are tabs of the same panel rather than a
	// button in the toolbar competing with the arranging controls.
	panelTab: "page" | "history";
	onPanelTab: (tab: "page" | "history") => void;
	historySlug: string;
	historyKey: number;
	onRestored: () => void;
}

type Tab = "data" | "format";

export function PropertiesPanel({
	visual,
	source,
	onChange,
	onRemove,
	pageSource,
	pageConfig,
	pageTitle,
	reportDescription,
	onPageChange,
	onPageTitleChange,
	onDescriptionChange,
	panelTab,
	onPanelTab,
	historySlug,
	historyKey,
	onRestored,
}: PropertiesPanelProps) {
	const [tab, setTab] = useState<Tab>("data");
	const [fieldSearch, setFieldSearch] = useState("");

	const definition = visual ? visualByType[visual.visualType] : undefined;

	if (!visual || !definition) {
		return (
			<div className={styles.panel}>
				<div className={styles.tabs} role="tablist">
					<button
						type="button"
						role="tab"
						aria-selected={panelTab === "page"}
						className={`${styles.tab} ${panelTab === "page" ? styles.tabActive : ""}`}
						onClick={() => onPanelTab("page")}
					>
						Page
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={panelTab === "history"}
						className={`${styles.tab} ${panelTab === "history" ? styles.tabActive : ""}`}
						onClick={() => onPanelTab("history")}
					>
						History
					</button>
				</div>

				{panelTab === "history" ? (
					<HistoryPanel
						slug={historySlug}
						refreshKey={historyKey}
						onRestored={onRestored}
					/>
				) : (
					<PageSettings
						source={pageSource}
						config={pageConfig}
						pageTitle={pageTitle}
						reportDescription={reportDescription}
						onChange={onPageChange}
						onPageTitleChange={onPageTitleChange}
						onDescriptionChange={onDescriptionChange}
					/>
				)}
			</div>
		);
	}

	const dimensions = visual.config.dimensions ?? [];
	const measures = visual.config.measures ?? [];
	const style = visual.config.style ?? {};

	const update = (patch: Partial<EditableVisual>) =>
		onChange({ ...visual, ...patch });

	const updateConfig = (patch: Record<string, unknown>) =>
		onChange({ ...visual, config: { ...visual.config, ...patch } });

	const updateStyle = (patch: Partial<VisualStyle>) =>
		updateConfig({ style: { ...style, ...patch } });

	return (
		<div className={styles.panel}>
			<div className={styles.panelTabs} role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "data"}
					className={`${styles.panelTab} ${tab === "data" ? styles.panelTabActive : ""}`}
					onClick={() => setTab("data")}
				>
					Data
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "format"}
					className={`${styles.panelTab} ${tab === "format" ? styles.panelTabActive : ""}`}
					onClick={() => setTab("format")}
				>
					Format
				</button>
			</div>

			<div className={styles.panelBody}>
				{tab === "data" ? (
					<DataTab
						visual={visual}
						definition={definition}
						source={source}
						dimensions={dimensions}
						measures={measures}
						fieldSearch={fieldSearch}
						setFieldSearch={setFieldSearch}
						update={update}
						updateConfig={updateConfig}
						onRemove={onRemove}
					/>
				) : (
					<FormatTab
						visual={visual}
						definition={definition}
						dimensions={dimensions}
						measures={measures}
						style={style}
						updateStyle={updateStyle}
						updateConfig={updateConfig}
					/>
				)}
			</div>
		</div>
	);
}

function DataTab({
	visual,
	definition,
	source,
	dimensions,
	measures,
	fieldSearch,
	setFieldSearch,
	update,
	updateConfig,
	onRemove,
}: {
	visual: EditableVisual;
	definition: VisualTypeDefinition;
	source: SourceMeta | undefined;
	dimensions: string[];
	measures: string[];
	fieldSearch: string;
	setFieldSearch: (v: string) => void;
	update: (patch: Partial<EditableVisual>) => void;
	updateConfig: (patch: Record<string, unknown>) => void;
	onRemove: (visualId: string) => void;
}) {
	const problem = checkEncoding(visual.visualType, dimensions, measures);

	const filtered = useMemo(() => {
		const term = fieldSearch.trim().toLowerCase();
		const match = (name: string) =>
			term === "" || name.toLowerCase().includes(term);
		return {
			dimensions: (source?.dimensions ?? []).filter((f) => match(f.name)),
			measures: (source?.measures ?? []).filter((f) => match(f.name)),
		};
	}, [source, fieldSearch]);

	const toggle = (name: string, kind: "dimensions" | "measures") => {
		const current = kind === "dimensions" ? dimensions : measures;
		const next = current.includes(name)
			? current.filter((f) => f !== name)
			: [...current, name];
		updateConfig({ [kind]: next });
	};

	const reorder = (
		kind: "dimensions" | "measures",
		from: number,
		to: number,
	) => {
		const current = [...(kind === "dimensions" ? dimensions : measures)];
		if (to < 0 || to >= current.length) return;
		const [moved] = current.splice(from, 1);
		current.splice(to, 0, moved);
		updateConfig({ [kind]: current });
	};

	return (
		<>
			<p className={styles.guidance}>{definition.guidance}</p>

			{problem && (
				<div className={styles.conflict} role="status">
					{problem.message}
				</div>
			)}

			<div className={styles.field}>
				<label className={styles.fieldLabel} htmlFor="visual-title">
					Title
				</label>
				<input
					id="visual-title"
					className={styles.input}
					value={visual.title ?? ""}
					placeholder="Untitled"
					onChange={(e) => update({ title: e.target.value })}
				/>
			</div>

			<div className={styles.field}>
				<label className={styles.fieldLabel} htmlFor="visual-type">
					Visual type
				</label>
				<select
					id="visual-type"
					className={styles.select}
					value={visual.visualType}
					onChange={(e) => update({ visualType: e.target.value })}
				>
					{Object.values(visualByType).map((d) => (
						<option key={d.type} value={d.type}>
							{d.label}
						</option>
					))}
				</select>
			</div>

			{/* Selected fields first, in order, because for most visuals the
			    order is the encoding: the first dimension is the axis. */}
			{(dimensions.length > 0 || measures.length > 0) && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Selected</div>
					<SelectedList
						label="Dimensions"
						items={dimensions}
						onRemove={(name) => toggle(name, "dimensions")}
						onMove={(from, to) => reorder("dimensions", from, to)}
					/>
					<SelectedList
						label="Measures"
						items={measures}
						onRemove={(name) => toggle(name, "measures")}
						onMove={(from, to) => reorder("measures", from, to)}
					/>
				</div>
			)}

			<div className={styles.section}>
				<div className={styles.sectionTitle}>Add fields</div>
				<input
					className={styles.input}
					placeholder="Search fields"
					value={fieldSearch}
					onChange={(e) => setFieldSearch(e.target.value)}
				/>

				{definition.encoding.measures.max > 0 &&
					filtered.measures.length > 0 && (
						<>
							<div className={styles.fieldLabel} style={{ marginTop: 10 }}>
								Measures ({filtered.measures.length})
							</div>
							{filtered.measures.slice(0, 60).map((f) => (
								<FieldRow
									key={f.name}
									name={f.name}
									description={f.description}
									selected={measures.includes(f.name)}
									onToggle={() => toggle(f.name, "measures")}
								/>
							))}
						</>
					)}

				{definition.encoding.dimensions.max > 0 &&
					filtered.dimensions.length > 0 && (
						<>
							<div className={styles.fieldLabel} style={{ marginTop: 10 }}>
								Dimensions ({filtered.dimensions.length})
							</div>
							{filtered.dimensions.slice(0, 60).map((f) => (
								<FieldRow
									key={f.name}
									name={f.name}
									description={f.description}
									selected={dimensions.includes(f.name)}
									onToggle={() => toggle(f.name, "dimensions")}
								/>
							))}
						</>
					)}
			</div>

			{/* A drill hierarchy turns a click into a descent rather than a
			    cross-filter, so it is only offered where that makes sense. */}
			{definition.category !== "filter" && dimensions.length > 1 && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Drill hierarchy</div>
					<p className={styles.guidance}>
						Clicking descends this hierarchy instead of
						cross-filtering the page. Order it outermost first.
					</p>
					<button
						type="button"
						className={styles.checkRow}
						onClick={() =>
							updateConfig({
								options: {
									...visual.config.options,
									drillFields: visual.config.options?.drillFields
										? undefined
										: dimensions,
								},
							})
						}
					>
						<Check on={Boolean(visual.config.options?.drillFields)} />
						Use the selected dimensions as a drill path
					</button>
				</div>
			)}

			<div className={styles.section}>
				<button
					type="button"
					className={`${styles.toolButton} ${styles.danger}`}
					onClick={() => onRemove(visual.visualId)}
					style={{ width: "100%", justifyContent: "center" }}
				>
					Remove this visual
				</button>
			</div>
		</>
	);
}

function SelectedList({
	label,
	items,
	onRemove,
	onMove,
}: {
	label: string;
	items: string[];
	onRemove: (name: string) => void;
	onMove: (from: number, to: number) => void;
}) {
	if (items.length === 0) return null;
	return (
		<div className={styles.field}>
			<span className={styles.fieldLabel}>{label}</span>
			{items.map((name, i) => (
				<div key={name} className={styles.row} style={{ marginBottom: 4 }}>
					<span className={styles.chip} style={{ flex: 1 }}>
						{name}
					</span>
					<button
						type="button"
						className={styles.chipRemove}
						onClick={() => onMove(i, i - 1)}
						disabled={i === 0}
						aria-label={`Move ${name} up`}
					>
						↑
					</button>
					<button
						type="button"
						className={styles.chipRemove}
						onClick={() => onMove(i, i + 1)}
						disabled={i === items.length - 1}
						aria-label={`Move ${name} down`}
					>
						↓
					</button>
					<button
						type="button"
						className={styles.chipRemove}
						onClick={() => onRemove(name)}
						aria-label={`Remove ${name}`}
					>
						✕
					</button>
				</div>
			))}
		</div>
	);
}

function FieldRow({
	name,
	description,
	selected,
	onToggle,
}: {
	name: string;
	description: string | null;
	selected: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			className={styles.checkRow}
			onClick={onToggle}
			aria-pressed={selected}
			// The catalogue description is the tooltip, so an author sees the
			// same definition a reader will.
			title={description ?? name}
		>
			<Check on={selected} />
			<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
				{name}
			</span>
		</button>
	);
}

function Check({ on }: { on: boolean }) {
	return (
		<span
			className={`${styles.checkbox} ${on ? styles.checked : ""}`}
			aria-hidden="true"
		>
			<svg width="9" height="9" viewBox="0 0 16 16" fill="none">
				<path
					d="M3 8.5l3.5 3.5L13 5"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</span>
	);
}

function FormatTab({
	visual,
	definition,
	dimensions,
	measures,
	style,
	updateStyle,
	updateConfig,
}: {
	visual: EditableVisual;
	definition: VisualTypeDefinition;
	dimensions: string[];
	measures: string[];
	style: VisualStyle;
	updateStyle: (patch: Partial<VisualStyle>) => void;
	updateConfig: (patch: Record<string, unknown>) => void;
}) {
	const supports = definition.supports;
	const [seriesIndex, setSeriesIndex] = useState(0);
	const activeMeasure = measures[seriesIndex];

	const swatches = useMemo(() => {
		if (typeof window === "undefined") return [];
		const colors = readThemeColors();
		return paletteTokens.map((token, i) => ({
			token,
			hex:
				i < 8
					? colors.series[i]
					: colors.resolve({ token }, colors.series[0]),
		}));
	}, []);

	const seriesEntry = (style.series ?? []).find(
		(s) => s.measure === activeMeasure,
	);

	const updateSeries = (patch: Record<string, unknown>) => {
		if (!activeMeasure) return;
		const existing = style.series ?? [];
		const index = existing.findIndex((s) => s.measure === activeMeasure);
		const next = [...existing];
		if (index >= 0) next[index] = { ...next[index], ...patch };
		else next.push({ measure: activeMeasure, ...patch });
		updateStyle({ series: next });
	};

	return (
		<>
			{supports.fillHeight && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Size</div>
					<label className={styles.checkRow}>
						<input
							type="checkbox"
							checked={visual.config.options?.fillHeight !== false}
							onChange={(e) =>
								updateConfig({
									options: {
										...visual.config.options,
										fillHeight: e.target.checked,
									},
								})
							}
						/>
						<span>
							Fill the rest of the screen when it is last on the page
						</span>
					</label>
					<p className={styles.guidance}>
						On by default. A reader works inside a table rather than
						glancing at it, so a short box inside a tall screen makes
						them scroll through a window when the room was already
						there. Turn it off where the table is deliberately a
						preview. The canvas shows the height a reader will get.
					</p>
				</div>
			)}

			{visual.visualType === "textPanel" && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Content</div>
					<p className={styles.guidance}>
						Select the panel on the canvas and type into it. The
						formatting toolbar appears with it, and the styling is
						kept with the text.
					</p>
				</div>
			)}

			{/* How a range control presents itself. The right answer depends on
			    the question: a preset answers "last quarter", a calendar
			    answers "that specific week", a slider answers "roughly here,
			    let me feel the edges". */}
			{visual.visualType === "dateRangeFilter" && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Presentation</div>
					<select
						className={styles.select}
						value={
							(visual.config.options?.rangeMode as string) ?? "combined"
						}
						onChange={(e) =>
							updateConfig({
								options: {
									...visual.config.options,
									rangeMode: e.target.value,
								},
							})
						}
					>
						<option value="combined">Presets and calendar</option>
						<option value="presets">Presets only</option>
						<option value="calendar">Calendar only</option>
						<option value="slider">Timeline slider</option>
					</select>
					<p className={styles.guidance} style={{ marginTop: 8 }}>
						The slider reads the real extent of the column, so it
						spans the dates that exist rather than an assumed range.
					</p>
				</div>
			)}

			{visual.visualType === "numericRangeFilter" && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Presentation</div>
					<select
						className={styles.select}
						value={
							(visual.config.options?.rangeMode as string) ?? "combined"
						}
						onChange={(e) =>
							updateConfig({
								options: {
									...visual.config.options,
									rangeMode: e.target.value,
								},
							})
						}
					>
						<option value="combined">Slider and boxes</option>
						<option value="slider">Slider only</option>
						<option value="inputs">Boxes only</option>
					</select>
				</div>
			)}

			{supports.color && measures.length > 0 && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Series</div>

					{measures.length > 1 && (
						<div className={styles.field}>
							<select
								className={styles.select}
								value={seriesIndex}
								onChange={(e) => setSeriesIndex(Number(e.target.value))}
							>
								{measures.map((m, i) => (
									<option key={m} value={i}>
										{m}
									</option>
								))}
							</select>
						</div>
					)}

					<div className={styles.field}>
						<span className={styles.fieldLabel}>Colour</span>
						<div className={styles.swatchGrid}>
							{swatches.map((s) => {
								const active =
									seriesEntry?.color &&
									"token" in seriesEntry.color &&
									seriesEntry.color.token === s.token;
								return (
									<button
										key={s.token}
										type="button"
										className={`${styles.swatch} ${active ? styles.swatchActive : ""}`}
										style={{ background: s.hex }}
										title={s.token}
										aria-label={`Colour ${s.token}`}
										onClick={() =>
											updateSeries({
												color: { token: s.token } as ColorSpec,
											})
										}
									/>
								);
							})}
						</div>
					</div>

					{supports.fill && (
						<>
							<div className={styles.field}>
								<label className={styles.fieldLabel}>Fill</label>
								<select
									className={styles.select}
									value={seriesEntry?.fill ?? "none"}
									onChange={(e) =>
										updateSeries({ fill: e.target.value })
									}
								>
									<option value="none">None</option>
									<option value="solid">Solid</option>
									<option value="gradient">Gradient</option>
								</select>
							</div>

							{seriesEntry?.fill && seriesEntry.fill !== "none" && (
								<div className={styles.field}>
									<label className={styles.fieldLabel}>
										Fill opacity{" "}
										{Math.round((seriesEntry.fillOpacity ?? 0.25) * 100)}%
									</label>
									<input
										type="range"
										min={5}
										max={100}
										step={5}
										value={(seriesEntry.fillOpacity ?? 0.25) * 100}
										onChange={(e) =>
											updateSeries({
												fillOpacity: Number(e.target.value) / 100,
											})
										}
										style={{ width: "100%" }}
									/>
								</div>
							)}
						</>
					)}

					{supports.secondAxis && (
						<button
							type="button"
							className={styles.checkRow}
							onClick={() =>
								updateSeries({
									axis: seriesEntry?.axis === "right" ? "left" : "right",
								})
							}
						>
							<Check on={seriesEntry?.axis === "right"} />
							Plot on the right axis
						</button>
					)}

					{supports.stacking && (
						<button
							type="button"
							className={styles.checkRow}
							onClick={() =>
								updateSeries({
									stack: seriesEntry?.stack ? undefined : "total",
								})
							}
						>
							<Check on={Boolean(seriesEntry?.stack)} />
							Stack this series
						</button>
					)}
				</div>
			)}

			{supports.axes && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Axes</div>
					<div className={styles.field}>
						<label className={styles.fieldLabel}>Value axis label</label>
						<input
							className={styles.input}
							value={style.yAxis?.label ?? ""}
							onChange={(e) =>
								updateStyle({
									yAxis: { ...style.yAxis, label: e.target.value },
								})
							}
						/>
					</div>
					<button
						type="button"
						className={styles.checkRow}
						onClick={() =>
							updateStyle({
								yAxis: {
									...style.yAxis,
									beginAtZero: style.yAxis?.beginAtZero === false,
								},
							})
						}
					>
						<Check on={style.yAxis?.beginAtZero !== false} />
						Start the axis at zero
					</button>
					{style.yAxis?.beginAtZero === false && (
						<p className={styles.guidance}>
							A truncated axis makes small differences look large.
							Worth a note on the visual saying so.
						</p>
					)}
				</div>
			)}

			{supports.legend && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Legend</div>
					<button
						type="button"
						className={styles.checkRow}
						onClick={() =>
							updateStyle({
								legend: {
									...style.legend,
									show: style.legend?.show === false,
								},
							})
						}
					>
						<Check on={style.legend?.show !== false} />
						Show the legend
					</button>
				</div>
			)}

			{supports.tooltip && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Tooltip</div>
					<div className={styles.field}>
						<label className={styles.fieldLabel}>Mode</label>
						<select
							className={styles.select}
							value={style.tooltip?.mode ?? "axis"}
							onChange={(e) =>
								updateStyle({
									tooltip: {
										...style.tooltip,
										mode: e.target.value as "single" | "axis",
									},
								})
							}
						>
							<option value="axis">Every series at that point</option>
							<option value="single">Just the hovered point</option>
						</select>
					</div>
					<button
						type="button"
						className={styles.checkRow}
						onClick={() =>
							updateStyle({
								tooltip: {
									...style.tooltip,
									showShare: !style.tooltip?.showShare,
								},
							})
						}
					>
						<Check on={Boolean(style.tooltip?.showShare)} />
						Show each value as a share of the total
					</button>
				</div>
			)}

			{supports.conditionalFormat && (
				<ConditionsEditor
					style={style}
					// A rule tests a value, so measures come first. Dimensions
					// are offered too, for a rule that paints a row based on a
					// category.
					availableFields={[...measures, ...dimensions]}
					// A scale compares across a column of values, which a KPI
					// row does not have: each tile is a single figure.
					allowScales={Boolean(supports.colorScale)}
					onChange={updateStyle}
				/>
			)}

			<div className={styles.section}>
				<div className={styles.sectionTitle}>Loading</div>
				<select
					className={styles.select}
					value={style.loadingAnimation ?? "skeleton"}
					onChange={(e) =>
						updateStyle({
							loadingAnimation: e.target
								.value as VisualStyle["loadingAnimation"],
						})
					}
				>
					<option value="skeleton">Skeleton</option>
					<option value="bars">Chart bars</option>
					<option value="spinner">Spinner</option>
					<option value="pulse">Pulse</option>
					<option value="none">None</option>
				</select>
			</div>
		</>
	);
}
