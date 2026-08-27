"use client";

import { useCallback, useRef, useState } from "react";
import {
	clampRect,
	pixelsToCell,
	pixelsToSpan,
	rectToPixels,
	type CanvasMetrics,
	type Rect,
} from "../../lib/visuals/layout";

// Dragging and resizing on the canvas.
//
// Pointer events rather than mouse events, so a touch screen and a stylus work
// without a second code path. Capture is taken on the element that started the
// gesture, which means the drag continues correctly when the pointer leaves
// that element, and ends even if it is released outside the window.
//
// The gesture reports in grid cells rather than pixels: the caller stores a
// rectangle in columns and rows, and never sees a pixel.

export type GestureKind = "move" | "resize-e" | "resize-s" | "resize-se";

interface Gesture {
	kind: GestureKind;
	id: string;
	pointerId: number;
	startX: number;
	startY: number;
	startRect: Rect;
	// The grid this gesture is measured against.
	//
	// Carried per gesture rather than taken from the hook, because a visual
	// inside a group is laid out across the group's width, not the page's. A
	// single set of metrics dragged those at the page's column pitch, so a
	// child crossed twice the cells the pointer did.
	metrics: CanvasMetrics;
}

export interface DragState {
	id: string;
	kind: GestureKind;
	// The rectangle as it currently stands, already snapped to the grid.
	rect: Rect;
}

interface Options {
	metrics: CanvasMetrics;
	// Canvas zoom, so a gesture at 50% moves the same number of cells per
	// screen pixel as it does at 100%.
	zoom: number;
	onCommit: (id: string, rect: Rect) => void;
}

export function useDragResize({ metrics, zoom, onCommit }: Options) {
	const gestureRef = useRef<Gesture | null>(null);
	// Read inside begin, which is deliberately not re-created per render: a new
	// begin on every metrics change would restart nothing but would churn every
	// item that takes it as a prop.
	const metricsRef = useRef(metrics);
	metricsRef.current = metrics;
	const [state, setState] = useState<DragState | null>(null);
	// The rectangle as the gesture currently stands, kept alongside the state.
	//
	// The end of a gesture needs to know where the pointer left the visual, and
	// reading it from a state updater put the caller's commit inside React's
	// render phase: a parent updated while a child was rendering, which React
	// reports as a mistake because it is one. A ref is the same value without
	// being part of a render.
	const liveRectRef = useRef<Rect | null>(null);

	const begin = useCallback(
		(
			event: React.PointerEvent,
			kind: GestureKind,
			id: string,
			rect: Rect,
			// Defaults to the page grid, which is what everything not inside a
			// group is measured against.
			gridMetrics?: CanvasMetrics,
		) => {
			// Only the primary button starts a gesture, so a right click can
			// still open a context menu.
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();

			(event.currentTarget as Element).setPointerCapture(event.pointerId);

			gestureRef.current = {
				kind,
				id,
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				startRect: rect,
				metrics: gridMetrics ?? metricsRef.current,
			};
			liveRectRef.current = rect;
			setState({ id, kind, rect });
		},
		[],
	);

	const move = useCallback(
		(event: React.PointerEvent) => {
			const gesture = gestureRef.current;
			if (!gesture || gesture.pointerId !== event.pointerId) return;

			// Screen pixels are divided by the zoom, so the visual tracks the
			// pointer exactly at any magnification.
			const dx = (event.clientX - gesture.startX) / zoom;
			const dy = (event.clientY - gesture.startY) / zoom;

			const startPixels = rectToPixels(
				gesture.startRect,
				gesture.metrics,
			);
			let next: Rect;

			if (gesture.kind === "move") {
				const cell = pixelsToCell(
					startPixels.left + dx,
					startPixels.top + dy,
					gesture.metrics,
				);
				next = { ...gesture.startRect, x: cell.x, y: cell.y };
			} else {
				const width =
					gesture.kind === "resize-s"
						? startPixels.width
						: startPixels.width + dx;
				const height =
					gesture.kind === "resize-e"
						? startPixels.height
						: startPixels.height + dy;
				const span = pixelsToSpan(width, height, gesture.metrics);
				next = { ...gesture.startRect, w: span.w, h: span.h };
			}

			const clamped = clampRect(next);
			liveRectRef.current = clamped;
			setState((prev) =>
				prev &&
				prev.rect.x === clamped.x &&
				prev.rect.y === clamped.y &&
				prev.rect.w === clamped.w &&
				prev.rect.h === clamped.h
					? prev
					: { id: gesture.id, kind: gesture.kind, rect: clamped },
			);
		},
		[zoom],
	);

	const end = useCallback(
		(event: React.PointerEvent) => {
			const gesture = gestureRef.current;
			if (!gesture || gesture.pointerId !== event.pointerId) return;

			const element = event.currentTarget as Element;
			if (element.hasPointerCapture(event.pointerId)) {
				element.releasePointerCapture(event.pointerId);
			}

			// The gesture is committed only if it actually changed something,
			// so a click that happens to land on the drag handle does not
			// register as an edit and mark the report dirty.
			const finalRect = liveRectRef.current;
			const start = gesture.startRect;

			gestureRef.current = null;
			liveRectRef.current = null;
			setState(null);

			if (
				finalRect &&
				(finalRect.x !== start.x ||
					finalRect.y !== start.y ||
					finalRect.w !== start.w ||
					finalRect.h !== start.h)
			) {
				onCommit(gesture.id, finalRect);
			}
		},
		[onCommit],
	);

	// Called when the browser takes the pointer away, such as a system gesture
	// mid-drag. The visual returns to where it started rather than being left
	// somewhere the author did not choose.
	const cancel = useCallback(() => {
		gestureRef.current = null;
		liveRectRef.current = null;
		setState(null);
	}, []);

	return { state, begin, move, end, cancel, isActive: state !== null };
}
