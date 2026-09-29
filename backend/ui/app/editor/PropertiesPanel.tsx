"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	visualByType,
	checkEncoding,
	isPageControl,
	type VisualTypeDefinition,
} from "../../lib/visuals/catalog";
import {
	paletteTokens,
	palettePresets,
	type ColorSpec,
	type PaletteToken,
	type VisualStyle,
} from "../../lib/visuals/style";
import { readThemeColors } from "../visuals/colors";
import { resolveKpiGroups, type KpiGroup } from "../../lib/visuals/kpiGroups";
import { ConditionsEditor } from "./ConditionsEditor";
import { ReferenceLinesEditor } from "./ReferenceLinesEditor";
import { DerivedFigures } from "./DerivedFigures";
import { chartTypes, gridTypes } from "../../lib/query/visualSpec";
import type { QueryTransform } from "../../lib/query/transform";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { HistoryPanel } from "./HistoryPanel";
import { PageSettings } from "./PageSettings";
import { Check, FieldList } from "./FieldList";
import {
	Chevron,
	CloseIcon,
	Hint,
	Section,
	SectionGroup,
} from "./PanelSection";
import { createPortal } from "react-dom";
import { VisualPicker } from "./VisualPicker";
import type { PageConfig } from "./ReportEditor";
import { isTemporalField, type SourceMeta } from "../visuals/types";
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
	onDuplicate: () => void;
	// Back to the page without hunting for a bare patch of canvas to click.
	onDeselect: () => void;
	// The page is locked against changes. The panel still opens, because
	// reading how a visual is put together is not a change, but its controls
	// stop accepting edits that the server would refuse.
	readOnly?: boolean;
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
	// Closes the panel, which the rail beside it opens again. The rail also
	// picks which of page, report and history is shown, so the panel does not
	// repeat that choice as tabs of its own.
	onClose?: () => void;
	historySlug: string;
	historyKey: number;
	// The history's comparison draws both versions of the page, so it needs
	// every source on it rather than the one the selected visual reads.
	reportId: string;
	sources: Record<string, SourceMeta>;
	onRestored: () => void;
}

type Tab = "data" | "behaviour" | "style";

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
	onDuplicate,
	onDeselect,
	readOnly = false,
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
	reportId,
	sources,
	onRestored,
	onClose,
}: PropertiesPanelProps) {
	const [tab, setTab] = useState<Tab>("data");
	const [fieldSearch, setFieldSearch] = useState("");
	// Text typed into the panel's search, which shows every tab at once with
	// only the groups that mention it.
	const [query, setQuery] = useState("");
	const [picking, setPicking] = useState(false);
	// What the last type change had to take off, so the author is told rather
	// than left to notice.
	const [trimmed, setTrimmed] = useState<{
		dimensions: number;
		measures: number;
	} | null>(null);
	const [noMatch, setNoMatch] = useState(false);
	const bodyRef = useRef<HTMLDivElement | null>(null);

	// A different visual starts clean. The tab is kept, since an author
	// styling one chart after another is still styling.
	const visualId = visual?.visualId;
	useEffect(() => {
		setTrimmed(null);
		setQuery("");
		setPicking(false);
	}, [visualId]);

	// Whether the search hid every group, read after the groups have decided.
	// A tab with nothing left showing is hidden along with its heading.
	useLayoutEffect(() => {
		const body = bodyRef.current;
		for (const tabGroup of Array.from(
			body?.querySelectorAll<HTMLElement>("[data-search-tab]") ?? [],
		)) {
			tabGroup.hidden = Boolean(
				query.trim() &&
				!tabGroup.querySelector("[data-section]:not([hidden])"),
			);
		}
		const none =
			Boolean(query.trim()) &&
			(body?.querySelectorAll("[data-section]:not([hidden])").length ??
				0) === 0;
		setNoMatch((held) => (held === none ? held : none));
	});

	const definition = visual ? visualByType[visual.visualType] : undefined;

	const close = onClose ? (
		<button
			type="button"
			className={styles.panelBack}
			onClick={onClose}
			title="Close the panel"
			aria-label="Close the panel"
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2.5"
				strokeLinecap="round"
				aria-hidden="true"
			>
				<path d="M6 6l12 12M18 6L6 18" />
			</svg>
		</button>
	) : null;

	if (!visual || !definition) {
		return (
			<div className={styles.panel}>
				<div className={styles.panelHead}>
					<span className={styles.panelKind}>
						{panelTab === "report"
							? "Report"
							: panelTab === "history"
								? "History"
								: "Page"}
					</span>
					<span className={styles.panelSubject}>
						{pageTitle.trim() || "Untitled page"}
					</span>
					{close}
				</div>

				{/* Its own place rather than a heading part way down the page
				    settings. What a report is called, where it sits and
				    whether it still exists are not properties of the page
				    somebody happens to have open. With the rail beside the
				    panel choosing between them, the tabs are left out. */}
				{!onClose && (
					<PanelTabs
						tabs={[
							{ id: "page" as const, label: "Page" },
							{ id: "report" as const, label: "Report" },
							{ id: "history" as const, label: "History" },
						]}
						value={panelTab}
						onChange={onPanelTab}
					/>
				)}

				{panelTab === "history" ? (
					<HistoryPanel
						slug={historySlug}
						reportId={reportId}
						sources={sources}
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
					<div
						className={`${styles.panelBody} ${readOnly ? styles.panelReadOnly : ""}`}
					>
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

	// Changing the type keeps the fields, trimmed to what the new type takes.
	//
	// Kept, because the fields are usually the reason for the change: the same
	// figures drawn a different way, and clearing them would mean choosing
	// every one again. Trimmed, because a type holding more than its encoding
	// allows renders a refusal instead of a chart, and the author is then left
	// working out which field to take off.
	//
	// One call rather than a type change followed by a field change. Both
	// helpers build their patch from the visual as it stands, so the second
	// would be written against the state before the first and discard it.
	const changeType = (nextType: string) => {
		const next = visualByType[nextType];
		if (!next) {
			return { droppedDimensions: 0, droppedMeasures: 0 };
		}

		const keptDimensions = dimensions.slice(
			0,
			next.encoding.dimensions.max,
		);
		const keptMeasures = measures.slice(0, next.encoding.measures.max);

		onChange({
			...visual,
			visualType: nextType,
			config: {
				...visual.config,
				dimensions: keptDimensions,
				measures: keptMeasures,
			},
		});

		return {
			droppedDimensions: dimensions.length - keptDimensions.length,
			droppedMeasures: measures.length - keptMeasures.length,
		};
	};

	const problem = checkEncoding(visual.visualType, dimensions, measures);

	return (
		<div className={styles.panel}>
			{/* What is selected and what can be done to it, in one place: its
			    kind, which opens the picker to change it, its title edited
			    where it is shown, and copying or removing it. Removing is one
			    Ctrl+Z from coming back, like every other edit here. */}
			<div className={styles.visualHead}>
				<div className={styles.visualHeadRow}>
					<button
						type="button"
						className={styles.typeChip}
						onClick={() => setPicking(true)}
						title={`${definition.guidance} Click to change the kind of visual.`}
						disabled={readOnly}
					>
						<span>{definition.label}</span>
						<Chevron open={false} />
					</button>
					<span className={styles.visualHeadActions}>
						<button
							type="button"
							className={styles.headIcon}
							onClick={onDuplicate}
							title="Duplicate. A copy lands beside it with the same fields and formatting. Ctrl+C and Ctrl+V move one between pages."
							aria-label="Duplicate visual"
							disabled={readOnly}
						>
							<svg
								width="15"
								height="15"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<rect
									x="9"
									y="9"
									width="12"
									height="12"
									rx="2"
								/>
								<path d="M5 15V5a2 2 0 0 1 2-2h10" />
							</svg>
						</button>
						<button
							type="button"
							className={`${styles.headIcon} ${styles.headIconDanger}`}
							onClick={() => onRemove(visual.visualId)}
							title="Remove from this page. Ctrl+Z puts it back."
							aria-label="Remove visual"
							disabled={readOnly}
						>
							<svg
								width="15"
								height="15"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
							</svg>
						</button>
						{close}
					</span>
				</div>
				<input
					className={styles.titleInput}
					value={visual.title ?? ""}
					placeholder="Untitled"
					aria-label="Title"
					readOnly={readOnly}
					onChange={(e) => update({ title: e.target.value })}
				/>
				{trimmed && (
					<p className={styles.hint}>
						{describeTrim(trimmed)} The rest carried over.
					</p>
				)}
			</div>

			<div className={styles.panelSearch}>
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="7" />
					<path d="M21 21l-4.35-4.35" />
				</svg>
				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") setQuery("");
					}}
					placeholder="Find a setting, such as legend or top"
					aria-label="Find a setting"
				/>
				{query && (
					<button
						type="button"
						className={styles.panelSearchClear}
						onClick={() => setQuery("")}
						aria-label="Clear the search"
					>
						<CloseIcon />
					</button>
				)}
			</div>

			{!query && (
				<PanelTabs
					tabs={[
						{ id: "data" as const, label: "Data" },
						{ id: "behaviour" as const, label: "Behaviour" },
						{ id: "style" as const, label: "Style" },
					]}
					value={tab}
					onChange={setTab}
				/>
			)}

			{/* What stops it drawing, with the way to fix it beside it. */}
			{problem && !query && (
				<div className={styles.problem} role="status">
					<span>{problem.message}</span>
					{tab !== "data" && (
						<button
							type="button"
							className={styles.problemAction}
							onClick={() => setTab("data")}
						>
							Choose fields
						</button>
					)}
				</div>
			)}

			<div
				ref={bodyRef}
				className={`${styles.panelBody} ${readOnly ? styles.panelReadOnly : ""}`}
			>
				<SectionGroup
					query={query}
					persistKey="sightline.editor.visualSections"
					compactHints
				>
					{(query || tab === "data") && (
						<div data-search-tab>
							{query && (
								<h3 className={styles.tabHeading}>Data</h3>
							)}
							<DataTab
								visual={visual}
								definition={definition}
								source={source}
								dimensions={dimensions}
								measures={measures}
								groups={groups}
								fieldSearch={fieldSearch}
								setFieldSearch={setFieldSearch}
								updateConfig={updateConfig}
								onFieldsChanged={() => setTrimmed(null)}
							/>
						</div>
					)}
					{(query || tab === "behaviour") && (
						<div data-search-tab>
							{query && (
								<h3 className={styles.tabHeading}>Behaviour</h3>
							)}
							<BehaviourTab
								visual={visual}
								definition={definition}
								source={source}
								dimensions={dimensions}
								measures={measures}
								groups={groups}
								updateConfig={updateConfig}
							/>
						</div>
					)}
					{(query || tab === "style") && (
						<div data-search-tab>
							{query && (
								<h3 className={styles.tabHeading}>Style</h3>
							)}
							<FormatTab
								visual={visual}
								definition={definition}
								source={source}
								dimensions={dimensions}
								measures={measures}
								groups={groups}
								style={style}
								updateStyle={updateStyle}
								updateConfig={updateConfig}
							/>
						</div>
					)}
				</SectionGroup>
				{query && noMatch && (
					<p className={styles.noMatch}>
						No setting on this visual mentions &quot;{query}&quot;.
					</p>
				)}
			</div>

			{/* At the top of the page rather than inside the panel, which
			    floats in a layer of its own that the header would sit over. */}
			{picking &&
				createPortal(
					<VisualPicker
						open={picking}
						mode="change"
						current={visual.visualType}
						fields={{
							dimensions: dimensions.length,
							measures: measures.length,
						}}
						onPick={(next) => {
							setPicking(false);
							if (next === visual.visualType) return;
							const result = changeType(next);
							setTrimmed(
								result.droppedDimensions ||
									result.droppedMeasures
									? {
											dimensions:
												result.droppedDimensions,
											measures: result.droppedMeasures,
										}
									: null,
							);
						}}
						onClose={() => setPicking(false)}
					/>,
					document.body,
				)}
		</div>
	);
}

// Which tab each declared option belongs on, by what it changes: what the
// visual shows, what a reader can do with it, or how it looks. Anything not
// listed is about how it looks.
const optionTab: Record<string, "data" | "behaviour"> = {
	compareTo: "data",
	compareField: "data",
	sparkline: "data",
	groups: "data",
	sortBy: "data",
	topN: "data",
	topBy: "data",
	nulls: "data",
	groupTail: "data",
	bins: "data",
	showTotals: "data",
	columnDimension: "data",
	onValue: "data",
	zoomSlider: "behaviour",
	direction: "behaviour",
	defaultValue: "behaviour",
	match: "behaviour",
	multiple: "behaviour",
	defaultValues: "behaviour",
	defaultPreset: "behaviour",
	defaultOn: "behaviour",
	presentation: "behaviour",
	openLabel: "behaviour",
};

function tabOf(key: string): "data" | "behaviour" | "style" {
	return optionTab[key] ?? "style";
}

// What the visual shows. Its fields first, since choosing them is the job,
// then what narrows, ranks and compares them, then figures worked out from the
// answer.
function DataTab({
	visual,
	definition,
	source,
	dimensions,
	measures,
	groups,
	fieldSearch,
	setFieldSearch,
	updateConfig,
	onFieldsChanged,
}: {
	visual: EditableVisual;
	definition: VisualTypeDefinition;
	source: SourceMeta | undefined;
	dimensions: string[];
	measures: string[];
	groups: GroupChoice[];
	fieldSearch: string;
	setFieldSearch: (v: string) => void;
	updateConfig: (patch: Record<string, unknown>) => void;
	// The note about fields a type change took off is stale once the author
	// changes the fields themselves.
	onFieldsChanged: () => void;
}) {
	const toggle = (name: string, kind: "dimensions" | "measures") => {
		onFieldsChanged();
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
		onFieldsChanged();
		const [moved] = current.splice(from, 1);
		current.splice(to, 0, moved);
		updateConfig({ [kind]: current });
	};

	const showMeasures = definition.encoding.measures.max > 0;
	const showDimensions = definition.encoding.dimensions.max > 0;

	return (
		<>
			{/* One list rather than four.

			    It used to be a chosen list per kind above an available list per
			    kind, which asked an author to hold four places at once and put
			    measures above dimensions in the panel while the table renders
			    dimensions first. One list, chosen at the top in the order the
			    visual uses them, is the same information in the order it
			    actually comes out in. */}
			{(showDimensions || showMeasures) && (
				<Section
					id="visual-fields"
					title="Fields"
					keywords="dimension measure column series"
					count={dimensions.length + measures.length}
					defaultOpen
				>
					<FieldList
						source={source}
						dimensions={dimensions}
						measures={measures}
						encoding={definition.encoding}
						showDimensions={showDimensions}
						showMeasures={showMeasures}
						search={fieldSearch}
						onSearch={setFieldSearch}
						onToggle={toggle}
						onMove={reorder}
					/>
				</Section>
			)}

			<VisualOptions
				id="visual-shaping"
				title="Ranking and comparison"
				keywords="filter limit sort order top rank compare total period"
				tab="data"
				visual={visual}
				definition={definition}
				source={source}
				dimensions={dimensions}
				measures={measures}
				groups={groups}
				updateConfig={updateConfig}
			/>

			{/* Only where the answer is a set of rows to work across. A
			    scorecard is one row, so a running total or a rank over it
			    would be a column of one. */}
			{(chartTypes.has(visual.visualType) ||
				gridTypes.has(visual.visualType)) && (
				<DerivedFigures
					transforms={
						(visual.config.transforms as QueryTransform[]) ?? []
					}
					available={[...dimensions, ...measures]}
					onChange={(next) => updateConfig({ transforms: next })}
				/>
			)}
		</>
	);
}

// What a reader can do with the visual, and where it sits. What a click does,
// the controls a type offers readers, the note shown under its title, and the
// group holding it.
function BehaviourTab({
	visual,
	definition,
	source,
	dimensions,
	measures,
	groups,
	updateConfig,
}: {
	visual: EditableVisual;
	definition: VisualTypeDefinition;
	source: SourceMeta | undefined;
	dimensions: string[];
	measures: string[];
	groups: GroupChoice[];
	updateConfig: (patch: Record<string, unknown>) => void;
}) {
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

	// A drill hierarchy turns a click into a descent rather than a
	// cross-filter, so it is only offered where that makes sense.
	const canDrill = definition.category !== "filter" && dimensions.length > 1;
	const drilling = Boolean(visual.config.options?.drillFields);
	const hasReaderControls = (definition.options ?? []).some(
		(option) => tabOf(option.key) === "behaviour",
	);

	return (
		<>
			{canDrill && (
				<Section
					id="visual-drill"
					title="Clicking"
					keywords="drill hierarchy cross filter click descend"
					count={drilling ? 1 : 0}
					defaultOpen
				>
					<button
						type="button"
						className={styles.checkRow}
						onClick={() =>
							updateConfig({
								options: {
									...visual.config.options,
									drillFields: drilling
										? undefined
										: dimensions,
								},
							})
						}
					>
						<Check on={drilling} />
						Drill down through the dimensions
					</button>
					<Hint>
						{drilling
							? "Clicking descends the dimensions in the order they are listed under Fields."
							: "Clicking filters the rest of the page to what was clicked. Turn this on to descend the dimensions instead, in the order they are listed under Fields."}
					</Hint>
				</Section>
			)}

			<VisualOptions
				id="visual-interaction"
				title="Reader controls"
				keywords="zoom default open filter"
				tab="behaviour"
				visual={visual}
				definition={definition}
				source={source}
				dimensions={dimensions}
				measures={measures}
				groups={groups}
				updateConfig={updateConfig}
			/>

			{showNote && (
				<Section
					id="visual-note"
					title={isNotice ? "Message" : "Note"}
					keywords="caveat caption subtitle"
					count={noteValue ? 1 : 0}
					defaultOpen
				>
					<textarea
						id="visual-note"
						className={styles.input}
						rows={2}
						aria-label={isNotice ? "Message" : "Note"}
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
				</Section>
			)}

			{/* Which group holds this, for the times dragging it there is not
			    the easy gesture. A visual already inside a group has nowhere on
			    the canvas to be dragged out to. */}
			{groupChoices.length > 0 && (
				<Section
					id="visual-group"
					title="Group"
					keywords="container inside parent"
					count={parentId ? 1 : 0}
					defaultOpen={false}
				>
					<Select
						id="visual-group"
						value={parentId ?? ""}
						onChange={(next) =>
							updateConfig({ parentId: next || undefined })
						}
						ariaLabel="Inside group"
						options={[
							{ value: "", label: "Not in a group" },
							...groupChoices.map((choice) => ({
								value: choice.visualId,
								label: choice.label,
							})),
						]}
					/>
					<Hint>
						Dragging a visual onto a group puts it inside. This is
						how it comes back out.
					</Hint>
				</Section>
			)}

			{!canDrill &&
				!hasReaderControls &&
				!showNote &&
				groupChoices.length === 0 && (
					<p className={styles.hint}>
						Nothing about how readers use this kind of visual can be
						changed.
					</p>
				)}
		</>
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
	id,
	title,
	keywords,
	tab,
	visual,
	definition,
	source,
	dimensions,
	measures,
	groups,
	updateConfig,
}: {
	id: string;
	title: string;
	keywords?: string;
	// Only the options that belong on this tab. See optionTab.
	tab: "data" | "behaviour" | "style";
	visual: EditableVisual;
	definition: VisualTypeDefinition;
	// Needed by any option whose choices come from the source rather than from
	// what the visual already encodes.
	source: SourceMeta | undefined;
	dimensions: string[];
	measures: string[];
	groups: GroupChoice[];
	updateConfig: (patch: Record<string, unknown>) => void;
}) {
	const declared = (definition.options ?? []).filter(
		(option) => tabOf(option.key) === tab,
	);
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
		<Section id={id} title={title} keywords={keywords} count={chosen}>
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

				// Where the choices come from, and what they are narrowed to.
				//
				// Encoded by default, which is right for a setting about
				// something already on the visual. A setting about the page
				// asks the source instead: a scorecard encodes no dimensions,
				// so an encoded list would be empty and the setting could
				// never be given a value.
				const fromSource = option.from === "source";
				const pool: string[] = fromSource
					? (
							(option.scope === "measure"
								? source?.measures
								: source?.dimensions) ?? []
						).map((f) => f.name)
					: option.scope === "measure"
						? measures
						: dimensions;

				const choices =
					option.role === "temporal" && fromSource
						? pool.filter((name) => isTemporalField(source, name))
						: pool;
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
						{choices.length === 0 && (
							<Hint>
								This source has no field of that kind, so there
								is nothing to choose.
							</Hint>
						)}
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
	source,
	dimensions,
	measures,
	groups,
	style,
	updateStyle,
	updateConfig,
}: {
	visual: EditableVisual;
	definition: VisualTypeDefinition;
	// Passed through to the option controls, for any whose choices come from
	// the source rather than from what the visual encodes.
	source: SourceMeta | undefined;
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
	// A type that declares fill height as an option already shows it under
	// Display, so Appearance does not offer it a second time.
	const fillHeightHere =
		supports.fillHeight &&
		!(definition.options ?? []).some((o) => o.key === "fillHeight");
	const appearanceCount = [
		style.cornerRadius !== undefined,
		style.stripedRows !== undefined,
		style.loadingAnimation !== undefined,
		fillHeightHere && visual.config.options?.fillHeight !== undefined,
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
				id="visual-display"
				title="Display"
				keywords="labels density height border weight presentation"
				tab="style"
				visual={visual}
				definition={definition}
				source={source}
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

					{/* A named set for the whole chart, above the per-series
					    colour. Choosing a set is the decision an author
					    actually makes; the swatch below is for the one series
					    that has to be different from the rest. */}
					{measures.length > 1 && (
						<div className={styles.field}>
							<span className={styles.fieldLabel}>
								Series colours
							</span>
							<div className={styles.swatchGrid}>
								{palettePresets.map((preset) => {
									const on =
										JSON.stringify(style.palette ?? []) ===
										JSON.stringify(preset.tokens);
									const stops = preset.tokens
										.map(
											(token, i) =>
												`var(--${token}) ${(i / preset.tokens.length) * 100}%, var(--${token}) ${((i + 1) / preset.tokens.length) * 100}%`,
										)
										.join(", ");
									return (
										<button
											key={preset.id}
											type="button"
											className={styles.markerButton}
											aria-pressed={on}
											aria-label={preset.label}
											title={preset.note ?? preset.label}
											onClick={() =>
												updateStyle({
													palette: preset.tokens,
												})
											}
											style={{
												background: `linear-gradient(90deg, ${stops})`,
												outline: on
													? "2px solid var(--brand)"
													: undefined,
											}}
										/>
									);
								})}
							</div>
							<Hint>
								{palettePresets.find(
									(preset) =>
										JSON.stringify(style.palette ?? []) ===
										JSON.stringify(preset.tokens),
								)?.note ??
									"Colours are taken by series position, so a chart keeps its colours as measures are added."}
							</Hint>
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
				{fillHeightHere && (
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

			{supports.referenceLines && (
				<ReferenceLinesEditor
					style={style}
					measures={measures}
					// The second scale only exists once a series has been put
					// on it, so asking which one a line reads against before
					// then is a question with one answer.
					hasRightAxis={Boolean(
						supports.secondAxis &&
						(style.series ?? []).some(
							(entry) => entry.axis === "right",
						),
					)}
					onChange={updateStyle}
				/>
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

// What a type change had to take off, said as a sentence rather than as two
// counts. Only ever called with at least one of them above zero.
function describeTrim(trimmed: {
	dimensions: number;
	measures: number;
}): string {
	const parts: string[] = [];
	if (trimmed.dimensions > 0) {
		parts.push(
			trimmed.dimensions === 1
				? "1 dimension"
				: `${trimmed.dimensions} dimensions`,
		);
	}
	if (trimmed.measures > 0) {
		parts.push(
			trimmed.measures === 1
				? "1 measure"
				: `${trimmed.measures} measures`,
		);
	}
	return `This type takes fewer fields, so ${parts.join(" and ")} came off.`;
}
