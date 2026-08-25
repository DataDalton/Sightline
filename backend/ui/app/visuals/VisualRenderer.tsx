"use client";

import { useMemo } from "react";

import { Chart } from "./Chart";
import { DataGrid } from "./DataGrid";
import { MatrixTable } from "./MatrixTable";
import { TextPanel } from "./TextPanel";
import { KpiRow } from "./KpiRow";
import { RecordPanel } from "./RecordPanel";
import {
	BulkFilter,
	DateRangeFilter,
	DimensionSwitch,
	DropdownFilter,
	FilterGroup,
	NumericRangeFilter,
	SearchFilter,
	ThresholdFilter,
} from "./FilterWidgets";
import { usePageFilters } from "./PageFilters";
import { VisualFrame, VisualNotice } from "./VisualFrame";
import { fieldMap, type SourceMeta } from "./types";
import { isFilterVisual, visualByType } from "../../lib/visuals/catalog";
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
	dimensions?: string[];
	measures?: string[];
	filters?: unknown[];
	sort?: { field: string; direction: "asc" | "desc" }[];
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
	onColumnLayout?: (next: {
		columnOrder: string[];
		pinnedColumns: string[];
	}) => void;
}

// A readable heading when the stored title is only a layout slot name.
const slotTitles: Record<string, string> = {
	kpi: "Summary",
	trend: "Trend",
	line: "Trend",
	rank: "Top contributors",
	chart: "Breakdown",
	table: "Detail",
	switch: "Breakdown",
	grain: "Period",
	filters: "Filters",
	threshold: "Threshold",
	header: "Overview",
	note: "Note",
};

function displayTitle(visual: VisualSpec): string | null {
	if (!visual.title) return null;
	return slotTitles[visual.title] ?? visual.title;
}

// Chart types the ECharts renderer handles. Everything else is a grid, a
// filter, or text.
const chartTypes = new Set([
	"lineChart",
	"barChart",
	"areaChart",
	"scatterChart",
	"horizontalBarChart",
	"stackedBarChart",
	"comboChart",
	"pieChart",
	"donutChart",
	"treemapChart",
	"funnelChart",
	"gauge",
	"waterfallChart",
	"heatmapChart",
	"radarChart",
	// Kept so reports authored before the real heatmap landed still render.
	"heatmap",
]);

const gridTypes = new Set(["table"]);

// One record, not a table of many. Both were grids until it became obvious a
// search box and an export button were the wrong furniture for a page about a
// single customer.
const recordTypes = new Set(["definitionList", "entityHeader"]);


export function VisualRenderer({
	visual,
	sources,
	reportId,
	pageId,
	frameHeight,
	columnOrder,
	pinnedColumns,
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

	const sourceKey = visual.sourceKey;
	const source = sourceKey ? sources[sourceKey] : undefined;
	// Memoised because it is handed to chart and grid components as a prop.
	// A fresh Map on every render made every one of them treat their whole
	// configuration as changed, which for a chart meant tearing down and
	// rebuilding the canvas on every keystroke anywhere on the page.
	const fields = useMemo(() => fieldMap(source), [source]);

	// "<selected>" is a placeholder the planning documents used to mean
	// "whatever the page's dimension switcher is set to". It is resolved here,
	// before any query is built, so the query layer only ever sees real field
	// names. A page with no switcher drops it rather than asking the warehouse
	// for a field that does not exist.
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
	const knownDimensions = new Set(source?.dimensions.map((f) => f.name) ?? []);
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

	const driftNote =
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

	// A drill hierarchy replaces the visual's dimension with whichever level
	// the reader has descended to, so clicking a bar moves down the hierarchy
	// rather than adding another field to the same chart.
	const drillFields = Array.isArray(visual.config.options?.drillFields)
		? (visual.config.options.drillFields as string[])
		: [];
	const drillPath = drillByVisual[visual.visualId] ?? [];
	const drillDepth = Math.min(drillPath.length, Math.max(drillFields.length - 1, 0));
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

	if (visual.visualType === "blockedNotice") {
		return (
			<VisualFrame title={displayTitle(visual)}>
				<div className={styles.state}>
					{note ?? "This page is not available yet"}
				</div>
			</VisualFrame>
		);
	}

	if (visual.visualType === "dimensionSwitch" || visual.visualType === "periodSwitch") {
		return (
			<DimensionSwitch
				visualId={visual.visualId}
				sourceKey={sourceKey ?? ""}
				options={rawDimensions}
				label={displayTitle(visual)}
				scope={visual.visualType === "periodSwitch" ? "grain" : "breakdown"}
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
						multiple={visual.config.options?.multiple !== false}
					/>
				);
			case "searchFilter":
				return (
					<SearchFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						fields={dimensions}
						label={visual.title}
						placeholder={
							typeof visual.config.options?.placeholder === "string"
								? visual.config.options.placeholder
								: undefined
						}
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
						mode={
							visual.config.options?.rangeMode as
								| "presets"
								| "calendar"
								| "slider"
								| "combined"
								| undefined
						}
					/>
				);
			case "numericRangeFilter":
				return (
					<NumericRangeFilter
						visualId={visual.visualId}
						sourceKey={sourceKey}
						field={measures[0] ?? field}
						label={visual.title}
						mode={
							visual.config.options?.rangeMode as
								| "inputs"
								| "slider"
								| "combined"
								| undefined
						}
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
							visual.config.options?.direction === "below" ? "below" : "above"
						}
						defaultValue={
							typeof visual.config.options?.defaultValue === "number"
								? visual.config.options.defaultValue
								: null
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
			/>
		);
	}

	if (visual.visualType === "matrixTable") {
		// The last dimension is the pivot when the author marked one, so the
		// same field list expresses both a plain hierarchy and a cross-tab.
		const pivot =
			typeof visual.config.options?.columnDimension === "string"
				? visual.config.options.columnDimension
				: null;
		const rowDimensions = pivot
			? dimensions.filter((d) => d !== pivot)
			: dimensions;

		return (
			<VisualFrame
				title={displayTitle(visual)}
				flush
				notice={driftNote}
			>
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
					{ field: selection.field, op: "eq", values: [selection.value] },
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
				<Chart
					visualType={visual.visualType}
					sourceKey={sourceKey}
					dimensions={activeDimensions}
					measures={measures}
					filters={filters}
					fields={fields}
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
				/>
			</VisualFrame>
		);
	}

	if (recordTypes.has(visual.visualType)) {
		const isHeader = visual.visualType === "entityHeader";
		return (
			<VisualFrame
				title={isHeader ? null : displayTitle(visual)}
				notice={driftNote}
			>
				{note && <VisualNotice>{note}</VisualNotice>}
				<RecordPanel
					sourceKey={sourceKey}
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
				title={displayTitle(visual)}
				flush
				notice={driftNote}
			>
				{note && <VisualNotice>{note}</VisualNotice>}
				<DataGrid
					sourceKey={sourceKey}
					dimensions={dimensions}
					measures={measures}
					baseFilters={filters}
					fields={fields}
					height={frameHeight ? "100%" : gridHeight}
					pageSize={compact ? 25 : 200}
					reportId={reportId}
					pageId={pageId}
					visualId={visual.visualId}
					style={style}
					columnOrder={columnOrder}
					pinnedColumns={pinnedColumns}
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
