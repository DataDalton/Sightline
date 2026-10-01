"use client";

import { useCallback, useEffect, useState } from "react";

// How items move on a board, as this person likes it. Kept in the browser,
// since it is a preference about handling rather than part of any board, and
// a board opens the same whichever way somebody prefers to drag.

export const gridSizes = [8, 16, 24, 48] as const;
export type GridSize = (typeof gridSizes)[number];

export interface SnapSettings {
	grid: boolean;
	gridSize: GridSize;
	// Whether edges and centres line up with other items as they move.
	guides: boolean;
}

const key = "board-snapping";
const fallback: SnapSettings = { grid: true, gridSize: 8, guides: true };

function read(): SnapSettings {
	try {
		const raw = JSON.parse(window.localStorage.getItem(key) ?? "null");
		if (!raw || typeof raw !== "object") return fallback;
		return {
			grid: typeof raw.grid === "boolean" ? raw.grid : fallback.grid,
			gridSize: gridSizes.includes(raw.gridSize)
				? raw.gridSize
				: fallback.gridSize,
			guides:
				typeof raw.guides === "boolean" ? raw.guides : fallback.guides,
		};
	} catch {
		return fallback;
	}
}

export function useSnapSettings() {
	const [settings, setSettings] = useState<SnapSettings>(fallback);
	useEffect(() => setSettings(read()), []);
	const change = useCallback((patch: Partial<SnapSettings>) => {
		setSettings((prev) => {
			const next = { ...prev, ...patch };
			try {
				window.localStorage.setItem(key, JSON.stringify(next));
			} catch {
				// Kept for this visit only when the browser will not store it.
			}
			return next;
		});
	}, []);
	return [settings, change] as const;
}
