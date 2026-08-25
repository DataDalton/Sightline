"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { SkeletonReport } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { titleSeparator, usePageTitle } from "../hooks/usePageTitle";
import { DataFreshness } from "../visuals/DataFreshness";
import { VisualRenderer, type VisualSpec } from "../visuals/VisualRenderer";
import { PageFilterProvider } from "../visuals/PageFilters";
import { FilterBar } from "../visuals/FilterWidgets";
import { isPageControl, visualByType } from "../../lib/visuals/catalog";
import { ReportEditor } from "./editorEntry";
import type { EditableVisual } from "../editor/types";
import { useUser } from "../context/UserContext";
import type { SourceMeta } from "../visuals/types";
import { FieldPicker } from "./FieldPicker";
import { SavedViews, type SavedView } from "./SavedViews";
import { ReportGrid } from "./ReportGrid";
import {
	ScaledArea,
	ViewScaleProvider,
	ZoomControl,
	type VisualSize,
} from "./ViewScale";
import styles from "./ReportView.module.css";

interface StoredVisual extends VisualSpec {
	layout?: { x: number; y: number; w: number; h: number };
}

interface PageDefinition {
	pageId: string;
	slug: string;
	title: string;
	template: string | null;
	sourceKey: string | null;
	// Page-level settings. `freshness.field` names the column the data-through
	// stamp takes a maximum of.
	config?: {
		freshness?: { field?: string | null; label?: string | null };
		[key: string]: unknown;
	};
	visuals: StoredVisual[];
}

interface ReportDetail {
	reportId: string;
	categoryId: string | null;
	slug: string;
	title: string;
	description: string | null;
	sourceKey: string | null;
	permission: "view" | "edit" | "admin";
	version: number;
	pages: PageDefinition[];
}

interface ReportResponse {
	report: ReportDetail;
	sources: Record<string, SourceMeta>;
}

export default function ReportView({ slug }: { slug: string }) {
	const { data, error, isLoading, mutate } = useSWR<ReportResponse>(
		`/api/report/${encodeURIComponent(slug)}`,
	);
	const { user } = useUser();
	const showSkeleton = useDeferredLoading(isLoading);
	const [editing, setEditing] = useState(false);
	// Held by id rather than by index, because a report with subpages has two
	// rows of tabs and an index into a flat list cannot say which one is on.
	const [activePageId, setActivePageId] = useState<string | null>(null);

	// A report with one page is named by the report. With several, the page is
	// what distinguishes two tabs open on the same report, so it is named too.
	// Composed here rather than below because a hook cannot be called after the
	// loading return.
	const titled = data?.report;
	const titledPage = titled
		? (titled.pages.find((p) => p.pageId === activePageId) ??
			titled.pages[0])
		: undefined;
	usePageTitle(
		titled
			? titled.pages.length > 1 && titledPage
				? `${titled.title} ${titleSeparator} ${titledPage.title}`
				: titled.title
			: null,
	);
	// Column choices the reader has made, and which saved view they came from.
	// Null means the page is showing what the report defines.
	const [custom, setCustom] = useState<{
		dimensions: string[];
		measures: string[];
	} | null>(null);
	const [activeViewId, setActiveViewId] = useState<string | null>(null);
	// How the reader has arranged the grid: which columns they moved and which
	// they pinned. Held here rather than in the grid so a saved view carries
	// it, which is the only way it survives a reload.
	const [columnLayout, setColumnLayout] = useState<{
		columnOrder: string[];
		pinnedColumns: string[];
	}>({ columnOrder: [], pinnedColumns: [] });
	// Sizes the reader has dragged visuals to, in grid columns and rows.
	const [visualSizes, setVisualSizes] = useState<Record<string, VisualSize>>(
		{},
	);

	if (error) {
		return (
			<div className={styles.page}>
				<div className={styles.state}>
					This report is not available to you.
				</div>
			</div>
		);
	}

	if (isLoading || !data) {
		// Blank rather than a skeleton for a report that answers from
		// cache, because the shell is already on screen and a flash of
		// placeholder under it is the only thing the reader would see.
		if (!showSkeleton) return <div className={styles.page} />;
		return (
			<div className={styles.page}>
				<SkeletonReport />
			</div>
		);
	}

	const { report, sources } = data;
	const page =
		report.pages.find((p) => p.pageId === activePageId) ?? report.pages[0];

	// Everything a reader had arranged belonged to the page they were on.
	const openPage = (nextId: string) => {
		setActivePageId(nextId);
		setCustom(null);
		setColumnLayout({ columnOrder: [], pinnedColumns: [] });
		setVisualSizes({});
		setActiveViewId(null);
	};
	const allVisuals = page?.visuals ?? [];
	// Filter widgets are lifted into a strip above the content: a filter acts
	// on the whole page, so it belongs to the page chrome rather than sitting
	// in the reading order between two charts.
	// The dimension switcher sits with the filters: it changes what the whole
	// page is broken down by, which is page chrome rather than a panel in the
	// reading order.
	const filterWidgets = allVisuals.filter((v) => isPageControl(v.visualType));
	const visuals = allVisuals
		.filter((v) => !isPageControl(v.visualType))
		.map((v) =>
			// Column choices apply to tables. A chart's encoding is part of
			// its definition, so overriding it would produce something the
			// author never designed.
			custom && v.visualType === "table"
				? {
						...v,
						config: {
							...v.config,
							dimensions: custom.dimensions,
							measures: custom.measures,
						},
					}
				: v,
		);

	// The data-through stamp. The source is whichever one the page is built on;
	// the column is the editor's choice, falling back to the source's own time
	// field so a page shows a stamp before anyone configures one.
	const freshnessSourceKey =
		page?.sourceKey ??
		report.sourceKey ??
		page?.visuals.find((v) => v.sourceKey)?.sourceKey ??
		null;
	const freshnessSource = freshnessSourceKey
		? sources[freshnessSourceKey]
		: undefined;
	const configuredFreshness = page?.config?.freshness;
	const freshnessField =
		configuredFreshness?.field ?? freshnessSource?.defaultTimeField ?? null;

	// The picker edits the first table on the page, which is the visual a
	// reader means when they ask to add a column.
	const tableVisual = visuals.find((v) => v.visualType === "table");
	const pickerSource = tableVisual?.sourceKey
		? sources[tableVisual.sourceKey]
		: undefined;
	const currentDimensions =
		custom?.dimensions ?? tableVisual?.config.dimensions ?? [];
	const currentMeasures =
		custom?.measures ?? tableVisual?.config.measures ?? [];

	// A report authored before the canvas existed has no stored layout, so one
	// is derived from reading order. Opening the editor is then the first time
	// a position is written, which is why it is derived rather than defaulted
	// to a pile at the origin.
	const editableVisuals: EditableVisual[] = (page?.visuals ?? []).map(
		(visual, index) => {
			const definition = visualByType[visual.visualType];
			const fallbackWidth = definition?.defaultLayout.w ?? 6;
			const fallbackHeight = definition?.defaultLayout.h ?? 4;
			return {
				...visual,
				layout: visual.layout ?? {
					x: (index * fallbackWidth) % 12,
					y:
						Math.floor((index * fallbackWidth) / 12) *
						fallbackHeight,
					w: fallbackWidth,
					h: fallbackHeight,
				},
			};
		},
	);

	if (editing && page) {
		return (
			<div className={styles.page} style={{ height: "100%" }}>
				<ReportEditor
					// Keyed by page, so switching page in the strip starts the
					// editor on that page's visuals. Its state is seeded from
					// the props once; without this a switch kept showing the
					// page that was open when the editor mounted.
					key={page.pageId}
					reportId={report.reportId}
					slug={report.slug}
					pageId={page.pageId}
					version={report.version}
					visuals={editableVisuals}
					sources={sources}
					pageSourceKey={freshnessSourceKey}
					pageConfig={page.config ?? {}}
					pageTitle={page.title}
					reportDescription={report.description}
					pages={report.pages.map((p) => ({
						pageId: p.pageId,
						title: p.title,
					}))}
					onSelectPage={openPage}
					onExit={() => setEditing(false)}
					onSaved={() => void mutate()}
				/>
			</div>
		);
	}

	return (
		<PageFilterProvider>
			<ViewScaleProvider
				sizes={visualSizes}
				onSizesChange={(next) => {
					setVisualSizes(next);
					// The arrangement no longer matches the saved view it started
					// from.
					setActiveViewId(null);
				}}
			>
				<div className={styles.page}>
					<div className={styles.header}>
						<div className={styles.headerMain}>
							<div className={styles.breadcrumb}>
								<Link href="/">Home</Link>
								<span aria-hidden="true">/</span>
								{report.categoryId && (
									<>
										<Link href={`/c/${report.categoryId}`}>
											{report.categoryId}
										</Link>
										<span aria-hidden="true">/</span>
									</>
								)}
								<span>{report.title}</span>
							</div>
							<h1 className={styles.title}>{report.title}</h1>
							{report.description && (
								<p className={styles.description}>
									{report.description}
								</p>
							)}
						</div>

						<div className={styles.actions}>
							<ZoomControl />

							{freshnessSourceKey && freshnessField && (
								<DataFreshness
									sourceKey={freshnessSourceKey}
									field={freshnessField}
									label={configuredFreshness?.label}
									dataType={
										freshnessSource?.dimensions.find(
											(f) => f.name === freshnessField,
										)?.dataType
									}
								/>
							)}

							{/* Editing publishes to everyone, so the button only
					    appears for someone who actually holds that right. */}
							{(user?.canEdit ||
								report.permission !== "view") && (
								<button
									type="button"
									className={styles.button}
									onClick={() => setEditing(true)}
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
									>
										<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
									</svg>
									Edit
								</button>
							)}
							{tableVisual && (
								<FieldPicker
									source={pickerSource}
									selectedDimensions={currentDimensions}
									selectedMeasures={currentMeasures}
									onChange={(dimensions, measures) => {
										setCustom({ dimensions, measures });
										// The arrangement no longer matches the saved
										// view it started from.
										setActiveViewId(null);
									}}
								/>
							)}
							{page && (
								<SavedViews
									reportId={report.reportId}
									pageId={page.pageId}
									current={{
										dimensions: currentDimensions,
										measures: currentMeasures,
										columnOrder: columnLayout.columnOrder,
										pinnedColumns:
											columnLayout.pinnedColumns,
										visualSizes,
									}}
									activeViewId={activeViewId}
									onApply={(view: SavedView | null) => {
										if (!view) {
											setCustom(null);
											setColumnLayout({
												columnOrder: [],
												pinnedColumns: [],
											});
											setVisualSizes({});
											setActiveViewId(null);
											return;
										}
										setCustom({
											dimensions:
												view.config.dimensions ?? [],
											measures:
												view.config.measures ?? [],
										});
										setColumnLayout({
											columnOrder:
												view.config.columnOrder ?? [],
											pinnedColumns:
												view.config.pinnedColumns ?? [],
										});
										setVisualSizes(
											view.config.visualSizes ?? {},
										);
										setActiveViewId(view.viewId);
									}}
								/>
							)}
						</div>
					</div>

					<ScaledArea>
						{report.pages.length > 1 && (
							<div className={styles.tabs} role="tablist">
								{report.pages.map((p) => (
									<button
										key={p.pageId}
										type="button"
										role="tab"
										aria-selected={
											page?.pageId === p.pageId
										}
										className={`${styles.tab} ${
											page?.pageId === p.pageId
												? styles.tabActive
												: ""
										}`}
										onClick={() => openPage(p.pageId)}
									>
										{p.title}
									</button>
								))}
							</div>
						)}

						{(filterWidgets.length > 0 || visuals.length > 0) && (
							<div className={styles.filterStrip}>
								<FilterBar>
									{filterWidgets.map((visual) => (
										<VisualRenderer
											key={visual.visualId}
											visual={visual}
											sources={sources}
											reportId={report.reportId}
											pageId={page?.pageId}
										/>
									))}
								</FilterBar>
							</div>
						)}

						{visuals.length === 0 ? (
							<div className={styles.state}>
								This page has no visuals configured yet.
							</div>
						) : (
							<ReportGrid
								visuals={visuals}
								sources={sources}
								reportId={report.reportId}
								pageId={page?.pageId}
								columnOrder={columnLayout.columnOrder}
								pinnedColumns={columnLayout.pinnedColumns}
								onColumnLayout={(next) => {
									setColumnLayout(next);
									// The arrangement no longer matches the saved view it
									// started from.
									setActiveViewId(null);
								}}
							/>
						)}
					</ScaledArea>
				</div>
			</ViewScaleProvider>
		</PageFilterProvider>
	);
}
