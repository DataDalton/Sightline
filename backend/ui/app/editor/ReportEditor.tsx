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
import { isTypingTarget, useEditorHistory } from "./useEditorHistory";
import { opsForRestore } from "../../lib/visuals/undo";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { NewPageDialog } from "../authoring/NewPage";
import { PageStrip } from "./PageStrip";
import { Select } from "../components/shared/Select";
import { ReportPlacement } from "./ReportPlacement";
import { Hint, Section } from "./PanelSection";
import { VisualPicker } from "./VisualPicker";
import { PropertiesPanel } from "./PropertiesPanel";
import { ProtectDialog, type PageLock } from "./ProtectPageDialog";
import { useUser } from "../context/UserContext";
import { describe } from "../../lib/platform/pageProtection";
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
	// What this page refuses, as the server holds it: the report's locks and the
	// page's own, already combined. The editor stops offering what would be
	// refused; the refusal itself is applyEdits's.
	protectDelete: boolean;
	protectEdit: boolean;
	// The report's own pair, and every page's, for the protection dialog.
	reportProtectDelete: boolean;
	reportProtectEdit: boolean;
	reportProtectAddPage: boolean;
	pageLocks: PageLock[];
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

// One point the canvas can be put back to.
interface EditorSnapshot {
	visuals: EditableVisual[];
	pageConfig: PageConfig;
	pageTitle: string;
	description: string;
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
	protectDelete,
	protectEdit,
	reportProtectDelete,
	reportProtectEdit,
	reportProtectAddPage,
	pageLocks,
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
	// The page a removal is being confirmed for. Deleting a page takes every
	// visual on it with it, and the control is a small cross on a tab, so it
	// asks first.
	const [confirmingPage, setConfirmingPage] = useState<{
		pageId: string;
		title: string;
	} | null>(null);
	const [removingPage, setRemovingPage] = useState(false);
	const [protecting, setProtecting] = useState(false);
	const [savingProtection, setSavingProtection] = useState(false);
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

	const { user } = useUser();
	const history = useEditorHistory<EditorSnapshot>();

	// The order the strip is showing, which leads the saved order while a
	// reorder is pending. Reset when the report reloads, so a save that lands
	// hands control back to what the server says.
	const [pageOrder, setPageOrder] = useState<string[] | null>(null);
	useEffect(() => {
		setPageOrder(null);
	}, [version]);

	// A page added here and not yet written.
	//
	// It lives in this component rather than on the server, so adding one is
	// instant and an author builds it before anybody else can open it. Nothing
	// is created until the save, which is the same batch every other edit rides.
	//
	// One at a time. The strip refuses to switch page while there are unsaved
	// changes, and a draft is always an unsaved change, so a second one could
	// only be reached by discarding the first.
	const [draftPage, setDraftPage] = useState<{
		pageId: string;
		title: string;
	} | null>(null);

	// What the page being edited refuses. A draft has not been written, so there
	// is nothing to lock it against yet; everything else takes what the server
	// says.
	const locks = draftPage
		? { protectDelete: false, protectEdit: false }
		: { protectDelete, protectEdit };

	// Which page the editor is actually showing. The prop names the page the
	// parent loaded; a draft is one the parent has never heard of, and every
	// operation this session writes has to carry the draft's id or it would
	// attach to the page the author was on when they added it.
	const activePageId = draftPage?.pageId ?? pageId;

	// Applied to the prop rather than replacing it, so a page added or removed
	// while a reorder is pending still appears.
	const orderedPages = useMemo(() => {
		// A draft sits at the end, where a new page goes. A page that was
		// removed is already gone from the props, because removing one writes
		// it rather than queueing it.
		const live = draftPage ? [...pages, draftPage] : pages;
		if (!pageOrder) return live;
		const rank = new Map(pageOrder.map((id, i) => [id, i]));
		return [...live].sort(
			(a, b) =>
				(rank.get(a.pageId) ?? Number.MAX_SAFE_INTEGER) -
				(rank.get(b.pageId) ?? Number.MAX_SAFE_INTEGER),
		);
	}, [pages, pageOrder, draftPage]);

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
	// Read when a snapshot is taken, which happens inside a gesture rather
	// than during a render, so these have to be current rather than captured.
	const pageConfigRef = useRef(pageConfig);
	pageConfigRef.current = pageConfig;
	const pageTitleRef = useRef(pageTitle);
	pageTitleRef.current = pageTitle;
	const descriptionRef = useRef(description);
	descriptionRef.current = description;
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

				// No notice. A remote change lands on the canvas, and who
				// made it is what the History tab is for. The avatars in the
				// toolbar already say somebody else is in here, which is the
				// part that is worth knowing while arranging.
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
		// Off while a draft is open. The draft is not on the server, so there
		// is nothing to sync with, and the stream for the page the author came
		// from would replace the blank canvas with that page's visuals.
		enabled: !draftPage,
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

	// Everything an undo puts back: what is on the page, and the settings that
	// belong to the page and the report. Not the selection or the zoom, which
	// are where the author is looking rather than what they have changed.
	const snapshot = useCallback(
		(): EditorSnapshot => ({
			visuals: visualsRef.current,
			pageConfig: pageConfigRef.current,
			pageTitle: pageTitleRef.current,
			description: descriptionRef.current,
		}),
		[],
	);

	// Taken before the edit rather than after it, so the first undo goes back
	// to what the author could see when they decided to act.
	const record = useCallback(
		(coalesceKey?: string) => {
			history.record(snapshot(), coalesceKey);
		},
		[history, snapshot],
	);

	// Putting the canvas back, and putting the pending operations back with it.
	//
	// The operations have to end up describing what is now on screen or the
	// next save writes the change that was just undone. Which operation each
	// visual needs turns on whether the server has ever seen it, which is what
	// opsForRestore works out.
	const restore = useCallback(
		(target: EditorSnapshot) => {
			const current = visualsRef.current;

			for (const op of opsForRestore(current, target.visuals)) {
				if (op.kind === "cancel") {
					pendingRef.current.delete(op.visualId);
					continue;
				}
				if (op.kind === "add") {
					const visual = target.visuals.find(
						(v) => v.visualId === op.visualId,
					);
					if (visual) markPending({ type: "addVisual", visual });
					continue;
				}
				markPending(
					op.kind === "remove"
						? { type: "removeVisual", visualId: op.visualId }
						: { type: "updateVisual", visualId: op.visualId },
				);
			}

			setVisuals(target.visuals);
			setPageConfig(target.pageConfig);
			setPageTitle(target.pageTitle);
			setDescription(target.description);
			markPending({ type: "updatePage" });
			markPending({ type: "updateReport" });

			// A visual that is no longer there cannot stay selected, and the
			// panel would be editing something the page does not hold.
			setSelectedId((id) =>
				id && target.visuals.some((v) => v.visualId === id) ? id : null,
			);
			setDirty(true);
		},
		[markPending, record],
	);

	const undo = useCallback(() => {
		const target = history.undo(snapshot());
		if (target) restore(target);
	}, [history, snapshot, restore]);

	const redo = useCallback(() => {
		const target = history.redo(snapshot());
		if (target) restore(target);
	}, [history, snapshot, restore]);

	const updateVisual = useCallback(
		(next: EditableVisual) => {
			if (locks.protectEdit) return;
			record(`visual:${next.visualId}`);
			setVisuals((prev) =>
				prev.map((v) => (v.visualId === next.visualId ? next : v)),
			);
			markPending({ type: "updateVisual", visualId: next.visualId });
			setDirty(true);
		},
		[markPending, record],
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
			// The one path that was not guarded. Typing queued an operation
			// that the server would refuse, so an author could fill a panel and
			// lose the whole batch at the save rather than being stopped here.
			if (locks.protectEdit) return;
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
		[markPending, record],
	);

	const changeLayout = useCallback(
		(visualId: string, rect: Rect) => {
			if (locks.protectEdit) return;
			// One snapshot per gesture: the drag commits once, on release.
			record();
			setVisuals((prev) =>
				prev.map((v) =>
					v.visualId === visualId ? { ...v, layout: rect } : v,
				),
			);
			markPending({ type: "updateVisual", visualId });
			setDirty(true);
		},
		[markPending, record],
	);

	const addVisual = useCallback(
		(type: string) => {
			if (locks.protectEdit) return;
			const definition = visualByType[type];
			if (!definition) return;

			const slot = findFreeSlot(
				visuals.map((v) => v.layout),
				definition.defaultLayout.w,
				definition.defaultLayout.h,
			);

			// A new visual inherits the page source, which is what an author
			// almost always wants and saves a step.
			record();
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
		[visuals, sources, markPending, record],
	);

	// Moving a control along the filter strip.
	//
	// A control is not on the grid, so there is no rectangle to drag: its place
	// is its position in the page order. Swapping it with its neighbour writes
	// the whole page order, which is what the operation takes, and leaves every
	// placed visual where it was.
	const moveControl = useCallback(
		(visualId: string, delta: -1 | 1) => {
			record();
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
		[visuals, markPending, record],
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
			record();
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
		[markPending, record],
	);

	const removeVisual = useCallback(
		(visualId: string) => {
			if (locks.protectEdit) return;
			// A group taken off the page lets go of what it held rather than
			// taking it with it. Deleting one visual should never delete ten,
			// and a child left naming a group that no longer exists is laid out
			// against a box that is not there.
			//
			// The rectangles are the group's, not the page's, so each one is
			// put back on the page at the position the group occupied. That is
			// not where they were, but it is where the author was looking, and
			// it is somewhere rather than piled on the origin.
			record();
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
		[visuals, markPending, record],
	);

	// A visual copied from the canvas.
	//
	// Held here rather than on the system clipboard. What is copied is a
	// definition, not text, and putting it on the system clipboard would mean
	// either pasting unreadable JSON into whatever the author next focuses or
	// reading arbitrary text back in and trusting it.
	const clipboardRef = useRef<EditableVisual | null>(null);

	const copyVisual = useCallback(() => {
		const visual = visualsRef.current.find(
			(v) => v.visualId === selectedId,
		);
		if (!visual) return;
		clipboardRef.current = visual;
	}, [selectedId]);

	const pasteVisual = useCallback(() => {
		const source = clipboardRef.current;
		if (!source) return;

		record();

		// A copy is its own visual: a new id, and a place of its own rather
		// than sitting exactly on top of the one it came from. A copy taken
		// from inside a group is pasted into that group, since that is where
		// its rectangle is measured from and anywhere else would move it.
		const parentId =
			typeof source.config.parentId === "string"
				? source.config.parentId
				: null;
		const siblings = visualsRef.current.filter((v) =>
			parentId
				? v.config.parentId === parentId
				: typeof v.config.parentId !== "string",
		);

		const visual: EditableVisual = {
			...source,
			visualId:
				typeof crypto !== "undefined"
					? crypto.randomUUID()
					: `copy-${Date.now()}`,
			title: source.title ? `${source.title} copy` : null,
			config: structuredClone(source.config),
			layout: findFreeSlot(
				siblings.map((v) => v.layout),
				source.layout.w,
				source.layout.h,
			),
			isNew: true,
		};

		setVisuals((prev) => [...prev, visual]);
		markPending({ type: "addVisual", visual });
		setSelectedId(visual.visualId);
		setDirty(true);
	}, [markPending, record]);

	// The shortcuts an author expects of anything they arrange things on.
	//
	// Ignored while somebody is typing: the panel is full of text fields and a
	// selected text panel is a live editable region, so copying a word out of a
	// title must not copy the visual and undoing a typo must not undo the last
	// thing that was dragged.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey)) return;
			if (isTypingTarget(event.target)) return;

			const key = event.key.toLowerCase();

			// Redo is both spellings. Ctrl+Y is what Windows editors use and
			// Shift+Z is what everything else does, and an author who reaches
			// for the wrong one is not asking for something different.
			if (key === "y" || (key === "z" && event.shiftKey)) {
				event.preventDefault();
				redo();
				return;
			}
			if (key === "z") {
				event.preventDefault();
				undo();
				return;
			}
			if (key === "c") {
				event.preventDefault();
				copyVisual();
				return;
			}
			if (key === "v") {
				event.preventDefault();
				pasteVisual();
			}
		};

		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [undo, redo, copyVisual, pasteVisual]);

	const save = useCallback(async () => {
		if (pendingRef.current.size === 0) return;
		// Everything in the history describes unsaved work, and the operations
		// an undo produces are only valid against the version the editor
		// loaded. Once a save has moved that version, putting back a visual the
		// server has since deleted would insert a row rather than restore one.
		history.clear();
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
					pageId: activePageId,
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
					pageId: activePageId,
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
					pageId: activePageId,
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
			// The draft is a real page now. Opening it hands the editor back to
			// the parent's data, which is where every other page comes from,
			// and the local copy stops being the source of truth for it.
			const draftId = draftPage?.pageId;
			if (draftId) {
				setDraftPage(null);
				onSaved();
				onSelectPage(draftId);
				return;
			}
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
		activePageId,
		pageSourceKey,
		visuals,
		pageConfig,
		pageTitle,
		description,
		onSaved,
	]);

	const others = live.others;

	// Which visual each other editor has selected, so the canvas can show it.
	// Removing a page, once the author has said so.
	//
	// A draft was never written, so dropping it is local and instant. A real
	// page is written straight away rather than queued: removal is only offered
	// for the page being edited, so it is followed by moving to another page,
	// and moving remounts this component. A queued operation would go with it.
	// Only an administrator sees the way in. The capability is checked again on
	// the server, which is what actually decides.
	const canProtect = user?.capabilities?.includes("page.protect") ?? false;

	// Writing whichever locks the dialog changed.
	//
	// Takes a list rather than one, because the per-page tab can change several
	// at once and sending them as one batch means the author's Save is one act
	// that either lands or does not, rather than four writes with the third
	// failing.
	const saveProtection = useCallback(
		async (
			writes: {
				action: "protectReport" | "protectPage";
				pageId?: string;
				protectDelete: boolean;
				protectEdit: boolean;
			}[],
		) => {
			if (writes.length === 0) return;
			setSavingProtection(true);
			try {
				for (const write of writes) {
					const response = await fetch("/api/authoring", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							...write,
							...(write.action === "protectReport"
								? { reportId }
								: {}),
						}),
					});
					if (!response.ok) {
						const detail = await response.json().catch(() => null);
						setConflict(
							detail?.error ?? "Could not change the protection.",
						);
						return;
					}
				}

				// The lock lives on the server, so the editor takes it back
				// from there rather than keeping a second copy of it. Closed
				// once it has landed, because leaving it open on values the
				// props have already replaced is what made a save look like it
				// had done nothing.
				await onSaved();
				setProtecting(false);
			} finally {
				setSavingProtection(false);
			}
		},
		[reportId, onSaved],
	);

	const removePage = useCallback(async () => {
		const target = confirmingPage;
		if (!target) return;

		if (target.pageId === draftPage?.pageId) {
			pendingRef.current.delete(`page:${target.pageId}`);
			setDraftPage(null);
			setConfirmingPage(null);
			// Back to the page the parent has loaded, which the editor is
			// still holding the props for.
			setVisuals(initialVisuals);
			setPageConfig(initialPageConfig);
			setPageTitle(initialPageTitle);
			setSelectedId(null);
			history.clear();
			setDirty(pendingRef.current.size > 0);
			return;
		}

		setRemovingPage(true);
		try {
			pendingRef.current.set(`page:${target.pageId}`, {
				type: "removePage",
				pageId: target.pageId,
			});
			await save();
			// Cleared only by a save that landed. A conflict leaves the removal
			// queued and says so, and stepping to another page now would take
			// the operation with it.
			if (pendingRef.current.size > 0) return;

			setConfirmingPage(null);
			await onSaved();
			if (target.pageId === activePageId) {
				const next = orderedPages.find(
					(candidate) => candidate.pageId !== target.pageId,
				);
				if (next) onSelectPage(next.pageId);
			}
		} finally {
			setRemovingPage(false);
		}
	}, [
		confirmingPage,
		draftPage,
		activePageId,
		orderedPages,
		initialVisuals,
		initialPageConfig,
		initialPageTitle,
		history,
		save,
		onSaved,
		onSelectPage,
	]);

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
					disabled={locks.protectEdit}
					title={
						locks.protectEdit
							? "This page is protected against changes."
							: undefined
					}
					aria-expanded={pickerOpen}
				>
					+ Add visual
				</button>

				{/* What this page refuses, stated rather than left to be
				    inferred from controls that quietly do nothing. An editor
				    cannot lift it, so this says who can. */}
				{(locks.protectEdit ||
					locks.protectDelete ||
					reportProtectAddPage) && (
					<span
						className={styles.lockNotice}
						role="status"
						title="Set by an administrator under Report settings."
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
							<rect x="4" y="11" width="16" height="10" rx="2" />
							<path d="M8 11V7a4 4 0 0 1 8 0v4" />
						</svg>
						{"Locked: " +
							[
								locks.protectEdit ? "read-only" : null,
								locks.protectDelete
									? "cannot be deleted"
									: null,
								reportProtectAddPage ? "no new pages" : null,
							]
								.filter(Boolean)
								.join(", ")}
					</span>
				)}

				<span className={styles.divider} aria-hidden="true" />

				{/* Also on the toolbar, not only on the keyboard. A shortcut
				    nothing announces is a shortcut only the person who added it
				    knows about, and the disabled state is the only thing that
				    says whether there is anything to go back to. */}
				<button
					type="button"
					className={styles.iconTool}
					onClick={undo}
					disabled={!history.canUndo}
					title="Undo (Ctrl+Z)"
					aria-label="Undo"
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
						<path d="M9 14 4 9l5-5" />
						<path d="M4 9h10a6 6 0 0 1 0 12h-3" />
					</svg>
				</button>
				<button
					type="button"
					className={styles.iconTool}
					onClick={redo}
					disabled={!history.canRedo}
					title="Redo (Ctrl+Y)"
					aria-label="Redo"
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
						<path d="m15 14 5-5-5-5" />
						<path d="M20 9H10a6 6 0 0 0 0 12h3" />
					</svg>
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

			{protecting && (
				<ProtectDialog
					reportTitle={reportTitle}
					report={{
						protectDelete: reportProtectDelete,
						protectEdit: reportProtectEdit,
						protectAddPage: reportProtectAddPage,
					}}
					pages={pageLocks}
					busy={savingProtection}
					onSaveReport={(next) =>
						saveProtection([{ action: "protectReport", ...next }])
					}
					onSavePages={(changed) =>
						saveProtection(
							changed.map((page) => ({
								action: "protectPage" as const,
								pageId: page.pageId,
								protectDelete: page.protectDelete,
								protectEdit: page.protectEdit,
							})),
						)
					}
					onClose={() => setProtecting(false)}
				/>
			)}

			{confirmingPage && (
				<ConfirmDialog
					title="Delete this page"
					body={
						<>
							<strong>{confirmingPage.title}</strong> and every
							visual on it will be removed from this report.
							{confirmingPage.pageId === draftPage?.pageId
								? " It has not been saved, so nothing else will change."
								: " Anyone who could open it loses it."}
						</>
					}
					confirmLabel="Delete page"
					busy={removingPage}
					onConfirm={removePage}
					onCancel={() => setConfirmingPage(null)}
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
						// Nothing is written. The page appears in the strip
						// straight away, opens blank, and takes edits like any
						// other page; the save creates it and everything built
						// on it in the same batch.
						//
						// An author asked for a page so they could work on it,
						// not so that an empty one would appear to everybody
						// else while they think about what goes on it.
						const newId =
							typeof crypto !== "undefined"
								? crypto.randomUUID()
								: String(Date.now());
						pendingRef.current.set(`page:${newId}`, {
							type: "addPage",
							pageId: newId,
							title,
						});
						setDraftPage({ pageId: newId, title });
						setVisuals([]);
						setPageConfig({});
						setPageTitle(title);
						setSelectedId(null);
						// A page that has not been written cannot be undone
						// back past its own creation.
						history.clear();
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
				activePageId={activePageId}
				// Neither removal nor addition is offered at all rather than
				// offered and refused, and the lock notice above says why.
				canRemove={!locks.protectDelete}
				canAdd={!reportProtectAddPage}
				dirty={dirty}
				onSelect={onSelectPage}
				onAdd={() => setAddingPage(true)}
				onRemove={(removeId) => {
					const page = orderedPages.find(
						(candidate) => candidate.pageId === removeId,
					);
					setConfirmingPage({
						pageId: removeId,
						title: page?.title ?? "this page",
					});
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
					readOnly={locks.protectEdit}
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
					readOnly={locks.protectEdit}
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

							{/* Who may change what, above the control that
							    would be refused by it. Only an administrator
							    sees the way in; the capability is checked
							    again on the server, which decides. */}
							{(canProtect ||
								reportProtectDelete ||
								reportProtectEdit ||
								pageLocks.some(
									(p) => p.protectDelete || p.protectEdit,
								)) && (
								<Section
									id="report-protection"
									title="Protection"
									count={
										pageLocks.filter(
											(p) =>
												p.protectDelete ||
												p.protectEdit,
										).length +
										(reportProtectDelete ? 1 : 0) +
										(reportProtectEdit ? 1 : 0)
									}
								>
									{describe({
										protectDelete: reportProtectDelete,
										protectEdit: reportProtectEdit,
									}).map((line) => (
										<Hint key={line}>{line}</Hint>
									))}
									{!reportProtectDelete &&
										!reportProtectEdit && (
											<Hint>
												Nothing is locked at the report
												level. Individual pages may
												still be.
											</Hint>
										)}
									<button
										type="button"
										className={`${styles.saveButton} ${styles.sectionButton}`}
										onClick={() => setProtecting(true)}
										disabled={!canProtect}
										title={
											canProtect
												? undefined
												: "Only an administrator can change this."
										}
									>
										{canProtect
											? "Change protection"
											: "Protection is set by an administrator"}
									</button>
								</Section>
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
