"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	canvasRows,
	fillToViewport,
	stackForNarrow,
	gridColumns,
	gridGap,
	measureCanvas,
	overlaps,
	rectToPixels,
	rowHeight,
	wouldLoop,
	type CanvasMetrics,
	type Rect,
} from "../../lib/visuals/layout";
import { VisualRenderer } from "../visuals/VisualRenderer";
import { FilterBar } from "../visuals/FilterWidgets";
import {
	fillsHeight,
	isPageControl,
	optionValue,
	visualByType,
} from "../../lib/visuals/catalog";
import { TextPanel } from "../visuals/TextPanel";
import type { SourceMeta } from "../visuals/types";
import { GroupFrame } from "../visuals/GroupFrame";
import { useDragResize, type GestureKind } from "./useDragResize";
import { toVisualSpec, type EditableVisual } from "./types";
import styles from "./Editor.module.css";

// The editing canvas.
//
// Visuals are absolutely positioned on a twelve column grid and moved by
// pointer gestures. Placement is free-form: an author can put a visual
// anywhere, including overlapping another, because rearranging a page is a
// judgement they are making and a reflow algorithm would fight them. Overlap
// is flagged rather than prevented.
//
// Visuals still render their real data while being arranged, so the author is
// laying out the actual page rather than grey boxes. Their internal
// interactions are disabled, so a click selects the visual instead of
// cross-filtering the page underneath. That is also what makes the whole
// visual its own drag target: there is nothing inside one for a press to mean
// instead. It used to be a 34 pixel strip along the top edge, invisible and
// unlabelled, which meant a press anywhere else selected the visual and then
// did nothing while the pointer moved.
//
// Page controls are not on the grid. A reader sees a filter lifted into a
// strip above the content, sized by what it contains, so the editor shows them
// the same way. Giving a filter a grid box meant the editor clipped it to a
// height that had nothing to do with how it would render, which is why a
// filter group looked like a single dropdown here and a full row of them to
// the reader.

// Widths worth checking, and why each one.
//
// A preview is a width, not a device: the layout responds to how much room it
// has and nothing else. Named after the devices anyway, because "390" means
// nothing to an author and "phone" does.
export interface PreviewWidth {
	id: string;
	label: string;
	width: number | null;
	note: string;
}

export const previewWidths: PreviewWidth[] = [
	{
		id: "fit",
		label: "Fit",
		width: null,
		note: "However much room the editor has",
	},
	{
		id: "laptop",
		label: "Laptop",
		width: 1440,
		note: "What most people are on",
	},
	{
		id: "small-laptop",
		label: "Small laptop",
		width: 1280,
		note: "Where a twelve column page starts to feel tight",
	},
	{
		id: "tablet",
		label: "Tablet",
		width: 1024,
		note: "Still the full grid, with much less of it",
	},
	{
		id: "phone",
		label: "Phone",
		width: 390,
		note: "Below the stacking width, so the page becomes one column",
	},
];

interface EditorCanvasProps {
	visuals: EditableVisual[];
	sources: Record<string, SourceMeta>;
	selectedId: string | null;
	zoom: number;
	onSelect: (visualId: string | null) => void;
	onLayoutChange: (visualId: string, rect: Rect) => void;
	// Reported so the editor can protect a visual from remote edits while a
	// gesture on it is in progress.
	onGestureStart?: (visualId: string) => void;
	onGestureEnd?: (visualId: string) => void;
	// Visual id to the person who has it selected, so an author can see what
	// someone else is working on before they both change it.
	remoteSelections?: Map<string, string>;
	// A text panel is edited in place rather than through the side panel, so
	// its content changes come back through here.
	onContentChange?: (visualId: string, html: string) => void;
	// Controls are not on the grid, so they cannot be dragged. Moving one means
	// moving it along the strip, which is what this reports.
	onMoveControl?: (visualId: string, delta: -1 | 1) => void;
	// Opens the picker at the filter category. The strip is where controls end
	// up, so it is where asking for one belongs.
	onAddControl?: () => void;
	// A visual dropped onto a group, or taken out of one. Reported apart from a
	// plain move because it changes what holds the visual as well as where it
	// sits, and the two have to be written together or the page renders a
	// rectangle against the wrong box.
	onReparent?: (
		visualId: string,
		parentId: string | null,
		rect: Rect,
	) => void;
	// A fixed width to lay the canvas out at, for checking a narrower screen.
	// Null measures the available space, which is the normal case.
	previewWidth?: number | null;
}

export function EditorCanvas({
	visuals,
	sources,
	selectedId,
	zoom,
	onSelect,
	onLayoutChange,
	onGestureStart,
	onGestureEnd,
	remoteSelections,
	onContentChange,
	onMoveControl,
	onAddControl,
	onReparent,
	previewWidth = null,
}: EditorCanvasProps) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(1200);

	// The canvas measures itself rather than assuming a width, so the grid is
	// correct at any window size and inside any panel arrangement.
	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (!element) return;

		const measure = () => {
			const padding = 32;
			setWidth(Math.max(320, element.clientWidth - padding));
			setViewportHeight(Math.max(0, element.clientHeight - padding));
		};

		measure();

		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// How much of the canvas viewport is left below the grid, so a visual set
	// to fill can be shown filling it here rather than only once published.
	const [viewportHeight, setViewportHeight] = useState(0);
	// A preview pins the width instead of measuring it, so the grid is laid out
	// for the screen being checked rather than for the editor window.
	const layoutWidth = previewWidth ?? width / zoom;
	const metrics = measureCanvas(layoutWidth);
	// The published page stacks below this, and the canvas has to agree or the
	// preview would show a grid the reader never gets.
	const stacked = previewWidth !== null && previewWidth < 900;
	// The group holding a visual, or nothing. Read by the loop guard, which has
	// to walk the whole chain rather than compare two ends.
	const parentOfId = (id: string): string | null => {
		const parent = visuals.find((v) => v.visualId === id)?.config.parentId;
		return typeof parent === "string" ? parent : null;
	};

	// Where a released visual lands.
	//
	// A move that finishes over a group puts the visual in it, which is the
	// gesture an author reaches for first. The rectangle is rewritten as the
	// group measures it: the same fraction of the width it covered on the page,
	// so a visual half the page wide arrives half the group wide rather than
	// spilling out of it.
	const commit = (id: string, rect: Rect) => {
		const moving = visuals.find((v) => v.visualId === id);
		if (!moving) return;

		const currentParent =
			typeof moving.config.parentId === "string"
				? moving.config.parentId
				: null;

		// Only a visual on the page can be dropped into something. One already
		// inside a group is measured against that group, so its rectangle says
		// nothing about where it is on the page, and it leaves through the
		// panel instead.
		const landed = currentParent ? null : groupUnder(id, rect);
		if (landed === currentParent) {
			onLayoutChange(id, rect);
			return;
		}

		onReparent?.(id, landed, {
			...rect,
			// Dropped into a group it starts at the group's origin, because the
			// page coordinates it was dragged at mean nothing inside one.
			x: 0,
			y: 0,
		});
	};

	// The group a rectangle has been dropped onto: the innermost one whose box
	// contains the rectangle's top left corner, so dropping onto a group inside
	// a group lands in the one actually under the pointer.
	const groupUnder = (movingId: string, rect: Rect): string | null => {
		let found: string | null = null;
		for (const candidate of visuals) {
			if (candidate.visualType !== "group") continue;
			if (candidate.visualId === movingId) continue;
			// Only groups on the page are drop targets. One nested inside
			// another is drawn against its parent's grid, so its rectangle is
			// not comparable with a page rectangle.
			if (typeof candidate.config.parentId === "string") continue;

			const box = candidate.layout;
			const inside =
				rect.x >= box.x &&
				rect.x < box.x + box.w &&
				rect.y >= box.y &&
				rect.y < box.y + box.h;
			if (!inside) continue;
			if (wouldLoop(movingId, candidate.visualId, parentOfId)) continue;
			found = candidate.visualId;
		}
		return found;
	};

	const { state, begin, move, end, cancel } = useDragResize({
		metrics,
		zoom,
		onCommit: commit,
	});

	// A gesture marks its visual as in progress for as long as it runs, so a
	// remote edit to the same visual waits rather than fighting the pointer.
	const startGesture = (
		event: React.PointerEvent,
		kind: GestureKind,
		id: string,
		rect: Rect,
		gridMetrics: CanvasMetrics,
	) => {
		onGestureStart?.(id);
		begin(event, kind, id, rect, gridMetrics);
	};

	const finishGesture = (event: React.PointerEvent, id: string) => {
		end(event);
		onGestureEnd?.(id);
	};

	// While a gesture is running the dragged visual uses the live rectangle
	// and everything else uses its stored one.
	const rectFor = (visual: EditableVisual): Rect =>
		state && state.id === visual.visualId ? state.rect : visual.layout;

	// What holds what.
	//
	// A visual names its group, so the page is grouped by reading that rather
	// than by any list a group keeps. A parent that is missing, or that is not
	// a group, leaves its children where they are: a visual nobody can see is
	// worse than one in the wrong place, and that is exactly what a half
	// applied delete would otherwise produce.
	const byId = new Map(visuals.map((v) => [v.visualId, v]));
	const parentOf = (id: string): string | null => {
		const parent = byId.get(id)?.config.parentId;
		if (typeof parent !== "string") return null;
		return byId.get(parent)?.visualType === "group" ? parent : null;
	};

	const childrenOf = new Map<string, EditableVisual[]>();
	const loose: EditableVisual[] = [];
	for (const visual of visuals) {
		const parent = parentOf(visual.visualId);
		if (!parent) {
			loose.push(visual);
			continue;
		}
		const held = childrenOf.get(parent) ?? [];
		held.push(visual);
		childrenOf.set(parent, held);
	}

	// Controls come out of the grid entirely and sit in a strip, in the
	// reading order an author gave them. One inside a group is laid out by the
	// group instead, which is what a group of filters is.
	const controls = loose.filter((v) => isPageControl(v.visualType));
	const placed = loose.filter((v) => !isPageControl(v.visualType));

	// The same fill the published page applies, so an author sees the height
	// a reader will get rather than a box that grows after they publish. A
	// visual being dragged keeps its own rectangle, since growing under the
	// pointer would fight the gesture.
	// A narrow preview collapses to one column exactly as the published page
	// does, so what an author checks is what a reader gets rather than a
	// squeezed version of the wide layout.
	const stackedRects = stacked
		? new Map(
				stackForNarrow(
					placed.map((v) => ({ id: v.visualId, rect: rectFor(v) })),
				).map((i) => [i.id, i.rect]),
			)
		: null;

	const displayRects = new Map<string, Rect>(
		fillToViewport(
			placed.map((v) => ({
				id: v.visualId,
				rect: stackedRects?.get(v.visualId) ?? rectFor(v),
				canFill:
					!stacked &&
					state?.id !== v.visualId &&
					fillsHeight(
						v.visualType,
						v.config.options as Record<string, unknown>,
					),
			})),
			// Measured inside the canvas, which is where the page ends here.
			viewportHeight / zoom,
		).map((i) => [i.id, i.rect]),
	);

	const displayRectFor = (visual: EditableVisual): Rect =>
		displayRects.get(visual.visualId) ?? rectFor(visual);

	// The group a visual being dragged would land in if released now, so the
	// canvas can say where it is going before it gets there.
	const dropTargetId =
		state?.kind === "move" &&
		!visuals.find((v) => v.visualId === state.id)?.config.parentId
			? groupUnder(state.id, state.rect)
			: null;

	const itemContext: ItemContext = {
		selectedId,
		sources,
		draggingId: state?.id ?? null,
		dropTargetId,
		childrenOf,
		remoteSelections,
		onSelect,
		onContentChange,
		startGesture,
		finishGesture,
		move,
		cancel,
		rectFor,
	};

	const rows = canvasRows(placed.map(displayRectFor));
	const canvasHeight = rows * (rowHeight + gridGap);

	// Deselect on Escape, which is the expected way out of a selection.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onSelect(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onSelect]);

	if (visuals.length === 0) {
		return (
			<div className={styles.canvasScroll} ref={scrollRef}>
				<div className={styles.emptyCanvas}>
					<span className={styles.emptyTitle}>
						This page is empty
					</span>
					<span>Add a visual from the toolbar to begin.</span>
				</div>
			</div>
		);
	}

	return (
		<div
			className={styles.canvasScroll}
			ref={scrollRef}
			// A click on the canvas background clears the selection, which is
			// how an author gets back to the page-level panel.
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) onSelect(null);
			}}
		>
			{/* Drawn even with nothing in it.

			    It used to appear only once a control existed, and the only way
			    to make one exist was to know that a filter added from the
			    toolbar would land somewhere other than the grid. An empty
			    strip that says what it is for is how an author finds out. */}
			{(controls.length > 0 || onAddControl) && (
				// Sized by its contents rather than by the grid, exactly as
				// the reader will see it, and scaled with the canvas so zoom
				// applies to the whole page rather than to half of it.
				<div
					className={styles.controlStrip}
					style={{
						width: metrics.width,
						// CSS zoom rather than a transform, so the strip's real
						// height changes with it. A transform would leave the
						// original box behind and the canvas would slide under
						// the strip at anything but 100%.
						zoom,
					}}
				>
					{/* Says what the bar is. The bar is the reader's filter
					    strip drawn at full width, and the controls inside it
					    are the parts an author can select, so without this the
					    outline hugging one small dropdown inside a wide box
					    reads as a selection that missed. */}
					<div className={styles.stripCaption}>
						Filter strip
						<span className={styles.stripNote}>
							{controls.length === 0
								? "Nothing here yet. A filter added here sits above the page rather than on the grid."
								: "Above the page, ordered along the strip. Controls do not respond here, so a click selects one instead of filtering the page. To put several behind one button, add a Group and drag them onto it."}
						</span>
						{onAddControl && (
							<button
								type="button"
								className={styles.stripAdd}
								onClick={onAddControl}
							>
								Add a filter
							</button>
						)}
					</div>

					<FilterBar>
						{controls.length === 0 && (
							<span className={styles.stripEmpty}>
								No page controls
							</span>
						)}
						{controls.map((visual, index) => (
							<ControlSlot
								key={visual.visualId}
								visual={visual}
								index={index}
								total={controls.length}
								selectedId={selectedId}
								sources={sources}
								remoteBy={remoteSelections?.get(
									visual.visualId,
								)}
								onSelect={onSelect}
								onMoveControl={onMoveControl}
							/>
						))}
					</FilterBar>
				</div>
			)}

			<div
				className={`${styles.canvas} ${state ? "" : styles.canvasQuiet} ${
					previewWidth !== null ? styles.canvasPreview : ""
				}`}
				style={{
					width: metrics.width,
					height: canvasHeight,
					transform: `scale(${zoom})`,
					// The scaled canvas still has to reserve its unscaled space
					// in the scroller, or the scrollbars would be wrong.
					marginBottom: canvasHeight * (zoom - 1),
					marginRight: metrics.width * (zoom - 1),
					backgroundSize: `${metrics.columnWidth + gridGap}px ${rowHeight + gridGap}px`,
				}}
			>
				{placed.map((visual) => (
					<CanvasItem
						key={visual.visualId}
						visual={visual}
						rect={rectFor(visual)}
						pixels={rectToPixels(displayRectFor(visual), metrics)}
						metrics={metrics}
						clashes={placed.some(
							(other) =>
								other.visualId !== visual.visualId &&
								overlaps(rectFor(visual), rectFor(other)),
						)}
						ctx={itemContext}
					/>
				))}
			</div>
		</div>
	);
}

// The context every item on the canvas needs, gathered once rather than
// threaded through as a dozen props. An item inside a group is the same
// component as one on the page, so both are handed the same thing.
interface ItemContext {
	selectedId: string | null;
	sources: Record<string, SourceMeta>;
	draggingId: string | null;
	// The group a visual being dragged would land in if released now.
	dropTargetId: string | null;
	childrenOf: Map<string, EditableVisual[]>;
	remoteSelections?: Map<string, string>;
	onSelect: (visualId: string | null) => void;
	onContentChange?: (visualId: string, html: string) => void;
	startGesture: (
		event: React.PointerEvent,
		kind: GestureKind,
		id: string,
		rect: Rect,
		metrics: CanvasMetrics,
	) => void;
	finishGesture: (event: React.PointerEvent, id: string) => void;
	move: (event: React.PointerEvent) => void;
	cancel: () => void;
	rectFor: (visual: EditableVisual) => Rect;
}

// One visual on the canvas, wherever it sits.
//
// A group renders its own children through this same component, measured
// against the grid the group hands down rather than the page's. That is the
// whole of what nesting costs here: the box a rectangle is measured from
// changes, and nothing else does.
function CanvasItem({
	visual,
	rect,
	pixels,
	metrics,
	clashes,
	ctx,
}: {
	visual: EditableVisual;
	// The stored rectangle, which drives the gestures. The displayed one drives
	// the box, so a visual set to fill is dragged by what the author set rather
	// than by what the fill produced.
	rect: Rect;
	pixels: { left: number; top: number; width: number; height: number };
	// The grid this item is laid out on: the page's, or its group's.
	metrics: CanvasMetrics;
	clashes: boolean;
	ctx: ItemContext;
}) {
	const isSelected = ctx.selectedId === visual.visualId;
	const isDragging = ctx.draggingId === visual.visualId;
	const isGroup = visual.visualType === "group";
	const isDropTarget = ctx.dropTargetId === visual.visualId;

	// A selected text panel is a text field: its body takes real clicks, so it
	// cannot also be the drag target and keeps a bar of its own at the head.
	const editingText = visual.visualType === "textPanel" && isSelected;

	const held = ctx.childrenOf.get(visual.visualId) ?? [];
	const remoteBy = ctx.remoteSelections?.get(visual.visualId);

	return (
		<div
			className={`${styles.item} ${isSelected ? styles.itemSelected : ""} ${
				isDragging ? styles.itemDragging : ""
			} ${editingText ? "" : styles.itemDraggable} ${
				isDropTarget ? styles.itemDropTarget : ""
			}`}
			style={{
				left: pixels.left,
				top: pixels.top,
				width: pixels.width,
				height: pixels.height,
			}}
			onPointerDown={(e) => {
				ctx.onSelect(visual.visualId);
				if (!editingText) {
					ctx.startGesture(e, "move", visual.visualId, rect, metrics);
				}
			}}
			// A press that does not travel commits nothing, so selecting and
			// moving are the same gesture without a click marking the report
			// dirty. The grips start their own gesture and stop the event
			// there, so a resize never reads as a move.
			onPointerMove={ctx.move}
			onPointerUp={(e) => ctx.finishGesture(e, visual.visualId)}
			onPointerCancel={ctx.cancel}
			role="button"
			tabIndex={0}
			aria-label={`${visual.title ?? visual.visualType}${
				editingText ? "" : ", drag to move"
			}`}
		>
			{editingText && (
				<div
					className={styles.dragBar}
					onPointerDown={(e) =>
						ctx.startGesture(
							e,
							"move",
							visual.visualId,
							rect,
							metrics,
						)
					}
					onPointerMove={ctx.move}
					onPointerUp={(e) => ctx.finishGesture(e, visual.visualId)}
					onPointerCancel={ctx.cancel}
					role="button"
					tabIndex={0}
					aria-label={`Move ${visual.title ?? visual.visualType}`}
				>
					<span className={styles.dragGrip} aria-hidden="true" />
				</div>
			)}

			{clashes && (
				<span className={styles.overlapWarning}>overlapping</span>
			)}

			{remoteBy && (
				<span className={styles.remoteBadge}>
					{remoteBy.split("@")[0]}
				</span>
			)}

			{isGroup ? (
				<GroupFrame
					title={visual.title}
					presentation={
						optionValue<string>(
							visual.visualType,
							visual.config,
							"presentation",
						) === "popup"
							? "popup"
							: "frame"
					}
					openLabel={
						optionValue<string>(
							visual.visualType,
							visual.config,
							"openLabel",
						) ?? null
					}
					showBorder={visual.config.options?.frame !== false}
					width={pixels.width}
					height={pixels.height}
					// Drawn open whatever it is set to. A visual inside a shut
					// group is a visual that cannot be selected, and an author
					// arranging one needs to reach it.
					alwaysOpen
					note={
						optionValue<string>(
							visual.visualType,
							visual.config,
							"presentation",
						) === "popup" ? (
							<span className={styles.groupNote}>
								opens from a button for readers
							</span>
						) : held.length === 0 ? (
							<span className={styles.groupNote}>
								drag a visual onto this to put it inside
							</span>
						) : null
					}
					renderChildren={(inner) =>
						held.map((child) => (
							<CanvasItem
								key={child.visualId}
								visual={child}
								rect={ctx.rectFor(child)}
								pixels={rectToPixels(ctx.rectFor(child), inner)}
								metrics={inner}
								clashes={false}
								ctx={ctx}
							/>
						))
					}
				/>
			) : editingText ? (
				<div className={styles.editableBody}>
					<TextPanel
						editable
						html={
							typeof visual.config.options?.html === "string"
								? visual.config.options.html
								: ""
						}
						placeholder="Write a note, caveat or definition"
						onChange={(html) =>
							ctx.onContentChange?.(visual.visualId, html)
						}
					/>
				</div>
			) : (
				<div className={styles.itemBody}>
					<VisualRenderer
						visual={toVisualSpec(visual)}
						sources={ctx.sources}
					/>
				</div>
			)}

			{isSelected &&
				(["resize-e", "resize-s", "resize-se"] as const).map((kind) => (
					<div
						key={kind}
						className={`${styles.grip} ${
							styles[
								kind === "resize-e"
									? "gripE"
									: kind === "resize-s"
										? "gripS"
										: "gripSE"
							]
						}`}
						onPointerDown={(e) =>
							ctx.startGesture(
								e,
								kind,
								visual.visualId,
								rect,
								metrics,
							)
						}
						onPointerMove={ctx.move}
						onPointerUp={(e) =>
							ctx.finishGesture(e, visual.visualId)
						}
						onPointerCancel={ctx.cancel}
						role="separator"
						aria-label={
							kind === "resize-e"
								? "Resize width"
								: kind === "resize-s"
									? "Resize height"
									: "Resize"
						}
					/>
				))}
		</div>
	);
}

// One control in the strip.
//
// Pulled out so a control drawn loose and a control drawn inside a panel are
// the same thing: the panel changes where it sits, not what it is or what can
// be done to it.
function ControlSlot({
	visual,
	index,
	total,
	selectedId,
	sources,
	remoteBy,
	onSelect,
	onMoveControl,
}: {
	visual: EditableVisual;
	// Where it sits among every control on the page, which is the order the
	// reorder operation writes.
	index: number;
	total: number;
	selectedId: string | null;
	sources: Record<string, SourceMeta>;
	remoteBy: string | undefined;
	onSelect: (visualId: string | null) => void;
	onMoveControl?: (visualId: string, delta: -1 | 1) => void;
}) {
	const isSelected = selectedId === visual.visualId;
	const label = visualByType[visual.visualType]?.label ?? visual.visualType;

	return (
		<div
			className={`${styles.controlSlot} ${
				isSelected ? styles.controlSlotSelected : ""
			}`}
			onPointerDown={() => onSelect(visual.visualId)}
			role="button"
			tabIndex={0}
			aria-pressed={isSelected}
			aria-label={`Edit ${label}`}
		>
			<div className={styles.controlHead}>
				<span className={styles.controlKind}>{label}</span>
				{/* Only on the selected control, and only where there is
				    somewhere to go. A control cannot be dragged, so this is
				    what moving one is. */}
				{isSelected && onMoveControl && (
					<span className={styles.controlMove}>
						<button
							type="button"
							className={styles.iconButton}
							disabled={index === 0}
							aria-label={`Move ${label} earlier`}
							title="Move earlier"
							onPointerDown={(e) => e.stopPropagation()}
							onClick={() => onMoveControl(visual.visualId, -1)}
						>
							<svg
								width="12"
								height="12"
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
						<button
							type="button"
							className={styles.iconButton}
							disabled={index === total - 1}
							aria-label={`Move ${label} later`}
							title="Move later"
							onPointerDown={(e) => e.stopPropagation()}
							onClick={() => onMoveControl(visual.visualId, 1)}
						>
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.5"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M9 18l6-6-6-6" />
							</svg>
						</button>
					</span>
				)}
			</div>
			{remoteBy && <span className={styles.remoteBadge}>{remoteBy}</span>}
			{/* Interaction is off while editing, so a click selects the
			    control rather than filtering the page underneath. */}
			<div className={styles.controlPreview}>
				<VisualRenderer
					visual={toVisualSpec(visual)}
					sources={sources}
				/>
			</div>
		</div>
	);
}

export { gridColumns };
