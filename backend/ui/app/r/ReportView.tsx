"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { describeFetchError } from "../../lib/swr";
import { primeBatchCache } from "../hooks/queryBatch";
import { SkeletonReport } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { titleSeparator, usePageTitle } from "../hooks/usePageTitle";
import { DataFreshness } from "../visuals/DataFreshness";
import { VisualRenderer, type VisualSpec } from "../visuals/VisualRenderer";
import { PageFilterProvider } from "../visuals/PageFilters";
import {
	decodeShareParams,
	encodeShareParams,
	type ShareContext,
	type SharedPageState,
} from "../../lib/visuals/shareState";
import { filterWidgetsOf } from "../../lib/visuals/filterWidgets";
import { openingFilters } from "../../lib/visuals/pageDefaults";
import { FilterBar } from "../visuals/FilterWidgets";
import { isPageControl, visualByType } from "../../lib/visuals/catalog";
import { ReportEditor } from "./editorEntry";
import { PageActions } from "../authoring/PageActions";
import type { EditableVisual } from "../editor/types";
import { useUser } from "../context/UserContext";
import type { SourceMeta } from "../visuals/types";
import { FieldPicker } from "./FieldPicker";
import { SavedViews, type SavedView } from "./SavedViews";
import { FavouriteButton } from "./FavouriteButton";
import { ShareLinkButton } from "./ShareLinkButton";
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
		// Keeps the filter controls in view while the page scrolls.
		stickyFilters?: boolean;
		// What a reader sees when the page has nothing to show. The default is
		// written for whoever is building the page, which is the wrong audience
		// once it is published.
		emptyText?: string;
		[key: string]: unknown;
	};
	visuals: StoredVisual[];
	// Locks an administrator has put on the page. The editor stops offering
	// what they refuse; the refusal itself is the server's.
	protectDelete?: boolean;
	protectEdit?: boolean;
}

interface ReportDetail {
	reportId: string;
	categoryId: string | null;
	slug: string;
	title: string;
	description: string | null;
	sourceKey: string | null;
	permission: "view" | "edit" | "admin";
	// A page somebody built for themselves rather than a curated report. Its
	// owner can name who else sees it; an editor can put it in a category.
	isPersonal: boolean;
	ownerEmail: string;
	version: number;
	// Locks that reach every page in the report.
	protectDelete?: boolean;
	protectEdit?: boolean;
	protectAddPage?: boolean;
	pages: PageDefinition[];
}

interface ReportResponse {
	report: ReportDetail;
	sources: Record<string, SourceMeta>;
	// Answers the server already had for this page's opening visuals, keyed the
	// same way the client asks for them.
	seeded?: Record<string, unknown>;
}

// initial is the definition the server resolved while rendering the document.
//
// Handed to the hook rather than provided through context. A nested SWRConfig
// looked equivalent and was not: the shell's fallback reached its hooks and this
// one did not, so the report rendered an empty page on the server and every
// visual waited for hydration before it could even start. fallbackData on the
// call is unambiguous about which key it answers.
// Which page of a report is open, given what the reader has chosen and what a
// link asked for.
//
// A plain function rather than something worked out in the body, because the
// effect that keeps the address bar in step has to run before the report has
// loaded and therefore cannot read anything computed after it.
function pageOf(
	report: ReportDetail,
	activePageId: string | null,
	namedPage: string | null,
): ReportDetail["pages"][number] | undefined {
	return (
		report.pages.find(
			(p) => p.pageId === (activePageId ?? namedPage ?? null),
		) ?? report.pages[0]
	);
}

// What the parameters in the address bar mean, given the controls a page
// actually has.
//
// A parameter is named after a field, so reading one back means finding the
// control that owns that field. One naming a field no control owns is dropped
// rather than applied: narrowing the page with nothing on screen able to show
// or clear it would leave a reader stuck.
function shareContextOf(
	report: ReportDetail,
	page: ReportDetail["pages"][number] | undefined,
	views: { viewId: string; name: string }[],
): ShareContext {
	return {
		pages: report.pages.map((p) => ({
			pageId: p.pageId,
			title: p.title,
		})),
		widgets: filterWidgetsOf(page?.visuals ?? []),
		// The switchers name a dimension, and the ones a page offers are the
		// ones its own visuals encode. Placeholders are left out: they stand
		// for whatever the switcher is set to rather than naming a field.
		dimensions: (page?.visuals ?? []).flatMap((v) =>
			((v.config as { dimensions?: string[] })?.dimensions ?? []).filter(
				(d) => !d.startsWith("<"),
			),
		),
		views,
	};
}

// Shared rather than a fresh literal, so the share context does not change
// identity on every render while the list is still loading.
const noViews: { viewId: string; name: string }[] = [];

export default function ReportView({
	slug,
	initial,
}: {
	slug: string;
	initial?: ReportResponse;
}) {
	const { data, error, isLoading, mutate } = useSWR<ReportResponse>(
		`/api/report/${encodeURIComponent(slug)}`,
		{ fallbackData: initial },
	);
	const { user } = useUser();

	// Handed to the batcher before anything renders, so a visual whose answer
	// came with the document never issues a request for it. Done during render
	// rather than in an effect: an effect runs after the visuals have already
	// mounted and asked, which is the round trip this exists to remove.
	if (initial?.seeded) {
		primeBatchCache(initial.seeded);
		initial.seeded = undefined;
	}

	// Read off the navigation rather than fetched here. It carries the marked
	// list already, is seeded into the document, and is the thing this button
	// updates, so reading the same key keeps the star and the rail in step.
	const { data: navigation } = useSWR<{
		favourites?: { reportId: string }[];
	}>("/api/navigation");
	const isFavourite = Boolean(
		data?.report &&
		navigation?.favourites?.some(
			(f) => f.reportId === data.report.reportId,
		),
	);

	// Only a wait with nothing to show yet. SWR reports isLoading while it
	// revalidates behind data it already has, and treating that as a wait threw
	// away a report the server had already resolved.
	const showSkeleton = useDeferredLoading(isLoading && !data);
	const [editing, setEditing] = useState(false);

	// Opened straight into the editor when the URL asks for it. A report just
	// created is one somebody came here to build, and landing on the read-only
	// view would make them find it again and press Edit.
	//
	// After mount rather than as the initial state: this component renders on
	// the server too, where there is no location to read, and seeding from one
	// only on the client is a hydration mismatch. Runs once, so leaving the
	// editor does not immediately re-enter it.
	useEffect(() => {
		if (new URLSearchParams(window.location.search).get("edit") === "1") {
			setEditing(true);
		}
	}, []);

	// What the link this reader followed asked the page to open on.
	//
	// Read once, after mount, for the same reason the editor flag is: this
	// component renders on the server too, where there is no address bar, and
	// seeding from one only on the client is a hydration mismatch.

	// Held as the parameters the reader arrived with, until the report has
	// loaded: turning a parameter named after a field back into the control
	// that owns it needs the pages and widgets the report actually carries.
	//
	// Read once, after mount, for the same reason the editor flag is. This
	// component renders on the server too, where there is no address bar, and
	// seeding from one only on the client is a hydration mismatch.
	const [arrivedWith, setArrivedWith] = useState<URLSearchParams | null>(
		null,
	);
	useEffect(() => {
		setArrivedWith(new URLSearchParams(window.location.search));
	}, []);

	// Held by id rather than by index, because a report with subpages has two
	// rows of tabs and an index into a flat list cannot say which one is on.
	const [activePageId, setActivePageId] = useState<string | null>(null);

	// The saved views for the open page, so a link can name one.
	//
	// The same key the picker uses, so SWR shares one request between them
	// rather than asking twice for the same list.
	const { data: viewList } = useSWR<{
		views: { viewId: string; name: string }[];
	}>(
		activePageId
			? `/api/views?pageId=${encodeURIComponent(activePageId)}`
			: null,
	);
	const savedViews = viewList?.views ?? noViews;

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
		columnWidths: Record<string, number>;
	}>({ columnOrder: [], pinnedColumns: [], columnWidths: {} });
	// Sizes the reader has dragged visuals to, in grid columns and rows.
	const [visualSizes, setVisualSizes] = useState<Record<string, VisualSize>>(
		{},
	);

	// Everything the address bar should be carrying, gathered from the three
	// places that own a piece of it.
	const [pageState, setPageState] = useState<SharedPageState>({});

	// The address bar, kept in step with what is on screen.
	//
	// Written with replaceState rather than pushState. The link has to describe
	// the page for it to be worth sending, and it is what a reload reads back,
	// so it belongs in the URL. Pushing an entry per filter click would also
	// make the back button an undo for filters, and the cost of that is that
	// leaving a report somebody has been working in takes ten presses.
	//
	// This only became reasonable once the parameters were short and readable.
	// The first attempt packed everything into one opaque value and came to
	// seven hundred characters, which is why that was abandoned rather than
	// tuned.
	//
	// Above every early return, and reading the report out of the query rather
	// than out of anything worked out below. A hook that runs only once the
	// report has loaded runs on some renders and not others, which is what
	// React counts and refuses.
	useEffect(() => {
		// Not before the reader's own parameters have been read, or this would
		// overwrite the link they followed with the empty state it is about to
		// replace.
		if (!arrivedWith || !data) return;

		const page = pageOf(data.report, activePageId, null);
		const next = encodeShareParams(
			{
				...pageState,
				page: activePageId ?? undefined,
				view: activeViewId ?? undefined,
			},
			shareContextOf(data.report, page, savedViews),
		);

		const url = new URL(window.location.href);
		// Only the parameters this owns are replaced, so anything else the URL
		// is carrying survives.
		for (const key of [...url.searchParams.keys()]) {
			if (key !== "edit") url.searchParams.delete(key);
		}
		for (const [key, value] of next.entries()) {
			url.searchParams.set(key, value);
		}

		if (url.toString() !== window.location.href) {
			window.history.replaceState(window.history.state, "", url);
		}
	}, [arrivedWith, data, pageState, activePageId, activeViewId, savedViews]);

	if (error) {
		return (
			<div className={styles.page}>
				<div className={styles.state}>
					{describeFetchError(error, "report")}
				</div>
			</div>
		);
	}

	if (!data) {
		// Whether the definition is being revalidated does not matter here:
		// having it is what decides there is a report to draw. Waiting on
		// isLoading as well meant a definition the server had already resolved
		// was rendered as an empty page, so every visual, placeholder included,
		// appeared only after hydration and the whole report popped in at once.
		//
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

	// Which page a link named, read against the pages alone: every other
	// parameter is read against the controls that page carries, so the page
	// has to be settled first.
	const namedPage =
		(arrivedWith &&
			decodeShareParams(
				arrivedWith,
				shareContextOf(report, undefined, noViews),
			)?.page) ||
		null;

	const page = pageOf(report, activePageId, namedPage);

	// What the link this reader followed asked the page to open on.
	const shared = arrivedWith
		? decodeShareParams(
				arrivedWith,
				shareContextOf(report, page, savedViews),
			)
		: null;

	// The sender's filters belong to the page they were looking at. Switching
	// to another page inside the report is a new question, so the link's state
	// stops applying and the page's own defaults take over.
	const sharedHere =
		shared && (!shared.page || shared.page === page?.pageId)
			? shared
			: null;

	// What this page's filter widgets are set to before anybody touches them.
	// Handed to the provider as its opening state rather than applied after
	// mount, so the visuals never issue the unfiltered query first.
	const opening = openingFilters(
		(page?.visuals ?? []).map((v) => ({
			visualId: v.visualId,
			visualType: v.visualType,
			config: v.config as {
				dimensions?: string[];
				measures?: string[];
				options?: Record<string, unknown>;
			},
		})),
		new Date(),
	);

	// Everything a reader had arranged belonged to the page they were on.
	const openPage = (nextId: string) => {
		setActivePageId(nextId);
		setCustom(null);
		setColumnLayout({
			columnOrder: [],
			pinnedColumns: [],
			columnWidths: {},
		});
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
	// Controls the page lifts into the strip above the content.
	//
	// One inside a group is not among them: a group lays out what it holds, and
	// a control lifted out of its group into the strip would appear twice, once
	// where the author put it and once above the page.
	const heldByGroup = new Set(
		allVisuals
			.filter((v) => typeof v.config.parentId === "string")
			.map((v) => v.visualId),
	);
	const filterWidgets = allVisuals.filter(
		(v) => isPageControl(v.visualType) && !heldByGroup.has(v.visualId),
	);

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
					reportTitle={report.title}
					reportDescription={report.description}
					categoryId={report.categoryId}
					isPersonal={report.isPersonal}
					pages={report.pages.map((p) => ({
						pageId: p.pageId,
						title: p.title,
					}))}
					// Already combined, so the editor never has to work out
					// which lock applies before deciding what to offer.
					protectDelete={
						report.protectDelete === true ||
						page.protectDelete === true
					}
					protectEdit={
						report.protectEdit === true || page.protectEdit === true
					}
					reportProtectDelete={report.protectDelete === true}
					reportProtectEdit={report.protectEdit === true}
					reportProtectAddPage={report.protectAddPage === true}
					pageLocks={report.pages.map((p) => ({
						pageId: p.pageId,
						title: p.title,
						protectDelete: p.protectDelete === true,
						protectEdit: p.protectEdit === true,
					}))}
					onSelectPage={openPage}
					onExit={() => {
						setEditing(false);
						if (
							typeof window !== "undefined" &&
							window.location.search.includes("edit=1")
						) {
							window.history.replaceState(
								null,
								"",
								window.location.pathname,
							);
						}
					}}
					onSaved={() => mutate()}
				/>
			</div>
		);
	}

	// A report with no pages at all. Rare, and only reachable while somebody is
	// building one, but it is the difference between saying so and rendering a
	// blank rectangle.
	if (!page) {
		return (
			<div className={styles.page}>
				<div className={styles.state}>
					This report has no pages yet.
				</div>
			</div>
		);
	}

	return (
		<PageFilterProvider
			key={page.pageId}
			opening={opening}
			shared={sharedHere}
			onShareableChange={setPageState}
		>
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
							<div className={styles.titleRow}>
								<h1 className={styles.title}>{report.title}</h1>
								{/* Beside the name rather than in the row of view
								    controls to the right. Those are things you do
								    to what is on screen; this is a mark on the
								    report itself, and it reads as one where a
								    name is.

								    Personal pages are already under My pages, so
								    marking one would list it twice in the same
								    rail. */}
								{!report.isPersonal && (
									<FavouriteButton
										reportId={report.reportId}
										initial={isFavourite}
									/>
								)}
								{/* Beside the star, because both are things a
								    reader does with the report rather than to
								    it. */}
								<ShareLinkButton />
							</div>
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

							{/* Renders nothing for a curated report. On a page
					    somebody built for themselves its owner can name who
					    else sees it, and an editor can put it in a category. */}
							<PageActions
								reportId={report.reportId}
								title={report.title}
								isPersonal={report.isPersonal}
								ownerEmail={report.ownerEmail}
								onChanged={() => void mutate()}
							/>

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
									requestedViewId={sharedHere?.view ?? null}
									current={{
										dimensions: currentDimensions,
										measures: currentMeasures,
										columnOrder: columnLayout.columnOrder,
										pinnedColumns:
											columnLayout.pinnedColumns,
										columnWidths: columnLayout.columnWidths,
										visualSizes,
									}}
									activeViewId={activeViewId}
									onApply={(view: SavedView | null) => {
										if (!view) {
											setCustom(null);
											setColumnLayout({
												columnOrder: [],
												pinnedColumns: [],
												columnWidths: {},
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
											columnWidths:
												view.config.columnWidths ?? {},
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
							<div
								className={`${styles.filterStrip} ${
									page?.config?.stickyFilters
										? styles.filterStripSticky
										: ""
								}`}
							>
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
								{/* What an author wrote for the case where the
								    page is empty on purpose, otherwise the
								    default, which is about configuration and
								    is addressed to them rather than to a
								    reader. */}
								{typeof page?.config?.emptyText === "string" &&
								page.config.emptyText.trim() !== ""
									? page.config.emptyText
									: "This page has no visuals configured yet."}
							</div>
						) : (
							<ReportGrid
								visuals={visuals}
								sources={sources}
								reportId={report.reportId}
								pageId={page?.pageId}
								columnOrder={columnLayout.columnOrder}
								pinnedColumns={columnLayout.pinnedColumns}
								columnWidths={columnLayout.columnWidths}
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
