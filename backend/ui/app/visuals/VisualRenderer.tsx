"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { Chart } from "./chartEntry";
import { DataGrid } from "./DataGrid";
import { MatrixTable } from "./MatrixTable";
import { TextPanel } from "./TextPanel";
import { KpiRow } from "./KpiRow";
import { SmallMultiples } from "./SmallMultiples";
import { RecordPanel } from "./RecordPanel";
import {
	BulkFilter,
	DateRangeFilter,
	DimensionSwitch,
	DropdownFilter,
	FilterGroup,
	NumericRangeFilter,
	PresenceFilter,
	SearchFilter,
	ToggleFilter,
	ThresholdFilter,
} from "./FilterWidgets";
import { usePageFilters } from "./PageFilters";
import { VisualFrame, VisualNotice } from "./VisualFrame";
import { ChartActions } from "./ChartActions";
import { NotesAction, VisualNotes, usePageNotes } from "./VisualNotes";
import { ErrorBoundary } from "../components/shared/ErrorBoundary";
import { fieldMap, type SourceMeta } from "./types";
import type { KpiGroup } from "../../lib/visuals/kpiGroups";
import {
	isFilterVisual,
	optionValue,
	visualByType,
} from "../../lib/visuals/catalog";
import { chartTypes, gridTypes, recordTypes } from "../../lib/query/visualSpec";
import {
	shiftDateFilters,
	type ComparePeriod,
	type DateClause,
} from "../../lib/query/compare";
import type { QueryTransform } from "../../lib/query/transform";
import type { VisualStyle } from "../../lib/visuals/style";
import styles from "./Visual.module.css";

// Maps a stored visual definition to a component.
//
// Visual type is data, not code: a report row names a type and this decides
// what to render. An unknown type degrades to a readable notice rather than
// breaking the page, which matters because the type list grows in the database
// while a given deployment may be running older code.

export interface VisualConfig {
	slot?: string;
	// The group this visual lives inside, if any.
	//
	// Held on the child rather than as a list on the group, so putting something
	// into a group is one write to one visual and the existing update operation
	// carries it. A child's layout rectangle is relative to the group's content
	// box, which is what lets a group move without touching anything it holds.
	parentId?: string;
	dimensions?: string[];
	measures?: string[];
	filters?: unknown[];
	sort?: { field: string; direction: "asc" | "desc" }[];
	// Figures worked out from the answer rather than asked of the warehouse.
	// Stored beside the encoding, since they are part of what the visual asks
	// for rather than part of how it looks.
	transforms?: QueryTransform[];
	options?: Record<string, unknown>;
	// Colours, fills, conditional formatting and tooltip behaviour. Stored in
	// the same JSONB column as the encoding, so a new option needs no
	// migration and an older deployment ignores what it does not know.
	style?: VisualStyle;
}

export interface VisualSpec {
	visualId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: VisualConfig;
}

interface VisualRendererProps {
	visual: VisualSpec;
	sources: Record<string, SourceMeta>;
	// Filters applied to the whole page, merged ahead of the visual's own.
	pageFilters?: unknown[];
	// Recorded against exports taken from this visual.
	reportId?: string | null;
	pageId?: string | null;
	// The height of the cell the page laid this visual out in. The frame fills
	// it, and anything inside that sizes to a number rather than to its box,
	// such as a chart canvas, is told the same figure.
	frameHeight?: number;
	// A reader's own column arrangement for a grid, held by the page so a
	// saved view can carry it.
	columnOrder?: string[];
	pinnedColumns?: string[];
	columnWidths?: Record<string, number>;
	onColumnLayout?: (next: {
		columnOrder: string[];
		pinnedColumns: string[];
		columnWidths: Record<string, number>;
	}) => void;
}

// The title a visual shows, or nothing.
//
// Straight through. There used to be a translation here: reports were seeded
// with slot keys as titles, so a visual stored as "table" rendered as "Detail",
// and seventy one of the eighty nine visuals on the platform went through it.
//
// That made the editor lie. The properties panel showed the stored key and the
// page showed the translation, so an author who renamed a visual to one of the
// twelve magic words watched their title be silently replaced, with nothing
// anywhere explaining why. The stored titles have been migrated to the words
// readers were already seeing, so there is nothing left to translate.

function displayTitle(visual: VisualSpec): string | null {
	return visual.title || null;
}

// One visual's failure stays inside that visual.
//
// A page is a grid of independent definitions and any one of them can carry a
// config the renderer does not survive: a field the source stopped defining, an
// option of the wrong shape, a stale type. Without this the whole report goes
// blank and nothing says which tile caused it.
//
// Keyed on the visual id, so editing a broken visual into a working one clears
// the error without a reload.
export function VisualRenderer(props: VisualRendererProps) {
	return (
		<ErrorBoundary
			label={displayTitle(props.visual) ?? "This visual"}
			resetKey={`${props.visual.visualId}:${props.visual.visualType}`}
			inline
		>
			<VisualBody {...props} />
		</ErrorBoundary>
	);
}

function VisualBody({
	visual,
	sources,
	reportId,
	pageId,
	frameHeight,
	columnOrder,
	pinnedColumns,
	columnWidths,
	onColumnLayout,
}: VisualRendererProps) {
	// Every data visual reads the page state, which is what makes a filter
	// widget, a cross-filter selection and a drill position all affect the
	// page together.
	const {
		clausesFor,
		crossFilter,
		setCrossFilter,
		selectedDimension,
		selectedGrain,
		drillByVisual,
		drillDown,
	} = usePageFilters();

	// Whether the figures behind a chart are open, and a way to read the chart
	// back as a picture. Held here rather than inside the chart, because the
	// controls for both sit in the frame around it.
	const [showingTable, setShowingTable] = useState(false);
	const [showingNotes, setShowingNotes] = useState(false);
	// Where the chart leaves a way of reading itself back as a picture.
	//
	// A ref rather than state. The getter reads the chart instance when it is
	// called and depends on nothing else, so holding it in state made every
	// redraw a state update, and the render that followed rebuilt the option
	// the publishing effect was keyed on. The two chased each other until
	// React stopped them.
	const chartImageRef = useRef<(() => string | null) | null>(null);
	const getChartImage = useCallback(
		() => chartImageRef.current?.() ?? null,
		[],
	);

	// Derived figures the author declared. Read straight off the config rather
	// than through the catalogue, because they are a list an author builds
	// rather than a setting with a fallback.
	// Every note on the page, fetched once and shared. A visual picks out
	// its own rather than asking for them, so a page of eight visuals costs
	// one request instead of eight.
	const { notes: pageNotes, refresh: refreshNotes } = usePageNotes(
		reportId ?? null,
		pageId ?? null,
	);
	const notes = pageNotes.filter((n) => n.visualId === visual.visualId);

	const transforms = Array.isArray(visual.config.transforms)
		? (visual.config.transforms as QueryTransform[])
		: undefined;

	const sourceKey = visual.sourceKey;
	const source = sourceKey ? sources[sourceKey] : undefined;
	// Memoised because it is handed to chart and grid components as a prop.
	// A fresh Map on every render made every one of them treat their whole
	// configuration as changed, which for a chart meant tearing down and
	// rebuilding the canvas on every keystroke anywhere on the page.
	const fields = useMemo(() => fieldMap(source), [source]);

	// "<selected>" means "whatever the page's breakdown switcher is set to",
	// and "<grain>" means the same for its time grain. Both resolve here,
	// before a query is built, so the query layer only ever sees real field
	// names. A page with no switcher drops the placeholder rather than asking
	// the warehouse for a field that does not exist.
	const rawDimensions = visual.config.dimensions ?? [];
	const resolvedDimensions = rawDimensions
		.map((d) =>
			d === "<selected>"
				? selectedDimension
				: d === "<grain>"
					? selectedGrain
					: d,
		)
		.filter((d): d is string => Boolean(d));
	const rawMeasures = visual.config.measures ?? [];

	// A field the source does not define is dropped rather than sent to the
	// warehouse, and the visual says how many it lost.
	//
	// Reports and the semantic layer drift: a view is republished without a
	// measure, or a report is authored against a name that was never built.
	// Failing the whole visual on one stale field would take down a page over
	// a column nobody was reading, so the rest renders and the gap is stated.
	const knownDimensions = new Set(
		source?.dimensions.map((f) => f.name) ?? [],
	);
	const knownMeasures = new Set(source?.measures.map((f) => f.name) ?? []);

	const dimensionList = source
		? resolvedDimensions.filter((d) => knownDimensions.has(d))
		: resolvedDimensions;
	const measureList = source
		? rawMeasures.filter((m) => knownMeasures.has(m))
		: rawMeasures;

	// Held stable by content rather than by identity. These are dependencies of
	// the chart's option memo, and a new array every render meant the option
	// was rebuilt every render: any state change on the page wiped a selection
	// the reader was in the middle of drawing.
	const dimensionKey = dimensionList.join("\u0000");
	const measureKey = measureList.join("\u0000");
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const dimensions = useMemo(() => dimensionList, [dimensionKey]);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const measures = useMemo(() => measureList, [measureKey]);

	const missingFields = source
		? [
				...resolvedDimensions.filter((d) => !knownDimensions.has(d)),
				...rawMeasures.filter((m) => !knownMeasures.has(m)),
			]
		: [];
	const style = visual.config.style;
	const authorNote =
		typeof visual.config.options?.note === "string"
			? visual.config.options.note
			: null;

	const fieldNote =
		missingFields.length > 0
			? `${missingFields.length === 1 ? "One field is" : `${missingFields.length} fields are`} no longer available on this source: ${missingFields.join(", ")}`
			: null;

	const note = authorNote;

	// Page state comes first so a visual's own filters can narrow further but
	// never widen past what the reader selected.
	const filters = [
		...clausesFor(visual.visualId),
		...((visual.config.filters ?? []) as unknown[]),
	];

	// What a comparison would be asked against, and whether it can be asked at
	// all.
	//
	// The field falls back to the source's own default time field, so choosing
	// "the same window a year earlier" is one decision rather than two. The
	// second setting is for a source carrying several dates, not a hoop to get
	// through.
	const comparePeriod =
		(optionValue<string>(visual.visualType, visual.config, "compareTo") as
			| ComparePeriod
			| undefined) || null;
	const compareField =
		optionValue<string>(visual.visualType, visual.config, "compareField") ||
		source?.defaultTimeField ||
		null;

	// A comparison moves the page's date window back, so with no window on the
	// page there is nothing to move and nothing to draw.
	//
	// Said rather than left blank. Without this an author changes the setting,
	// nothing happens, and there is nothing anywhere to suggest why: every
	// figure on the page is still correct, so it reads as the setting being
	// broken rather than as the page missing a filter.
	const compareNote =
		comparePeriod &&
		!(
			compareField &&
			shiftDateFilters(
				filters as DateClause[],
				compareField,
				comparePeriod,
			)
		)
			? compareField
				? `Nothing to compare against yet. This moves the page's date range back, so the page needs a date filter on ${compareField}.`
				: "Nothing to compare against yet. This source has no date field for a comparison to move."
			: null;

	// Both are caveats about the same visual, and the frame has one place to
	// put them.
	const driftNote =
		[fieldNote, compareNote].filter(Boolean).join(" ") || null;

	// A drill hierarchy replaces the visual's dimension with whichever level
	// the reader has descended to, so clicking a bar moves down the hierarchy
	// rather than adding another field to the same chart.
	const drillFields = Array.isArray(visual.config.options?.drillFields)
		? (visual.config.options.drillFields as string[])
		: [];
	const drillPath = drillByVisual[visual.visualId] ?? [];
	const drillDepth = Math.min(
		drillPath.length,
		Math.max(drillFields.length - 1, 0),
	);
	const canDrill = drillFields.length > 1;

	if (visual.visualType === "textPanel") {
		// Rich text, sanitised on render. The stored value is whatever the
		// author last published; formatting lives in the markup rather than in
		// a separate style object.
		const content =
			typeof visual.config.options?.html === "string"
				? visual.config.options.html
				: (note ?? "");
		return (
			<VisualFrame title={displayTitle(visual)}>
				<TextPanel html={content} />
			</VisualFrame>
		);
	}

	if (visual.visualType === "sectionHeader") {
		// No frame and no query. A heading is page structure, so it renders as
		// the heading it is rather than as a panel containing one.
		const minor =
			optionValue<string>(visual.visualType, visual.config, "level") ===
			"minor";
		return (
			<div
				className={`${styles.sectionHeader} ${
					minor ? styles.sectionHeaderMinor : ""
				} ${
					optionValue<boolean>(
						visual.visualType,
						visual.config,
						"rule",
					) === false
						? ""
						: styles.sectionHeaderRule
				}`}
			>
				<span>{visual.title ?? "Section"}</span>
				{note && (
					<span className={styles.sectionHeaderNote}>{note}</span>
				)}
			</div>
		);
	}

	if (visual.visualType === "blockedNotice") {
		return (
			<VisualFrame title={displayTitle(visual)}>
				<div className={styles.state}>
					{note ?? "This page is not available yet"}
				</div>
			</VisualFrame>
		);
	}

	if (
		visual.visualType === "dimensionSwitch" ||
		visual.visualType === "periodSwitch"
	) {
		return (
			<DimensionSwitch
				visualId={visual.visualId}
				sourceKey={sourceKey ?? ""}
				options={rawDimensions}
				label={displayTitle(visual)}
				scope={
					visual.visualType === "periodSwitch" ? "grain" : "breakdown"
				}
			/>
		);
	}

	if (!sourceKey || !source) {
		return (
			<VisualFrame title={displayTitle(visual)}>
				<div className={styles.state}>
					{sourceKey
						? `Source "${sourceKey}" is not registered yet`
						: "No source configured"}
				</div>
			</VisualFrame>
		);
	}

	// Filter widgets render bare, without a frame: they belong to the page
	// chrome rather than being a panel of their own.
	if (isFilterVisual(visual.visualType)) {
		// A threshold tests a measure, so a control with no dimension is
		// still valid. Only a control with nothing at all to act on is
		// dropped.
		const field = dimensions[0] ?? measures[0];
		if (!field) return null;

		switch (visual.visualType) {
			case "dropdownFilter":
				return (
					<DropdownFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						field={field}
						label={visual.title}
						multiple={
							optionValue<boolean>(
								visual.visualType,
								visual.config,
								"multiple",
							) !== false
						}
						segmented={
							optionValue<string>(
								visual.visualType,
								visual.config,
								"presentation",
							) === "segmented"
						}
						exclude={
							optionValue<string>(
								visual.visualType,
								visual.config,
								"match",
							) === "exclude"
						}
					/>
				);
			case "presenceFilter":
				return (
					<PresenceFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						field={field}
						label={visual.title}
					/>
				);
			case "toggleFilter":
				return (
					<ToggleFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						field={field}
						label={visual.title}
						onValue={optionValue<string>(
							visual.visualType,
							visual.config,
							"onValue",
						)}
					/>
				);
			case "searchFilter":
				return (
					<SearchFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						fields={dimensions}
						label={visual.title}
						placeholder={optionValue<string>(
							visual.visualType,
							visual.config,
							"placeholder",
						)}
					/>
				);
			case "bulkFilter":
				return (
					<BulkFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						field={field}
						label={visual.title}
					/>
				);
			case "dateRangeFilter":
				return (
					<DateRangeFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						field={field}
						label={visual.title}
						mode={optionValue<
							"presets" | "calendar" | "slider" | "combined"
						>(visual.visualType, visual.config, "rangeMode")}
						defaultPreset={optionValue<string>(
							visual.visualType,
							visual.config,
							"defaultPreset",
						)}
					/>
				);
			case "numericRangeFilter":
				return (
					<NumericRangeFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						field={measures[0] ?? field}
						label={visual.title}
						mode={optionValue<"inputs" | "slider" | "combined">(
							visual.visualType,
							visual.config,
							"rangeMode",
						)}
					/>
				);
			case "filterBar":
				return (
					<FilterGroup
						visualId={visual.visualId}
						sourceKey={sourceKey}
						fields={dimensions}
					/>
				);
			case "thresholdControl":
				return (
					<ThresholdFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						field={measures[0] ?? field}
						label={visual.title}
						direction={
							optionValue<string>(
								visual.visualType,
								visual.config,
								"direction",
							) === "below"
								? "below"
								: "above"
						}
						defaultValue={
							optionValue<number>(
								visual.visualType,
								visual.config,
								"defaultValue",
							) ?? null
						}
					/>
				);
			default:
				return null;
		}
	}

	if (visual.visualType === "kpiRow") {
		return (
			<KpiRow
				sourceKey={sourceKey}
				measures={measures}
				filters={filters}
				fields={fields}
				style={style}
				groups={optionValue<KpiGroup[]>(
					visual.visualType,
					visual.config,
					"groups",
				)}
				compareTo={comparePeriod}
				compareField={compareField}
				sparkline={
					optionValue<string>(
						visual.visualType,
						visual.config,
						"sparkline",
					) ?? null
				}
			/>
		);
	}

	if (visual.visualType === "smallMultiples") {
		return (
			<VisualFrame
				visualId={visual.visualId}
				actions={
					<NotesAction
						count={notes.length}
						onOpen={() => setShowingNotes(true)}
						available={Boolean(reportId && pageId)}
					/>
				}
				title={displayTitle(visual)}
				notice={driftNote}
			>
				{showingNotes && reportId && pageId && (
					<VisualNotes
						reportId={reportId}
						pageId={pageId}
						visualId={visual.visualId}
						notes={notes}
						onChanged={refreshNotes}
						onClose={() => setShowingNotes(false)}
					/>
				)}
				{note && <VisualNotice>{note}</VisualNotice>}
				<SmallMultiples
					sourceKey={sourceKey}
					dimensions={dimensions}
					measures={measures}
					filters={filters}
					fields={fields}
					style={style}
					options={visual.config.options}
					height={frameHeight}
				/>
			</VisualFrame>
		);
	}

	if (visual.visualType === "matrixTable") {
		// The last dimension is the pivot when the author marked one, so the
		// same field list expresses both a plain hierarchy and a cross-tab.
		const pivot =
			optionValue<string>(
				visual.visualType,
				visual.config,
				"columnDimension",
			) ?? null;
		const rowDimensions = pivot
			? dimensions.filter((d) => d !== pivot)
			: dimensions;

		return (
			<VisualFrame
				visualId={visual.visualId}
				actions={
					<NotesAction
						count={notes.length}
						onOpen={() => setShowingNotes(true)}
						available={Boolean(reportId && pageId)}
					/>
				}
				title={displayTitle(visual)}
				flush
				notice={driftNote}
			>
				{showingNotes && reportId && pageId && (
					<VisualNotes
						reportId={reportId}
						pageId={pageId}
						visualId={visual.visualId}
						notes={notes}
						onChanged={refreshNotes}
						onClose={() => setShowingNotes(false)}
					/>
				)}
				{note && <VisualNotice>{note}</VisualNotice>}
				<MatrixTable
					sourceKey={sourceKey}
					rowDimensions={rowDimensions}
					columnDimension={pivot}
					measures={measures}
					baseFilters={filters}
					fields={fields}
					style={style}
				/>
			</VisualFrame>
		);
	}

	if (chartTypes.has(visual.visualType)) {
		const definition = visualByType[visual.visualType];

		// When a drill hierarchy is configured, the chart shows the level the
		// reader is currently at rather than the field the author picked.
		const activeDimensions = canDrill
			? [drillFields[drillDepth] ?? drillFields[0]]
			: dimensions;

		// Clicking means drill when there is somewhere to go, and cross-filter
		// otherwise. One gesture, and which it means depends on how the visual
		// was configured rather than on a mode the reader has to remember.
		const handleSelect = (selection: { field: string; value: string }) => {
			if (canDrill && drillDepth < drillFields.length - 1) {
				drillDown(visual.visualId, selection);
				return;
			}
			setCrossFilter({
				sourceVisualId: visual.visualId,
				clauses: [
					{
						field: selection.field,
						op: "eq",
						values: [selection.value],
					},
				],
				label: `${selection.field}: ${selection.value}`,
			});
		};

		// The cell decides, since the author sized it. The catalogue default is
		// only the fallback for a page with no arrangement at all.
		const chartHeight =
			frameHeight ?? (definition ? definition.defaultLayout.h * 52 : 300);

		return (
			<VisualFrame
				visualId={visual.visualId}
				actions={
					<>
						<NotesAction
							count={notes.length}
							onOpen={() => setShowingNotes(true)}
							available={Boolean(reportId && pageId)}
						/>
						<ChartActions
							getImage={getChartImage}
							onShowTable={() => setShowingTable(true)}
						/>
					</>
				}
				title={displayTitle(visual)}
				notice={driftNote}
				onZoomOut={
					crossFilter?.sourceVisualId === visual.visualId &&
					crossFilter.zoomSource
						? () => setCrossFilter(null)
						: null
				}
				drill={
					canDrill
						? {
								fields: drillFields,
								depth: drillDepth,
								path: drillPath,
								visualId: visual.visualId,
							}
						: undefined
				}
			>
				{note && <VisualNotice>{note}</VisualNotice>}
				<Chart
					visualType={visual.visualType}
					sourceKey={sourceKey}
					options={visual.config.options}
					dimensions={activeDimensions}
					measures={measures}
					filters={filters}
					fields={fields}
					transforms={transforms}
					compareTo={comparePeriod}
					compareField={compareField}
					style={style}
					// Inside a laid-out page the frame already has a height and
					// the chart fills what is left after the title, which is
					// the only way the two cannot disagree. Off the grid it
					// takes a figure, since a canvas has no box to fill.
					height={frameHeight ? "100%" : chartHeight}
					onSelect={handleSelect}
					onSelectRange={(field, values) => {
						// An empty range is the reader clearing the brush, so
						// the page filter goes with it.
						if (values.length === 0) {
							setCrossFilter(null);
							return;
						}
						setCrossFilter({
							sourceVisualId: visual.visualId,
							clauses: [{ field, op: "eq", values }],
							label:
								values.length === 1
									? `${field}: ${values[0]}`
									: `${field}: ${values.length} selected`,
							// A range was drawn across this chart, so it
							// narrows to it rather than staying zoomed out
							// while everything else moves.
							zoomSource: true,
						});
					}}
					selectedValues={
						crossFilter?.sourceVisualId === visual.visualId
							? ((crossFilter.clauses[0] as { values?: string[] })
									?.values ?? [])
							: []
					}
					imageRef={chartImageRef}
					title={displayTitle(visual)}
				/>

				{/* The chart's own query, drawn as a table.
				    
				    This is the answer to "can I see the numbers", and it is
				    exactly the numbers the chart drew rather than a second
				    query that might disagree with it. Whatever the reader has
				    filtered or brushed is already in those filters, so
				    clicking a bar and then opening this shows what that bar is
				    made of. */}
				{showingNotes && reportId && pageId && (
					<VisualNotes
						reportId={reportId}
						pageId={pageId}
						visualId={visual.visualId}
						notes={notes}
						onChanged={refreshNotes}
						onClose={() => setShowingNotes(false)}
					/>
				)}

				{showingTable && (
					<div
						className={styles.tableOverlay}
						role="dialog"
						aria-modal="true"
						aria-label={`Figures behind ${displayTitle(visual) ?? "this chart"}`}
						onPointerDown={(e) => {
							if (e.target === e.currentTarget) {
								setShowingTable(false);
							}
						}}
					>
						<div className={styles.tableOverlayBox}>
							<div className={styles.tableOverlayHead}>
								<span className={styles.title}>
									{displayTitle(visual) ?? "Figures"}
								</span>
								<span
									className={styles.headerSpacer}
									aria-hidden="true"
								/>
								<button
									type="button"
									className={styles.frameAction}
									onClick={() => setShowingTable(false)}
									title="Close"
									aria-label="Close"
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										aria-hidden="true"
									>
										<path d="M18 6 6 18M6 6l12 12" />
									</svg>
								</button>
							</div>
							<DataGrid
								sourceKey={sourceKey}
								dimensions={activeDimensions}
								measures={measures}
								baseFilters={filters}
								fields={fields}
								height="100%"
								pageSize={200}
								reportId={reportId}
								pageId={pageId}
								visualId={visual.visualId}
								style={style}
							/>
						</div>
					</div>
				)}
			</VisualFrame>
		);
	}

	if (recordTypes.has(visual.visualType)) {
		const isHeader = visual.visualType === "entityHeader";
		return (
			<VisualFrame
				visualId={visual.visualId}
				title={isHeader ? null : displayTitle(visual)}
				notice={driftNote}
			>
				{note && <VisualNotice>{note}</VisualNotice>}
				<RecordPanel
					sourceKey={sourceKey}
					visualType={visual.visualType}
					dimensions={dimensions}
					measures={measures}
					filters={filters}
					fields={fields}
					layout={isHeader ? "header" : "list"}
					style={style}
				/>
			</VisualFrame>
		);
	}

	if (gridTypes.has(visual.visualType)) {
		const compact = visual.visualType !== "table";
		const gridHeight = frameHeight ?? (compact ? 220 : 520);
		return (
			<VisualFrame
				visualId={visual.visualId}
				actions={
					<NotesAction
						count={notes.length}
						onOpen={() => setShowingNotes(true)}
						available={Boolean(reportId && pageId)}
					/>
				}
				title={displayTitle(visual)}
				flush
				notice={driftNote}
			>
				{showingNotes && reportId && pageId && (
					<VisualNotes
						reportId={reportId}
						pageId={pageId}
						visualId={visual.visualId}
						notes={notes}
						onChanged={refreshNotes}
						onClose={() => setShowingNotes(false)}
					/>
				)}
				{note && <VisualNotice>{note}</VisualNotice>}
				<DataGrid
					sourceKey={sourceKey}
					dimensions={dimensions}
					measures={measures}
					baseFilters={filters}
					transforms={transforms}
					fields={fields}
					height={frameHeight ? "100%" : gridHeight}
					pageSize={compact ? 25 : 200}
					showTotals={
						optionValue<boolean>(
							visual.visualType,
							visual.config,
							"showTotals",
						) === true
					}
					compareTo={comparePeriod}
					compareField={compareField}
					density={
						optionValue<"comfortable" | "compact">(
							visual.visualType,
							visual.config,
							"density",
						) ?? "comfortable"
					}
					reportId={reportId}
					pageId={pageId}
					visualId={visual.visualId}
					style={style}
					columnOrder={columnOrder}
					pinnedColumns={pinnedColumns}
					columnWidths={columnWidths}
					onColumnLayout={onColumnLayout}
				/>
			</VisualFrame>
		);
	}

	return (
		<VisualFrame title={displayTitle(visual)}>
			<div className={styles.state}>
				Visual type &quot;{visual.visualType}&quot; is not supported in
				this version
			</div>
		</VisualFrame>
	);
}
