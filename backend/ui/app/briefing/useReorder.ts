"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Reordering pinned cards by dragging them.
//
// Pointer events rather than the browser's own drag and drop, which draws a
// faint copy of the whole card under the cursor and says nothing about where
// it will land. Here a compact preview follows the pointer, the slot under it
// is marked, and the reorder happens on release. A press only becomes a drag
// once the pointer has travelled, so a click on the card still clicks, and a
// press on a button or link never starts one. Escape puts the card back.

export interface DragState {
	id: string;
	x: number;
	y: number;
	// The slot under the pointer, by position, or null over none.
	over: number | null;
}

// How far the pointer travels before a press counts as a drag.
const threshold = 6;

function slotAt(x: number, y: number): number | null {
	for (const element of document.elementsFromPoint(x, y)) {
		const slot = (element as HTMLElement).closest?.<HTMLElement>(
			"[data-pin-index]",
		);
		if (slot) return Number(slot.dataset.pinIndex);
	}
	return null;
}

export function useReorder(onDrop: (id: string, to: number) => void) {
	const [drag, setDrag] = useState<DragState | null>(null);
	const stop = useRef<(() => void) | null>(null);

	// A drag in progress when the page goes away is ended with it.
	useEffect(() => () => stop.current?.(), []);

	const start = useCallback(
		(id: string) => (event: React.PointerEvent<HTMLElement>) => {
			if (event.button !== 0) return;
			const target = event.target as HTMLElement;
			if (target.closest("button, a, input, select, textarea")) return;
			const startX = event.clientX;
			const startY = event.clientY;
			let live = false;
			let over: number | null = null;

			const finish = (drop: boolean) => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onCancel);
				window.removeEventListener("keydown", onKey);
				document.body.style.userSelect = "";
				document.body.style.cursor = "";
				stop.current = null;
				setDrag(null);
				if (drop && live && over !== null) onDrop(id, over);
			};
			const onMove = (e: PointerEvent) => {
				if (!live) {
					if (
						Math.hypot(e.clientX - startX, e.clientY - startY) <
						threshold
					)
						return;
					live = true;
					document.body.style.userSelect = "none";
					document.body.style.cursor = "grabbing";
				}
				e.preventDefault();
				over = slotAt(e.clientX, e.clientY);
				setDrag({ id, x: e.clientX, y: e.clientY, over });
			};
			const onUp = () => finish(true);
			const onCancel = () => finish(false);
			const onKey = (e: KeyboardEvent) => {
				if (e.key === "Escape") finish(false);
			};

			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onCancel);
			window.addEventListener("keydown", onKey);
			stop.current = () => finish(false);
		},
		[onDrop],
	);

	return { drag, start };
}
