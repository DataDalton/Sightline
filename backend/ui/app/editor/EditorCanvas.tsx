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
	type Rect,
} from "../../lib/visuals/layout";
import { VisualRenderer } from "../visuals/VisualRenderer";
import { FilterBar } from "../visuals/FilterWidgets";
import { fillsHeight, isPageControl, visualByType } from "../../lib/visuals/catalog";
import { TextPanel } from "../visuals/TextPanel";
import type { SourceMeta } from "../visuals/types";
import { useDragResize } from "./useDragResize";
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
// cross-filtering the page underneath.
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
	const { state, begin, move, end, cancel } = useDragResize({
		metrics,
		zoom,
		onCommit: onLayoutChange,
	});

	// A gesture marks its visual as in progress for as long as it runs, so a
	// remote edit to the same visual waits rather than fighting the pointer.
	const startGesture = (
		event: React.PointerEvent,
		kind: Parameters<typeof begin>[1],
		id: string,
		rect: Rect,
	) => {
		onGestureStart?.(id);
		begin(event, kind, id, rect);
	};

	const finishGesture = (event: React.PointerEvent, id: string) => {
		end(event);
		onGestureEnd?.(id);
	};

	// While a gesture is running the dragged visual uses the live rectangle
	// and everything else uses its stored one.
	const rectFor = (visual: EditableVisual): Rect =>
		state && state.id === visual.visualId ? state.rect : visual.layout;

	// Controls come out of the grid entirely and sit in a strip, in the
	// reading order an author gave them.
	const controls = visuals.filter((v) => isPageControl(v.visualType));
	const placed = visuals.filter((v) => !isPageControl(v.visualType));

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
					fillsHeight(v.visualType, v.config.options as Record<string, unknown>),
			})),
			// Measured inside the canvas, which is where the page ends here.
			viewportHeight / zoom,
		).map((i) => [i.id, i.rect]),
	);

	const displayRectFor = (visual: EditableVisual): Rect =>
		displayRects.get(visual.visualId) ?? rectFor(visual);

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
					<span className={styles.emptyTitle}>This page is empty</span>
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
			{controls.length > 0 && (
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
					<FilterBar>
						{controls.map((visual) => {
							const isSelected = selectedId === visual.visualId;
							const remoteBy = remoteSelections?.get(visual.visualId);
							return (
								<div
									key={visual.visualId}
									className={`${styles.controlSlot} ${
										isSelected ? styles.controlSlotSelected : ""
									}`}
									onPointerDown={() => onSelect(visual.visualId)}
									role="button"
									tabIndex={0}
									aria-pressed={isSelected}
									aria-label={`Edit ${
										visualByType[visual.visualType]?.label ??
										visual.visualType
									}`}
								>
									<span className={styles.controlKind}>
										{visualByType[visual.visualType]?.label ??
											visual.visualType}
									</span>
									{remoteBy && (
										<span className={styles.remoteBadge}>{remoteBy}</span>
									)}
									{/* Interaction is off while editing, so a
									    click selects the control rather than
									    filtering the page underneath. */}
									<div className={styles.controlPreview}>
										<VisualRenderer
											visual={toVisualSpec(visual)}
											sources={sources}
										/>
									</div>
								</div>
							);
						})}
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
				{placed.map((visual) => {
					// The stored rectangle drives the gestures, the displayed
					// one drives the box, so a filled visual is dragged by what
					// the author set rather than by what the fill produced.
					const rect = rectFor(visual);
					const pixels = rectToPixels(displayRectFor(visual), metrics);
					const isSelected = selectedId === visual.visualId;
					const isDragging = state?.id === visual.visualId;

					const clashes = placed.some(
						(other) =>
							other.visualId !== visual.visualId &&
							overlaps(rect, rectFor(other)),
					);

					return (
						<div
							key={visual.visualId}
							className={`${styles.item} ${isSelected ? styles.itemSelected : ""} ${
								isDragging ? styles.itemDragging : ""
							}`}
							style={{
								left: pixels.left,
								top: pixels.top,
								width: pixels.width,
								height: pixels.height,
							}}
							onPointerDown={() => onSelect(visual.visualId)}
						>
							{/* The header strip is the drag handle, so dragging
							    is deliberate rather than triggered by any
							    press inside the visual. */}
							{/* A selected text panel puts its formatting toolbar
							    where the drag handle sits, so the handle steps
							    aside to the title bar edge rather than
							    swallowing every toolbar click. */}
							<div
								className={`${styles.dragHandle} ${
									visual.visualType === "textPanel" && isSelected
										? styles.dragHandleNarrow
										: ""
								}`}
								onPointerDown={(e) =>
									startGesture(e, "move", visual.visualId, rect)
								}
								onPointerMove={move}
								onPointerUp={(e) => finishGesture(e, visual.visualId)}
								onPointerCancel={cancel}
								role="button"
								tabIndex={0}
								aria-label={`Move ${visual.title ?? visual.visualType}`}
							/>

							{clashes && (
								<span className={styles.overlapWarning}>overlapping</span>
							)}

							{/* Someone else has this visual open. Shown rather
							    than locked: a hard lock strands a visual when a
							    tab is left open, and last-writer-wins already
							    keeps the result coherent. */}
							{remoteSelections?.has(visual.visualId) && (
								<span className={styles.remoteBadge}>
									{remoteSelections
										.get(visual.visualId)
										?.split("@")[0]}
								</span>
							)}

							{/* A control renders bare in the reader view because it
							    belongs to the page chrome. On the canvas it needs
							    a frame, or it reads as loose buttons floating on
							    the grid rather than as a placed element with a
							    position an author can move. */}
							{/* A selected text panel is edited where it sits.
							    Everything else on the canvas has interaction
							    disabled so a click selects rather than
							    cross-filters, but a text panel that cannot be
							    typed into is not an editor at all. */}
							{visual.visualType === "textPanel" && isSelected ? (
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
											onContentChange?.(visual.visualId, html)
										}
									/>
								</div>
							) : (
								<div className={styles.itemBody}>
									<VisualRenderer
										visual={toVisualSpec(visual)}
										sources={sources}
									/>
								</div>
							)}

							{isSelected && (
								<>
									<div
										className={`${styles.grip} ${styles.gripE}`}
										onPointerDown={(e) =>
											startGesture(
												e,
												"resize-e",
												visual.visualId,
												rect,
											)
										}
										onPointerMove={move}
										onPointerUp={(e) =>
											finishGesture(e, visual.visualId)
										}
										onPointerCancel={cancel}
										role="separator"
										aria-label="Resize width"
									/>
									<div
										className={`${styles.grip} ${styles.gripS}`}
										onPointerDown={(e) =>
											startGesture(
												e,
												"resize-s",
												visual.visualId,
												rect,
											)
										}
										onPointerMove={move}
										onPointerUp={(e) =>
											finishGesture(e, visual.visualId)
										}
										onPointerCancel={cancel}
										role="separator"
										aria-label="Resize height"
									/>
									<div
										className={`${styles.grip} ${styles.gripSE}`}
										onPointerDown={(e) =>
											startGesture(
												e,
												"resize-se",
												visual.visualId,
												rect,
											)
										}
										onPointerMove={move}
										onPointerUp={(e) =>
											finishGesture(e, visual.visualId)
										}
										onPointerCancel={cancel}
										role="separator"
										aria-label="Resize"
									/>
								</>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export { gridColumns };
