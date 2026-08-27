"use client";

import { useMemo, useState } from "react";
import {
	visualByType,
	checkEncoding,
	isPageControl,
	type VisualTypeDefinition,
} from "../../lib/visuals/catalog";
import {
	paletteTokens,
	type ColorSpec,
	type PaletteToken,
	type VisualStyle,
} from "../../lib/visuals/style";
import { readThemeColors } from "../visuals/colors";
import { resolveKpiGroups, type KpiGroup } from "../../lib/visuals/kpiGroups";
import { ConditionsEditor } from "./ConditionsEditor";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { HistoryPanel } from "./HistoryPanel";
import { PageSettings } from "./PageSettings";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	CloseIcon,
	Hint,
	Section,
	SectionGroup,
} from "./PanelSection";
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
//
// Two panels used to live in this box with nothing in common: page settings
// drew their labels, inputs and tabs from one set of classes and a selected
// visual drew its own from another, so the panel changed shape depending on
// whether anything was selected. Both now use the same header, tabs, groups and
// fields, and the header says which of the two is on screen.

interface PropertiesPanelProps {
	visual: EditableVisual | null;
	source: SourceMeta | undefined;
	onChange: (next: EditableVisual) => void;
	onRemove: (visualId: string) => void;
	// Back to the page without hunting for a bare patch of canvas to click.
	onDeselect: () => void;
	// The groups on this page, so a visual can be put into one without
	// dragging it there.
	groups: GroupChoice[];
	// The page's own settings, shown here when no visual is selected.
	pageSource: SourceMeta | undefined;
	pageConfig: PageConfig;
	pageTitle: string;
	reportDescription: string;
	placement?: React.ReactNode;
	onPageChange: (next: PageConfig) => void;
	onPageTitleChange: (next: string) => void;
	onDescriptionChange: (next: string) => void;
	// With nothing selected the panel is about the page, and the history is
	// about the page too, so they are tabs of the same panel rather than a
	// button in the toolbar competing with the arranging controls.
	panelTab: "page" | "report" | "history";
	onPanelTab: (tab: "page" | "report" | "history") => void;
	historySlug: string;
	historyKey: number;
	onRestored: () => void;
}

type Tab = "data" | "format";

// A group a visual could be put into: what it is called, and whether putting
// this visual in it would make a loop.
export interface GroupChoice {
	visualId: string;
	label: string;
}

function PanelTabs<T extends string>({
	tabs,
	value,
	onChange,
}: {
	tabs: readonly { id: T; label: string }[];
	value: T;
	onChange: (id: T) => void;
}) {
	return (
		<div className={styles.tabs} role="tablist">
			{tabs.map((tab) => (
				<button
					key={tab.id}
					type="button"
					role="tab"
					aria-selected={value === tab.id}
					className={`${styles.tab} ${value === tab.id ? styles.tabActive : ""}`}
					onClick={() => onChange(tab.id)}
				>
					{tab.label}
				</button>
			))}
		</div>
	);
}

export function PropertiesPanel({
	visual,
	source,
	onChange,
	onRemove,
	onDeselect,
	groups,
	pageSource,
	pageConfig,
	pageTitle,
	reportDescription,
	placement,
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
				<div className={styles.panelHead}>
					<span className={styles.panelKind}>Page</span>
					<span className={styles.panelSubject}>
						{pageTitle.trim() || "Untitled page"}
					</span>
				</div>

				<PanelTabs
					tabs={[
						{ id: "page" as const, label: "Page" },
						// Its own tab rather than a heading part way down the
						// page settings. What a report is called, where it sits
						// and whether it still exists are not properties of the
						// page somebody happens to have open, and looking for
						// them under "Page" means not finding them.
						{ id: "report" as const, label: "Report" },
						{ id: "history" as const, label: "History" },
					]}
					value={panelTab}
					onChange={onPanelTab}
				/>

				{panelTab === "history" ? (
					<HistoryPanel
						slug={historySlug}
						refreshKey={historyKey}
						onRestored={onRestored}
					/>
				) : panelTab === "report" ? (
					<div className={styles.panelBody}>
						<SectionGroup>
							<Section id="report-about" title="About">
								<div className={styles.field}>
									<label
										className={styles.fieldLabel}
										htmlFor="report-subtitle"
									>
										Subtitle
									</label>
									<textarea
										id="report-subtitle"
										className={styles.input}
										rows={2}
										placeholder="What this report is for"
										value={reportDescription}
										onChange={(e) =>
											onDescriptionChange(e.target.value)
										}
									/>
									<Hint>
										The line under the report title, on
										every page.
									</Hint>
								</div>
							</Section>

							{placement}
						</SectionGroup>
					</div>
				) : (
					<div className={styles.panelBody}>
						<SectionGroup>
							<PageSettings
								source={pageSource}
								config={pageConfig}
								pageTitle={pageTitle}
								onChange={onPageChange}
								onPageTitleChange={onPageTitleChange}
							/>
						</SectionGroup>
					</div>
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
			<div className={styles.panelHead}>
				{/* The only way back to the page settings was to find an empty
				    patch of canvas and click it, which on a full page there is
				    not one of. */}
				<button
					type="button"
					className={styles.panelBack}
					onClick={onDeselect}
					title="Back to page settings"
					aria-label="Back to page settings"
				>
					<svg
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
						<path d="M15 18l-6-6 6-6" />
					</svg>
				</button>
				<span className={styles.panelKind}>{definition.label}</span>
				<span className={styles.panelSubject}>
					{visual.title?.trim() || "Untitled"}
				</span>
			</div>

			<PanelTabs
				tabs={[
					{ id: "data" as const, label: "Data" },
					{ id: "format" as const, label: "Format" },
				]}
				value={tab}
				onChange={setTab}
			/>

			<div className={styles.panelBody}>
				<SectionGroup>
					{tab === "data" ? (
						<DataTab
							visual={visual}
							definition={definition}
							source={source}
							dimensions={dimensions}
							measures={measures}
							groups={groups}
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
							groups={groups}
							style={style}
							updateStyle={updateStyle}
							updateConfig={updateConfig}
						/>
					)}
				</SectionGroup>
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
	groups,
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
	groups: GroupChoice[];
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

	const parentId =
		typeof visual.config.parentId === "string"
			? visual.config.parentId
			: null;
	// A group cannot hold itself. Deeper loops are refused where the change is
	// applied, which is the only place that can see the whole chain.
	const groupChoices = groups.filter((g) => g.visualId !== visual.visualId);

	// A page control renders bare in the reader's filter strip and a text panel
	// carries its own body, so neither has anywhere to put a note.
	const showNote =
		!isPageControl(visual.visualType) && visual.visualType !== "textPanel";
	const isNotice = visual.visualType === "blockedNotice";
	const noteValue =
		typeof visual.config.options?.note === "string"
			? visual.config.options.note
			: "";

	const showMeasures = definition.encoding.measures.max > 0;
	const showDimensions = definition.encoding.dimensions.max > 0;
	const nothingMatched =
		(!showMeasures || filtered.measures.length === 0) &&
		(!showDimensions || filtered.dimensions.length === 0);

	return (
		<>
			{/* The one bordered note in the panel, and it earns the border:
			    it says what this kind of visual is for, which is the question
			    an author has before any of the settings below it. */}
			<p className={styles.guidance}>{definition.guidance}</p>

			{problem && (
				<div className={styles.conflict} role="status">
					{problem.message}
				</div>
			)}

			<Section id="visual-basics" title="Basics">
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
					<Select
						id="visual-type"
						value={visual.visualType}
						onChange={(v) => update({ visualType: v })}
						searchable
						options={Object.values(visualByType).map((d) => ({
							value: d.type,
							label: d.label,
						}))}
					/>
				</div>

				{/* Which group holds this, for the times dragging it there is
				    not the easy gesture: a visual already inside a group has
				    nowhere on the canvas to be dragged out to. */}
				{groupChoices.length > 0 && (
					<div className={styles.field}>
						<label
							className={styles.fieldLabel}
							htmlFor="visual-group"
						>
							Inside group
						</label>
						<Select
							id="visual-group"
							value={parentId ?? ""}
							onChange={(next) =>
								updateConfig({ parentId: next || undefined })
							}
							options={[
								{ value: "", label: "Not in a group" },
								...groupChoices.map((choice) => ({
									value: choice.visualId,
									label: choice.label,
								})),
							]}
						/>
						<Hint>
							Dragging a visual onto a group puts it inside. This
							is how it comes back out.
						</Hint>
					</div>
				)}

				{/* The line under the title. Every framed visual has rendered
				    one for as long as the renderer has read config.options.note,
				    and no type in the catalogue declared it, so the panel never
				    drew a control: a note put there by a template was on the
				    page with no way to change it. */}
				{showNote && (
					<div className={styles.field}>
						<label
							className={styles.fieldLabel}
							htmlFor="visual-note"
						>
							{isNotice ? "Message" : "Note"}
						</label>
						<textarea
							id="visual-note"
							className={styles.input}
							rows={2}
							placeholder={
								isNotice
									? "What this page is waiting on"
									: "A caveat, a definition, what to read it as"
							}
							value={noteValue}
							onChange={(e) =>
								updateConfig({
									options: {
										...visual.config.options,
										note: e.target.value || undefined,
									},
								})
							}
						/>
						<Hint>
							{isNotice
								? "Shown in place of the visual."
								: "Shown under the title, above the visual."}
						</Hint>
					</div>
				)}
			</Section>

			{/* One group rather than two. Choosing a field and ordering the
			    ones already chosen are the same job, and splitting them meant
			    the list of what was selected scrolled away from the list it was
			    selected from. */}
			<Section
				id="visual-fields"
				title="Fields"
				count={dimensions.length + measures.length}
			>
				{showMeasures && (
					<SelectedList
						label="Measures"
						items={measures}
						limit={definition.encoding.measures}
						onRemove={(name) => toggle(name, "measures")}
						onMove={(from, to) => reorder("measures", from, to)}
					/>
				)}
				{showDimensions && (
					<SelectedList
						label="Dimensions"
						items={dimensions}
						limit={definition.encoding.dimensions}
						onRemove={(name) => toggle(name, "dimensions")}
						onMove={(from, to) => reorder("dimensions", from, to)}
					/>
				)}
				{dimensions.length + measures.length > 1 && (
					<Hint>
						Order is the encoding. The first dimension is the axis
						and the first measure is the one anything ranked is
						ranked by.
					</Hint>
				)}

				<input
					className={styles.input}
					placeholder="Search fields"
					value={fieldSearch}
					onChange={(e) => setFieldSearch(e.target.value)}
				/>

				{/* Scrolls itself. A wide source puts a hundred and twenty rows
				    in this column, and everything below them, the drill path
				    and the remove control included, sat under all of it. */}
				<div className={styles.fieldList}>
					{nothingMatched ? (
						<p className={styles.listEmpty}>
							{source
								? `Nothing matches "${fieldSearch.trim()}".`
								: "This visual has no source yet."}
						</p>
					) : (
						<>
							{showMeasures && filtered.measures.length > 0 && (
								<>
									<div className={styles.listHeading}>
										Measures ({filtered.measures.length})
									</div>
									{filtered.measures.slice(0, 60).map((f) => (
										<FieldRow
											key={f.name}
											name={f.name}
											description={f.description}
											selected={measures.includes(f.name)}
											full={
												measures.length >=
												definition.encoding.measures.max
											}
											onToggle={() =>
												toggle(f.name, "measures")
											}
										/>
									))}
								</>
							)}

							{showDimensions &&
								filtered.dimensions.length > 0 && (
									<>
										<div className={styles.listHeading}>
											Dimensions (
											{filtered.dimensions.length})
										</div>
										{filtered.dimensions
											.slice(0, 60)
											.map((f) => (
												<FieldRow
													key={f.name}
													name={f.name}
													description={f.description}
													selected={dimensions.includes(
														f.name,
													)}
													full={
														dimensions.length >=
														definition.encoding
															.dimensions.max
													}
													onToggle={() =>
														toggle(
															f.name,
															"dimensions",
														)
													}
												/>
											))}
									</>
								)}
						</>
					)}
				</div>
			</Section>

			{/* A drill hierarchy turns a click into a descent rather than a
			    cross-filter, so it is only offered where that makes sense. */}
			{definition.category !== "filter" && dimensions.length > 1 && (
				<Section
					id="visual-drill"
					title="Drill hierarchy"
					defaultOpen={false}
					count={visual.config.options?.drillFields ? 1 : 0}
				>
					<button
						type="button"
						className={styles.checkRow}
						onClick={() =>
							updateConfig({
								options: {
									...visual.config.options,
									drillFields: visual.config.options
										?.drillFields
										? undefined
										: dimensions,
								},
							})
						}
					>
						<Check
							on={Boolean(visual.config.options?.drillFields)}
						/>
						Use the selected dimensions as a drill path
					</button>
					<Hint>
						Clicking descends the dimensions in the order above
						instead of cross-filtering the page.
					</Hint>
				</Section>
			)}

			{/* Set apart rather than stacked with the settings, and matching
			    the delete control on the Report tab, so the one thing in the
			    panel that cannot be undone looks the same wherever it is. */}
			<div className={styles.dangerBlock}>
				<span className={styles.fieldLabel}>Remove this visual</span>
				<Hint>
					It comes off this page. Nothing else on the page changes.
				</Hint>
				<button
					type="button"
					className={styles.dangerButton}
					onClick={() => onRemove(visual.visualId)}
				>
					Remove visual
				</button>
			</div>
		</>
	);
}

function SelectedList({
	label,
	items,
	limit,
	onRemove,
	onMove,
}: {
	label: string;
	items: string[];
	limit: { min: number; max: number };
	onRemove: (name: string) => void;
	onMove: (from: number, to: number) => void;
}) {
	return (
		<div className={styles.field}>
			<span className={styles.fieldLabel}>
				{label}
				{/* What the type will take. The panel used to accept a seventh
				    measure silently and leave the author to work out from the
				    complaint below the chart which of the seven was one too
				    many. */}
				<span className={styles.fieldCount}>
					{items.length} of {limit.max}
				</span>
			</span>
			{items.length === 0 ? (
				<p className={styles.listEmpty}>
					{limit.min > 0
						? `Needs at least ${limit.min}.`
						: "None chosen."}
				</p>
			) : (
				items.map((name, i) => (
					<div key={name} className={styles.selectedRow}>
						<span className={styles.selectedName} title={name}>
							{name}
						</span>
						<button
							type="button"
							className={styles.iconButton}
							onClick={() => onMove(i, i - 1)}
							disabled={i === 0}
							aria-label={`Move ${name} up`}
						>
							<ArrowUpIcon />
						</button>
						<button
							type="button"
							className={styles.iconButton}
							onClick={() => onMove(i, i + 1)}
							disabled={i === items.length - 1}
							aria-label={`Move ${name} down`}
						>
							<ArrowDownIcon />
						</button>
						<button
							type="button"
							className={`${styles.iconButton} ${styles.iconRemove}`}
							onClick={() => onRemove(name)}
							aria-label={`Remove ${name}`}
						>
							<CloseIcon />
						</button>
					</div>
				))
			)}
		</div>
	);
}

function FieldRow({
	name,
	description,
	selected,
	full,
	onToggle,
}: {
	name: string;
	description: string | null;
	selected: boolean;
	// The type will not take another of this kind. Still clickable when it is
	// already on, since taking one off is how an author makes room.
	full: boolean;
	onToggle: () => void;
}) {
	const blocked = full && !selected;
	return (
		<button
			type="button"
			className={styles.checkRow}
			onClick={onToggle}
			disabled={blocked}
			aria-pressed={selected}
			// The catalogue description is the tooltip, so an author sees the
			// same definition a reader will.
			title={
				blocked
					? "Remove one first. This visual takes no more of these."
					: (description ?? name)
			}
		>
			<Check on={selected} />
			<span className={styles.checkLabel}>{name}</span>
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

// The settings a type declares, drawn from the catalogue.
//
// Every control here used to be written by hand next to a check on
// visual.visualType, which is why several options the renderer reads had no
// control at all: adding one meant editing this file, and whoever added the
// option to the renderer did not. Reading the declaration means a type gains a
// control by declaring it, and the default the control shows is the same one
// the renderer falls back to.
function VisualOptions({
	visual,
	definition,
	dimensions,
	measures,
	groups,
	updateConfig,
}: {
	visual: EditableVisual;
	definition: VisualTypeDefinition;
	dimensions: string[];
	measures: string[];
	groups: GroupChoice[];
	updateConfig: (patch: Record<string, unknown>) => void;
}) {
	const declared = definition.options ?? [];
	if (declared.length === 0) return null;

	const set = (key: string, value: unknown) =>
		updateConfig({
			options: { ...(visual.config.options ?? {}), [key]: value },
		});

	// The stored value, or nothing. Deliberately not the catalogue default: a
	// control has to show empty when nobody has chosen, or an author cannot
	// tell a deliberate choice from a fallback.
	const stored = (key: string): unknown => visual.config.options?.[key];

	const chosen = declared.filter(
		(option) => stored(option.key) !== undefined,
	).length;

	return (
		<Section id="visual-options" title="Options" count={chosen}>
			{declared.map((option) => {
				const value = stored(option.key);

				if (option.kind === "select") {
					return (
						<div key={option.key} className={styles.field}>
							<label className={styles.fieldLabel}>
								{option.label}
							</label>
							<Select
								value={
									(value as string) ??
									String(option.fallback ?? "")
								}
								onChange={(v) => set(option.key, v)}
								ariaLabel={option.label}
								options={option.choices.map((choice) => ({
									value: choice.value,
									label: choice.label,
								}))}
							/>
							{option.help && <Hint>{option.help}</Hint>}
						</div>
					);
				}

				if (option.kind === "toggle") {
					return (
						<div key={option.key} className={styles.field}>
							<Toggle
								checked={
									typeof value === "boolean"
										? value
										: option.fallback
								}
								onChange={(next) => set(option.key, next)}
								label={option.label}
							/>
							{option.help && <Hint>{option.help}</Hint>}
						</div>
					);
				}

				if (option.kind === "number") {
					return (
						<div key={option.key} className={styles.field}>
							<label className={styles.fieldLabel}>
								{option.label}
							</label>
							<input
								type="number"
								className={styles.input}
								value={value === undefined ? "" : String(value)}
								min={option.min}
								max={option.max}
								step={option.step}
								onChange={(e) =>
									// Empty means unset rather than zero. They
									// are different answers: one is "no cutoff",
									// the other is "a cutoff of nothing".
									set(
										option.key,
										e.target.value === ""
											? undefined
											: Number(e.target.value),
									)
								}
							/>
							{option.help && <Hint>{option.help}</Hint>}
						</div>
					);
				}

				if (option.kind === "text") {
					return (
						<div key={option.key} className={styles.field}>
							<label className={styles.fieldLabel}>
								{option.label}
							</label>
							<input
								type="text"
								className={styles.input}
								value={(value as string) ?? ""}
								placeholder={option.placeholder}
								onChange={(e) =>
									set(
										option.key,
										e.target.value === ""
											? undefined
											: e.target.value,
									)
								}
							/>
							{option.help && <Hint>{option.help}</Hint>}
						</div>
					);
				}

				if (option.kind === "measureGroups") {
					return (
						<MeasureBands
							key={option.key}
							option={option}
							measures={measures}
							value={
								(visual.config.options?.[option.key] as
									| KpiGroup[]
									| undefined) ?? []
							}
							onChange={(next) => set(option.key, next)}
						/>
					);
				}

				// A field the visual already reads, so the list is what the
				// author has encoded rather than everything the source offers.
				const choices =
					option.scope === "measure" ? measures : dimensions;
				return (
					<div key={option.key} className={styles.field}>
						<label className={styles.fieldLabel}>
							{option.label}
						</label>
						<Select
							value={(value as string) ?? ""}
							onChange={(v) =>
								set(option.key, v === "" ? undefined : v)
							}
							ariaLabel={option.label}
							searchable={choices.length > 12}
							options={[
								{ value: "", label: "None" },
								...choices.map((name) => ({
									value: name,
									label: name,
								})),
							]}
						/>
						{option.help && <Hint>{option.help}</Hint>}
					</div>
				);
			})}
		</Section>
	);
}

// Which panel a control sits behind.
//
// A panel is named by whichever control is put into it first, so this is a list
// of what is already named plus a way to name a new one. It used to be a bare
// text box: the first control worked, and the second joined it only if the name
// was retyped exactly, with a second panel appearing silently when it was not.
// Splitting the measures into labelled bands.
//
// Shown as the measures themselves with a break between them, rather than as
// counts to add up, because a count is a description of the list and the author
// is looking at the list. Adding a break here is the same gesture as deciding
// where one group ends.
function MeasureBands({
	option,
	measures,
	value,
	onChange,
}: {
	option: { key: string; label: string; help?: string };
	measures: string[];
	value: KpiGroup[];
	onChange: (next: KpiGroup[]) => void;
}) {
	const bands = resolveKpiGroups(measures, value);

	// Rewritten from the bands on screen rather than patched, so what is stored
	// always describes the list as it currently is. A count left over from a
	// measure that has since been removed is how these drift.
	const rewrite = (next: { label: string | null; measures: string[] }[]) =>
		onChange(
			next
				.filter((b) => b.measures.length > 0)
				.map((b) => ({
					label: b.label ?? undefined,
					count: b.measures.length,
				})),
		);

	// A break before this measure starts a new band at it.
	const toggleBreak = (measure: string) => {
		const flat = bands.flatMap((b) => b.measures);
		const at = flat.indexOf(measure);
		if (at <= 0) return;

		const starts = new Set<number>();
		let index = 0;
		for (const band of bands) {
			starts.add(index);
			index += band.measures.length;
		}

		if (starts.has(at)) starts.delete(at);
		else starts.add(at);

		const ordered = Array.from(starts).sort((a, b) => a - b);
		const labelAt = new Map(
			bands.map((b, i) => {
				let offset = 0;
				for (let k = 0; k < i; k++) offset += bands[k].measures.length;
				return [offset, b.label] as const;
			}),
		);

		rewrite(
			ordered.map((from, i) => ({
				label: labelAt.get(from) ?? null,
				measures: flat.slice(from, ordered[i + 1] ?? flat.length),
			})),
		);
	};

	const rename = (index: number, label: string) =>
		rewrite(
			bands.map((b, i) =>
				i === index ? { ...b, label: label || null } : b,
			),
		);

	if (measures.length === 0) {
		return (
			<div className={styles.field}>
				<label className={styles.fieldLabel}>{option.label}</label>
				<Hint>Add measures first, then split them into bands.</Hint>
			</div>
		);
	}

	let position = 0;
	return (
		<div className={styles.field}>
			<label className={styles.fieldLabel}>{option.label}</label>

			{bands.map((band, i) => {
				const first = position;
				position += band.measures.length;
				return (
					<div key={first} className={styles.bandGroup}>
						<input
							type="text"
							className={styles.input}
							placeholder={
								i === 0 ? "Band name, optional" : "Band name"
							}
							value={band.label ?? ""}
							onChange={(e) => rename(i, e.target.value)}
						/>
						{band.measures.map((measure, k) => (
							<div key={measure} className={styles.bandMeasure}>
								<span>{measure}</span>
								{/* The first measure of the first band has
								    nothing above it to break from. */}
								{!(i === 0 && k === 0) && (
									<button
										type="button"
										className={styles.bandBreak}
										title={
											k === 0
												? "Join to the band above"
												: "Start a new band here"
										}
										onClick={() => toggleBreak(measure)}
									>
										{k === 0 ? "join up" : "split here"}
									</button>
								)}
							</div>
						))}
					</div>
				);
			})}

			{option.help && <Hint>{option.help}</Hint>}
		</div>
	);
}

function FormatTab({
	visual,
	definition,
	dimensions,
	measures,
	groups,
	style,
	updateStyle,
	updateConfig,
}: {
	visual: EditableVisual;
	definition: VisualTypeDefinition;
	dimensions: string[];
	measures: string[];
	groups: GroupChoice[];
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

	// What each group carries, so a closed group still says whether anything
	// inside it was touched.
	const appearanceCount = [
		style.cornerRadius !== undefined,
		style.stripedRows !== undefined,
		style.loadingAnimation !== undefined,
		visual.config.options?.fillHeight !== undefined,
	].filter(Boolean).length;
	const axesCount = [
		Boolean(style.yAxis?.label),
		style.yAxis?.beginAtZero === false,
	].filter(Boolean).length;
	const chromeCount = [
		style.legend?.show === false,
		Boolean(style.tooltip?.mode) && style.tooltip?.mode !== "axis",
		Boolean(style.tooltip?.showShare),
	].filter(Boolean).length;

	return (
		<>
			{visual.visualType === "textPanel" && (
				<p className={styles.guidance}>
					Select the panel on the canvas and type into it. The
					formatting toolbar appears with it, and the styling is kept
					with the text.
				</p>
			)}

			<VisualOptions
				visual={visual}
				definition={definition}
				dimensions={dimensions}
				measures={measures}
				groups={groups}
				updateConfig={updateConfig}
			/>

			{supports.color && measures.length > 0 && (
				<Section
					id="visual-series"
					title="Series"
					count={(style.series ?? []).length}
				>
					{measures.length > 1 && (
						<div className={styles.field}>
							<label className={styles.fieldLabel}>
								Series to style
							</label>
							<Select
								value={String(seriesIndex)}
								onChange={(v) => setSeriesIndex(Number(v))}
								ariaLabel="Series"
								options={measures.map((m, i) => ({
									value: String(i),
									label: m,
								}))}
							/>
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
												color: {
													token: s.token,
												} as ColorSpec,
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
								<label className={styles.fieldLabel}>
									Fill
								</label>
								<Select
									value={seriesEntry?.fill ?? "none"}
									onChange={(v) => updateSeries({ fill: v })}
									ariaLabel="Fill"
									options={[
										{ value: "none", label: "None" },
										{ value: "solid", label: "Solid" },
										{
											value: "gradient",
											label: "Gradient",
										},
									]}
								/>
							</div>

							{seriesEntry?.fill &&
								seriesEntry.fill !== "none" && (
									<div className={styles.field}>
										<label className={styles.fieldLabel}>
											Fill opacity
											<span className={styles.fieldCount}>
												{Math.round(
													(seriesEntry.fillOpacity ??
														0.25) * 100,
												)}
												%
											</span>
										</label>
										<input
											type="range"
											className={styles.range}
											min={5}
											max={100}
											step={5}
											value={
												(seriesEntry.fillOpacity ??
													0.25) * 100
											}
											onChange={(e) =>
												updateSeries({
													fillOpacity:
														Number(e.target.value) /
														100,
												})
											}
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
									axis:
										seriesEntry?.axis === "right"
											? "left"
											: "right",
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
									stack: seriesEntry?.stack
										? undefined
										: "total",
								})
							}
						>
							<Check on={Boolean(seriesEntry?.stack)} />
							Stack this series
						</button>
					)}
				</Section>
			)}

			{supports.axes && (
				<Section
					id="visual-axes"
					title="Axes"
					defaultOpen={false}
					count={axesCount}
				>
					<div className={styles.field}>
						<label className={styles.fieldLabel}>
							Value axis label
						</label>
						<input
							className={styles.input}
							value={style.yAxis?.label ?? ""}
							onChange={(e) =>
								updateStyle({
									yAxis: {
										...style.yAxis,
										label: e.target.value,
									},
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
									beginAtZero:
										style.yAxis?.beginAtZero === false,
								},
							})
						}
					>
						<Check on={style.yAxis?.beginAtZero !== false} />
						Start the axis at zero
					</button>
					{style.yAxis?.beginAtZero === false && (
						<Hint>
							A truncated axis makes small differences look large.
							Worth a note on the visual saying so.
						</Hint>
					)}
				</Section>
			)}

			{/* Corner rounding and row shading are two settings the renderers
			    have always honoured and nothing could set: a chart drew its
			    bars with a two pixel corner because that is what the fallback
			    said, and a grid striped its rows because the same. */}
			<Section
				id="visual-appearance"
				title="Appearance"
				defaultOpen={false}
				count={appearanceCount}
			>
				{supports.fillHeight && (
					<div className={styles.field}>
						<Toggle
							checked={
								visual.config.options?.fillHeight !== false
							}
							onChange={(next) =>
								updateConfig({
									options: {
										...visual.config.options,
										fillHeight: next,
									},
								})
							}
							label="Fill the screen when it is last on the page"
						/>
						<Hint>
							On by default. Turn it off where the table is
							deliberately a preview. The canvas shows the height
							a reader will get.
						</Hint>
					</div>
				)}

				{(supports.fill || supports.stacking) && (
					<div className={styles.field}>
						<label className={styles.fieldLabel}>
							Corner rounding
							<span className={styles.fieldCount}>
								{style.cornerRadius ?? 2}
							</span>
						</label>
						<input
							type="range"
							className={styles.range}
							min={0}
							max={12}
							step={1}
							value={style.cornerRadius ?? 2}
							onChange={(e) =>
								updateStyle({
									cornerRadius: Number(e.target.value),
								})
							}
						/>
						<Hint>
							Past about six a bar stops reading as a length,
							which is the thing it is measuring.
						</Hint>
					</div>
				)}

				{supports.conditionalFormat && (
					<div className={styles.field}>
						<Toggle
							checked={style.stripedRows !== false}
							onChange={(next) =>
								updateStyle({ stripedRows: next })
							}
							label="Shade alternate rows"
						/>
						<Hint>
							Reading across a wide row is where a grid loses
							people.
						</Hint>
					</div>
				)}

				<div className={styles.field}>
					<label className={styles.fieldLabel}>While it loads</label>
					<Select
						value={style.loadingAnimation ?? "skeleton"}
						onChange={(v) =>
							updateStyle({
								loadingAnimation:
									v as VisualStyle["loadingAnimation"],
							})
						}
						ariaLabel="While it loads"
						options={[
							{
								value: "skeleton",
								label: "Shape of the content",
							},
							{ value: "bars", label: "Bars" },
							{ value: "spinner", label: "Spinner" },
							{ value: "pulse", label: "Pulse" },
							{ value: "none", label: "Nothing" },
						]}
					/>
				</div>
			</Section>

			{/* One group for the two smallest: a legend is a single switch and
			    a tooltip is a switch and a choice, and each as its own titled
			    group cost more height in headings than in controls. */}
			{(supports.legend || supports.tooltip) && (
				<Section
					id="visual-chrome"
					title="Legend and tooltip"
					defaultOpen={false}
					count={chromeCount}
				>
					{supports.legend && (
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
					)}

					{supports.tooltip && (
						<>
							<div className={styles.field}>
								<label className={styles.fieldLabel}>
									Tooltip shows
								</label>
								<Select
									value={style.tooltip?.mode ?? "axis"}
									onChange={(v) =>
										updateStyle({
											tooltip: {
												...style.tooltip,
												mode: v as "single" | "axis",
											},
										})
									}
									ariaLabel="Tooltip mode"
									options={[
										{
											value: "axis",
											label: "Every series at that point",
										},
										{
											value: "single",
											label: "Just the hovered point",
										},
									]}
								/>
							</div>
							<button
								type="button"
								className={styles.checkRow}
								onClick={() =>
									updateStyle({
										tooltip: {
											...style.tooltip,
											showShare:
												!style.tooltip?.showShare,
										},
									})
								}
							>
								<Check on={Boolean(style.tooltip?.showShare)} />
								Show each value as a share of the total
							</button>
						</>
					)}
				</Section>
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
		</>
	);
}
