"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findFreeSlot, gridColumns, type Rect } from "../../lib/visuals/layout";
import {
	isPageControl,
	optionValue,
	visualByType,
} from "../../lib/visuals/catalog";
import type { SourceMeta } from "../visuals/types";
import type { AppliedVisual } from "../../lib/visuals/applyOps";
import { EditorCanvas, previewWidths } from "./EditorCanvas";
import { useLiveSync } from "./useLiveSync";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { NewPageDialog } from "../authoring/NewPage";
import { PageStrip } from "./PageStrip";
import { Select } from "../components/shared/Select";
import { ReportPlacement } from "./ReportPlacement";
import { Hint } from "./PanelSection";
import { VisualPicker } from "./VisualPicker";
import { PropertiesPanel } from "./PropertiesPanel";
import type { EditableVisual } from "./types";
import styles from "./Editor.module.css";

// The report editor.
//
// One definition per report, so a save publishes to everyone rather than
// creating a copy. Two things keep that safe with several editors at once:
// the save carries the version it was based on and is rejected if that has
// moved, and presence shows who else is in the report before anyone starts.
//
// Edits are batched locally and sent as one operation list. A save per drag
// would be a write per pointer move, and would make the version number a
// contention point rather than a safety net.

interface ReportEditorProps {
	reportId: string;
	slug: string;
	pageId: string;
	version: number;
	visuals: EditableVisual[];
	sources: Record<string, SourceMeta>;
	// The page's own settings and the source they apply to, for the settings
	// popover. Separate from the visuals because they belong to the page.
	pageSourceKey: string | null;
	pageConfig: PageConfig;
	pageTitle: string;
	// The report's own name. A confirmation about deleting the report has to say
	// that; the page title names one page of it.
	reportTitle: string;
	// The line under the report title. Report-level rather than page-level,
	// because that is where it is stored and where every page shows it.
	reportDescription: string | null;
	// Which section of the navigation the report sits in, and whether it is a
	// personal page. A personal page is placed by publishing it rather than by
	// moving it, so the placement controls are not offered for one.
	categoryId: string | null;
	isPersonal: boolean;
	// Every page in the report, for the strip under the toolbar.
	pages: { pageId: string; title: string }[];
	// Switching page is the page owner's business, not the editor's: the
	// reader view holds which one is open.
	onSelectPage: (pageId: string) => void;
	onExit: () => void;
	// Awaited where the caller can supply one, so a page added from a template
	// is in the strip before the editor is asked to open it.
	onSaved: () => void | Promise<unknown>;
}

export interface PageConfig {
	freshness?: { field?: string | null; label?: string | null };
	// Keeps the filter controls in view while the page scrolls.
	stickyFilters?: boolean;
	// What a reader sees when the page has nothing to show.
	emptyText?: string;
	[key: string]: unknown;
}

type PendingOp =
	| { type: "addVisual"; visual: EditableVisual }
	| { type: "updateVisual"; visualId: string }
	| { type: "removeVisual"; visualId: string }
	| { type: "reorderVisuals"; visualIds: string[] }
	| { type: "updatePage" }
	| { type: "updateReport" }
	| { type: "addPage"; pageId: string; title: string }
	| { type: "removePage"; pageId: string }
	| { type: "reorderPages"; pageIds: string[] };

export function ReportEditor({
	reportId,
	slug,
	pageId,
	version,
	visuals: initialVisuals,
	sources,
	pageSourceKey,
	pageConfig: initialPageConfig,
	pageTitle: initialPageTitle,
	reportTitle,
	reportDescription: initialDescription,
	categoryId,
	isPersonal,
	pages,
	onSelectPage,
	onExit,
	onSaved,
}: ReportEditorProps) {
	const [visuals, setVisuals] = useState<EditableVisual[]>(initialVisuals);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [zoom, setZoom] = useState(1);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState<string | null>(null);
	const [baseVersion, setBaseVersion] = useState(version);
	const [pickerOpen, setPickerOpen] = useState(false);
	// Set when the picker was opened from the filter strip, so it lands on the
	// filters rather than on everything.
	const [pickerCategory, setPickerCategory] = useState<"filter" | undefined>(
		undefined,
	);
	const [addingPage, setAddingPage] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [pageConfig, setPageConfig] = useState<PageConfig>(initialPageConfig);
	const [pageTitle, setPageTitle] = useState(initialPageTitle);
	// Which tab the panel shows when nothing is selected. Selecting a visual
	// switches it to that visual's properties and back again on deselect.
	const [panelTab, setPanelTab] = useState<"page" | "report" | "history">(
		"page",
	);
	// Which screen the canvas is being laid out for. "fit" is the editor's own
	// width, which is the normal way to work.
	const [preview, setPreview] = useState("fit");
	// Bumped after every save and after a restore, so the history list picks up
	// the new version rather than showing what it read when it opened.
	const [historyKey, setHistoryKey] = useState(0);
	const [description, setDescription] = useState(initialDescription ?? "");

	// The order the strip is showing, which leads the saved order while a
	// reorder is pending. Reset when the report reloads, so a save that lands
	// hands control back to what the server says.
	const [pageOrder, setPageOrder] = useState<string[] | null>(null);
	useEffect(() => {
		setPageOrder(null);
	}, [version]);

	// Applied to the prop rather than replacing it, so a page added or removed
	// while a reorder is pending still appears.
	const orderedPages = useMemo(() => {
		if (!pageOrder) return pages;
		const rank = new Map(pageOrder.map((id, i) => [id, i]));
		return [...pages].sort(
			(a, b) =>
				(rank.get(a.pageId) ?? Number.MAX_SAFE_INTEGER) -
				(rank.get(b.pageId) ?? Number.MAX_SAFE_INTEGER),
		);
	}, [pages, pageOrder]);

	// Operations accumulate rather than replacing state, so a save can tell an
	// insert from an update without diffing the whole page.
	const pendingRef = useRef<Map<string, PendingOp>>(new Map());
	const sessionIdRef = useRef<string>(
		typeof crypto !== "undefined"
			? crypto.randomUUID()
			: String(Date.now()),
	);

	const selected = visuals.find((v) => v.visualId === selectedId) ?? null;

	// Removing the whole report, not a page or a visual. Refused by the server
	// unless the caller could edit it, which for a personal page means owning
	// it and for a curated one means holding edit.
	const remove = async () => {
		setRemoving(true);
		try {
			const response = await fetch("/api/authoring", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "removeReport", reportId }),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setConflict(detail?.error ?? "Could not delete this report.");
				setConfirmingRemove(false);
				return;
			}
			window.location.href = "/";
		} finally {
			setRemoving(false);
		}
	};

	// Ids the author is manipulating right now. A remote change to one of
	// these is deferred rather than applied, so a visual is never yanked out
	// from under a drag in progress.
	const activeIdsRef = useRef<Set<string>>(new Set());
	const visualsRef = useRef(visuals);
	visualsRef.current = visuals;
	const versionRef = useRef(baseVersion);
	versionRef.current = baseVersion;

	// The selected visual is protected as well as any being dragged: the
	// properties panel is an edit in progress even when nothing is moving.
	useEffect(() => {
		const next = new Set(activeIdsRef.current);
		if (selectedId) next.add(selectedId);
		activeIdsRef.current = next;
		return () => {
			if (!selectedId) return;
			const after = new Set(activeIdsRef.current);
			after.delete(selectedId);
			activeIdsRef.current = after;
		};
	}, [selectedId]);

	const [remoteNotice, setRemoteNotice] = useState<string | null>(null);

	// Remote edits are applied to the canvas rather than reported as a
	// conflict. Applying them also advances the version this session is based
	// on, which is what keeps its next save from being rejected as stale.
	const onRemoteChange = useCallback(
		(nextVisuals: AppliedVisual[], version: number, actors: string[]) => {
			if (actors.length > 0) {
				setVisuals(
					nextVisuals.map((incoming) => {
						const local = visualsRef.current.find(
							(v) => v.visualId === incoming.visualId,
						);
						// Local-only fields, such as the unsaved flag, are kept
						// so a visual added here is still recognised as an
						// insert when this session saves.
						return local
							? { ...local, ...incoming }
							: (incoming as EditableVisual);
					}),
				);

				const names = actors.map((a) => a.split("@")[0]).join(", ");
				setRemoteNotice(`${names} changed this page`);
				window.setTimeout(() => setRemoteNotice(null), 4000);
			}

			// The version moves whether or not anyone else edited, because
			// this session's own saved ops also advance it.
			setBaseVersion((prev) => Math.max(prev, version));
		},
		[],
	);

	// Someone put an old version back while this session was open. Nothing here
	// can be reconciled with that: the page was replaced rather than edited, so
	// the honest response is to say so and reload rather than to keep arranging
	// a version that no longer exists.
	const onReload = useCallback(
		(actor: string) => {
			setConflict(
				`${actor.split("@")[0]} restored an earlier version. Reopening the editor will show it.`,
			);
			onSaved();
		},
		[onSaved],
	);

	const live = useLiveSync({
		slug,
		pageId,
		sessionId: sessionIdRef.current,
		enabled: true,
		protectedIds: () => activeIdsRef.current,
		localState: () => ({ visualId: selectedId }),
		onRemoteChange,
		onReload,
		getVisuals: () => visualsRef.current as AppliedVisual[],
		getVersion: () => versionRef.current,
	});

	// Leaving with unsaved work is almost always a mistake, so the browser
	// asks. This is the one case where interrupting is right.
	useEffect(() => {
		if (!dirty) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [dirty]);

	const markPending = useCallback((op: PendingOp) => {
		const key =
			op.type === "addVisual"
				? op.visual.visualId
				: op.type === "updatePage"
					? "page"
					: op.type === "updateReport"
						? "report"
						: op.type === "addPage" || op.type === "removePage"
							? `page:${op.pageId}`
							: op.type === "reorderPages"
								? "pageOrder"
								: op.type === "reorderVisuals"
									? "visualOrder"
									: op.visualId;
		const existing = pendingRef.current.get(key);

		// A visual added and then edited in the same session is still an
		// insert; a visual added and then removed cancels out entirely.
		if (existing?.type === "addVisual" && op.type === "updateVisual")
			return;
		if (existing?.type === "addVisual" && op.type === "removeVisual") {
			pendingRef.current.delete(key);
			return;
		}
		pendingRef.current.set(key, op);
	}, []);

	const updateVisual = useCallback(
		(next: EditableVisual) => {
			setVisuals((prev) =>
				prev.map((v) => (v.visualId === next.visualId ? next : v)),
			);
			markPending({ type: "updateVisual", visualId: next.visualId });
			setDirty(true);
		},
		[markPending],
	);

	const beginGesture = useCallback((visualId: string) => {
		activeIdsRef.current = new Set(activeIdsRef.current).add(visualId);
	}, []);

	const endGesture = useCallback((visualId: string) => {
		const next = new Set(activeIdsRef.current);
		next.delete(visualId);
		activeIdsRef.current = next;
	}, []);

	// Text panel content, edited in place on the canvas.
	const changeContent = useCallback(
		(visualId: string, html: string) => {
			setVisuals((prev) =>
				prev.map((v) =>
					v.visualId === visualId
						? {
								...v,
								config: {
									...v.config,
									options: { ...v.config.options, html },
								},
							}
						: v,
				),
			);
			markPending({ type: "updateVisual", visualId });
			setDirty(true);
		},
		[markPending],
	);

	const changeLayout = useCallback(
		(visualId: string, rect: Rect) => {
			setVisuals((prev) =>
				prev.map((v) =>
					v.visualId === visualId ? { ...v, layout: rect } : v,
				),
			);
			markPending({ type: "updateVisual", visualId });
			setDirty(true);
		},
		[markPending],
	);

	const addVisual = useCallback(
		(type: string) => {
			const definition = visualByType[type];
			if (!definition) return;

			const slot = findFreeSlot(
				visuals.map((v) => v.layout),
				definition.defaultLayout.w,
				definition.defaultLayout.h,
			);

			// A new visual inherits the page source, which is what an author
			// almost always wants and saves a step.
			const inheritedSource =
				visuals.find((v) => v.sourceKey)?.sourceKey ??
				Object.keys(sources)[0] ??
				null;

			const visual: EditableVisual = {
				visualId:
					typeof crypto !== "undefined"
						? crypto.randomUUID()
						: `new-${Date.now()}`,
				visualType: type,
				title: definition.label,
				sourceKey: inheritedSource,
				config: { dimensions: [], measures: [], filters: [], sort: [] },
				layout: slot,
				isNew: true,
			};

			setVisuals((prev) => [...prev, visual]);
			markPending({ type: "addVisual", visual });
			setSelectedId(visual.visualId);
			setPickerOpen(false);
			setDirty(true);
		},
		[visuals, sources, markPending],
	);

	// Moving a control along the filter strip.
	//
	// A control is not on the grid, so there is no rectangle to drag: its place
	// is its position in the page order. Swapping it with its neighbour writes
	// the whole page order, which is what the operation takes, and leaves every
	// placed visual where it was.
	const moveControl = useCallback(
		(visualId: string, delta: -1 | 1) => {
			const controls = visuals.filter((v) => isPageControl(v.visualType));
			const from = controls.findIndex((v) => v.visualId === visualId);
			const to = from + delta;
			if (from < 0 || to < 0 || to >= controls.length) return;

			const next = [...visuals];
			const a = next.indexOf(controls[from]);
			const b = next.indexOf(controls[to]);
			[next[a], next[b]] = [next[b], next[a]];

			setVisuals(next);
			// One operation whatever the order was changed to, keyed on the
			// whole list rather than on a visual, so nudging a control three
			// places along is still one write.
			markPending({
				type: "reorderVisuals",
				visualIds: next.map((v) => v.visualId),
			});
			setDirty(true);
		},
		[visuals, markPending],
	);

	// The groups on this page, offered as somewhere to put a visual when
	// dragging it there is not available: a visual already inside a group has
	// nowhere on the canvas to be dragged out to.
	const groups = useMemo(
		() =>
			visuals
				.filter((v) => v.visualType === "group")
				.map((v) => ({
					visualId: v.visualId,
					label: v.title?.trim() || "Untitled group",
				})),
		[visuals],
	);

	// A visual dropped onto a group, or taken out of one.
	//
	// Both halves are one write: what holds the visual and the rectangle it is
	// measured by change together, and applying either alone renders the visual
	// against the wrong box. It rides the existing update operation, since a
	// parent is part of the config like anything else.
	const reparent = useCallback(
		(visualId: string, parentId: string | null, rect: Rect) => {
			setVisuals((prev) =>
				prev.map((v) =>
					v.visualId === visualId
						? {
								...v,
								layout: rect,
								config: {
									...v.config,
									parentId: parentId ?? undefined,
								},
							}
						: v,
				),
			);
			markPending({ type: "updateVisual", visualId });
			setDirty(true);
		},
		[markPending],
	);

	const removeVisual = useCallback(
		(visualId: string) => {
			// A group taken off the page lets go of what it held rather than
			// taking it with it. Deleting one visual should never delete ten,
			// and a child left naming a group that no longer exists is laid out
			// against a box that is not there.
			//
			// The rectangles are the group's, not the page's, so each one is
			// put back on the page at the position the group occupied. That is
			// not where they were, but it is where the author was looking, and
			// it is somewhere rather than piled on the origin.
			const released = visuals.filter(
				(v) => v.config.parentId === visualId,
			);
			const home = visuals.find((v) => v.visualId === visualId)?.layout;

			setVisuals((prev) =>
				prev
					.filter((v) => v.visualId !== visualId)
					.map((v) =>
						v.config.parentId === visualId
							? {
									...v,
									layout: {
										...v.layout,
										x: Math.min(
											home?.x ?? 0,
											gridColumns - v.layout.w,
										),
										y: home?.y ?? 0,
									},
									config: {
										...v.config,
										parentId: undefined,
									},
								}
							: v,
					),
			);

			markPending({ type: "removeVisual", visualId });
			for (const child of released) {
				markPending({ type: "updateVisual", visualId: child.visualId });
			}
			setSelectedId(null);
			setDirty(true);
		},
		[visuals, markPending],
	);

	const save = useCallback(async () => {
		if (pendingRef.current.size === 0) return;
		setSaving(true);
		setConflict(null);

		// One operation list rather than a request per change, so the version
		// moves once and concurrent editors contend once.
		const operations = Array.from(pendingRef.current.values()).map((op) => {
			if (op.type === "addVisual") {
				const v = op.visual;
				return {
					type: "addVisual",
					// Sent explicitly so every session applies the insert to
					// the same id rather than the database minting one only
					// this session knows about.
					visualId: v.visualId,
					pageId,
					visualType: v.visualType,
					title: v.title,
					sourceKey: v.sourceKey,
					config: { ...v.config, layout: v.layout },
				};
			}
			if (op.type === "removeVisual") {
				return { type: "removeVisual", visualId: op.visualId };
			}
			if (op.type === "updatePage") {
				return {
					type: "updatePage",
					pageId,
					title: pageTitle,
					config: pageConfig,
				};
			}
			if (op.type === "updateReport") {
				return { type: "updateReport", description };
			}
			if (op.type === "addPage") {
				return {
					type: "addPage",
					pageId: op.pageId,
					title: op.title,
					// Derived from the title, and made unique by the id, since
					// two subpages can reasonably be called the same thing on
					// different parents.
					slug: `${
						op.title
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, "-")
							.replace(/^-|-$/g, "")
							.slice(0, 40) || "page"
					}-${op.pageId.slice(0, 8)}`,
					sourceKey: pageSourceKey,
				};
			}
			if (op.type === "removePage") {
				return { type: "removePage", pageId: op.pageId };
			}
			if (op.type === "reorderPages") {
				return { type: "reorderPages", pageIds: op.pageIds };
			}
			if (op.type === "reorderVisuals") {
				return {
					type: "reorderVisuals",
					pageId,
					visualIds: op.visualIds,
				};
			}
			const v = visuals.find((x) => x.visualId === op.visualId);
			return {
				type: "updateVisual",
				visualId: op.visualId,
				title: v?.title,
				visualType: v?.visualType,
				sourceKey: v?.sourceKey,
				config: v ? { ...v.config, layout: v.layout } : undefined,
			};
		});

		try {
			const response = await fetch(
				`/api/report/${encodeURIComponent(slug)}/edit`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						baseVersion,
						originId: sessionIdRef.current,
						operations,
					}),
				},
			);

			if (response.status === 409) {
				const detail = await response.json();
				setConflict(
					`${detail.error} The current version is ${detail.currentVersion}.`,
				);
				return;
			}
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setConflict(detail?.error ?? "Could not save");
				return;
			}

			const result = await response.json();
			pendingRef.current.clear();
			setBaseVersion(result.version);
			live.acknowledge(result.seq ?? 0);
			setDirty(false);
			setSavedAt(Date.now());
			setHistoryKey((k) => k + 1);
			onSaved();
		} catch (error) {
			setConflict(
				error instanceof Error ? error.message : "Could not save",
			);
		} finally {
			setSaving(false);
		}
	}, [
		slug,
		baseVersion,
		pageId,
		pageSourceKey,
		visuals,
		pageConfig,
		pageTitle,
		description,
		onSaved,
	]);

	const others = live.others;

	// Which visual each other editor has selected, so the canvas can show it.
	const remoteSelections = useMemo(() => {
		const map = new Map<string, string>();
		for (const person of others) {
			const id = person.state?.visualId;
			if (id) map.set(id, person.userEmail);
		}
		return map;
	}, [others]);

	return (
		<div className={styles.editor}>
			<div className={styles.toolbar}>
				<button
					type="button"
					className={styles.toolButton}
					onClick={() => {
						// The toolbar asks for anything, so it clears whatever
						// the filter strip may have narrowed the picker to.
						setPickerCategory(undefined);
						setPickerOpen((v) => !v);
					}}
					aria-expanded={pickerOpen}
				>
					+ Add visual
				</button>

				<span className={styles.divider} aria-hidden="true" />

				<label className={styles.previewPicker}>
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
						<rect x="2" y="4" width="14" height="11" rx="1" />
						<path d="M2 19h14" />
						<rect x="18" y="9" width="4" height="10" rx="1" />
					</svg>
					<Select
						className={styles.previewSelect}
						bare
						value={preview}
						onChange={setPreview}
						ariaLabel="Preview width"
						options={previewWidths.map((w) => ({
							value: w.id,
							label: w.label,
							note: w.width ? `${w.width}px` : undefined,
						}))}
					/>
				</label>

				<span className={styles.divider} aria-hidden="true" />

				<div className={styles.zoom}>
					<button
						type="button"
						className={styles.toolButton}
						onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
						aria-label="Zoom out"
						disabled={zoom <= 0.5}
					>
						−
					</button>
					<span className={styles.zoomValue}>
						{Math.round(zoom * 100)}%
					</span>
					<button
						type="button"
						className={styles.toolButton}
						onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))}
						aria-label="Zoom in"
						disabled={zoom >= 1.5}
					>
						+
					</button>
					{zoom !== 1 && (
						<button
							type="button"
							className={styles.toolButton}
							onClick={() => setZoom(1)}
						>
							Reset
						</button>
					)}
				</div>

				<div className={styles.spacer} />

				{!live.connected && (
					<span className={`${styles.status} ${styles.statusDirty}`}>
						Reconnecting
					</span>
				)}

				{others.length > 0 && (
					<div
						className={styles.presence}
						title={`Also editing: ${others.map((p) => p.userEmail).join(", ")}`}
					>
						{others.slice(0, 4).map((p, i) => (
							<span
								key={p.sessionId}
								className={styles.avatar}
								style={{
									background: `var(--chart-${(i % 8) + 1})`,
								}}
								title={p.userEmail}
							>
								{p.userEmail.slice(0, 2).toUpperCase()}
							</span>
						))}
						{others.length > 4 && (
							<span className={styles.avatar}>
								+{others.length - 4}
							</span>
						)}
					</div>
				)}

				{/* The version number is the history, so it opens it rather than
				    sitting there as a fact with nothing behind it. */}
				<button
					type="button"
					className={`${styles.status} ${styles.statusButton} ${
						dirty
							? styles.statusDirty
							: savedAt
								? styles.statusSaved
								: ""
					}`}
					onClick={() => {
						setSelectedId(null);
						setPanelTab("history");
					}}
					title="Open the edit history"
				>
					{saving
						? "Saving"
						: dirty
							? "Unsaved changes"
							: savedAt
								? "Saved"
								: `Version ${baseVersion}`}
				</button>

				<button
					type="button"
					className={styles.toolButton}
					onClick={onExit}
					disabled={saving}
				>
					{dirty ? "Discard and exit" : "Done"}
				</button>
				<button
					type="button"
					className={`${styles.toolButton} ${styles.primary}`}
					onClick={save}
					disabled={!dirty || saving}
				>
					{saving ? "Publishing" : "Publish to everyone"}
				</button>
			</div>

			{conflict && (
				<div className={styles.conflict} role="alert">
					{conflict}
					<button
						type="button"
						className={styles.toolButton}
						style={{ marginTop: 8 }}
						onClick={() => {
							setConflict(null);
							void live.refresh();
						}}
					>
						Catch up now
					</button>
				</div>
			)}

			{remoteNotice && (
				<div className={styles.remoteNotice} role="status">
					{remoteNotice}
				</div>
			)}

			{live.deferred.length > 0 && (
				<div className={styles.remoteNotice} role="status">
					Someone changed a visual you are editing. Your version is
					showing; theirs applies when you deselect it.
				</div>
			)}

			<VisualPicker
				open={pickerOpen}
				initialCategory={pickerCategory}
				onPick={addVisual}
				onClose={() => setPickerOpen(false)}
			/>

			{confirmingRemove && (
				<ConfirmDialog
					title="Delete this report"
					body={
						<>
							<strong>{reportTitle}</strong> and every page on it
							will be removed. Anyone who could open it loses it.
						</>
					}
					busy={removing}
					onConfirm={remove}
					onCancel={() => setConfirmingRemove(false)}
				/>
			)}

			{addingPage && (
				<NewPageDialog
					reportId={reportId}
					source={
						pageSourceKey ? (sources[pageSourceKey] ?? null) : null
					}
					// A blank page keeps the operation path, because that is
					// what other open sessions replay. A template page is one
					// server call and the editor reloads onto it.
					onBlank={(title) => {
						const newId =
							typeof crypto !== "undefined"
								? crypto.randomUUID()
								: String(Date.now());
						pendingRef.current.set(`page:${newId}`, {
							type: "addPage",
							pageId: newId,
							title,
						});
						setDirty(true);
					}}
					onCreated={async (newPageId) => {
						// Refetched first so the page exists in the strip, then
						// opened, which remounts the editor and re-seeds it from
						// the current version.
						await onSaved();
						if (newPageId) onSelectPage(newPageId);
					}}
					onClose={() => setAddingPage(false)}
				/>
			)}

			<PageStrip
				pages={orderedPages}
				activePageId={pageId}
				dirty={dirty}
				onSelect={onSelectPage}
				onAdd={() => setAddingPage(true)}
				onRemove={(removeId) => {
					pendingRef.current.set(`page:${removeId}`, {
						type: "removePage",
						pageId: removeId,
					});
					setDirty(true);
				}}
				onReorder={(pageIds) => {
					// One pending op whatever the order was changed to, keyed
					// on the whole list rather than on a page, so nudging a tab
					// four places along is still one write.
					pendingRef.current.set("pageOrder", {
						type: "reorderPages",
						pageIds,
					});
					setPageOrder(pageIds);
					setDirty(true);
				}}
			/>

			<div className={styles.workspace}>
				<EditorCanvas
					visuals={visuals}
					sources={sources}
					selectedId={selectedId}
					zoom={zoom}
					onSelect={setSelectedId}
					onLayoutChange={changeLayout}
					onGestureStart={beginGesture}
					onGestureEnd={endGesture}
					remoteSelections={remoteSelections}
					onContentChange={changeContent}
					onMoveControl={moveControl}
					onReparent={reparent}
					onAddControl={() => {
						setPickerCategory("filter");
						setPickerOpen(true);
					}}
					previewWidth={
						previewWidths.find((w) => w.id === preview)?.width ??
						null
					}
				/>
				<PropertiesPanel
					visual={selected}
					source={
						selected?.sourceKey
							? sources[selected.sourceKey]
							: undefined
					}
					onChange={updateVisual}
					onRemove={removeVisual}
					onDeselect={() => setSelectedId(null)}
					groups={groups}
					pageSource={
						pageSourceKey ? sources[pageSourceKey] : undefined
					}
					pageConfig={pageConfig}
					pageTitle={pageTitle}
					reportDescription={description}
					placement={
						<>
							{!isPersonal && (
								<ReportPlacement
									reportId={reportId}
									slug={slug}
									categoryId={categoryId}
									dirty={dirty}
								/>
							)}

							{/* Kept away from the toolbar, where it sat between
							    Done and Publish and was one slip from either.
							    Down here it takes a deliberate trip into the
							    settings panel, and still asks. */}
							<div className={styles.dangerBlock}>
								<span className={styles.fieldLabel}>
									Delete this report
								</span>
								<Hint>
									Removes every page on it. Anyone who could
									open it loses it.
								</Hint>
								<button
									type="button"
									className={styles.dangerButton}
									onClick={() => setConfirmingRemove(true)}
									disabled={saving || removing}
								>
									{removing ? "Deleting" : "Delete report"}
								</button>
							</div>
						</>
					}
					panelTab={panelTab}
					onPanelTab={setPanelTab}
					historySlug={slug}
					historyKey={historyKey}
					onRestored={() => {
						// The restore has already landed. Everything the
						// editor is holding is now a version behind, and
						// reconstructing it here would be guessing, so the
						// page reloads from what was actually written.
						setHistoryKey((k) => k + 1);
						onSaved();
						onExit();
					}}
					onPageChange={(next) => {
						setPageConfig(next);
						pendingRef.current.set("page", { type: "updatePage" });
						setDirty(true);
					}}
					onPageTitleChange={(next) => {
						setPageTitle(next);
						pendingRef.current.set("page", { type: "updatePage" });
						setDirty(true);
					}}
					onDescriptionChange={(next) => {
						setDescription(next);
						pendingRef.current.set("report", {
							type: "updateReport",
						});
						setDirty(true);
					}}
				/>
			</div>
		</div>
	);
}
