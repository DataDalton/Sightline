"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import styles from "./ReportView.module.css";

// How large a reader wants things.
//
// Two separate settings, because they answer different questions and belong in
// different places:
//
//   Page zoom is about the person and the screen they are on. Someone on a
//   laptop wants the whole page smaller so more fits; someone presenting wants
//   it larger. It has nothing to do with the report, so it is kept per browser
//   and never travels to anyone else.
//
//   Visual size is about the report. A reader who makes the trend chart tall
//   because that is the one they study is describing an arrangement worth
//   keeping, so it is held by the page and saved with a view like any other
//   personalisation. It is recorded in grid columns and rows, the same units
//   the author arranged in, so a resized visual takes part in the page layout
//   rather than sitting on top of it as a pixel exception.

// A reader's own size for one visual, in grid columns and rows. The same units
// the author arranged in, so a resized visual takes part in the same layout
// rather than being a pixel exception laid over it.
export interface VisualSize {
	w?: number;
	h?: number;
}

interface ViewScaleState {
	scale: number;
	setScale: (next: number) => void;
	sizeFor: (visualId: string | null | undefined) => VisualSize | undefined;
	setSize: (visualId: string, size: VisualSize) => void;
	resetSize: (visualId: string) => void;
	// True where the reader has resized anything, so the page can offer to put
	// it all back.
	hasResizes: boolean;
	resetAllSizes: () => void;
}

const ViewScaleContext = createContext<ViewScaleState>({
	scale: 1,
	setScale: () => {},
	sizeFor: () => undefined,
	setSize: () => {},
	resetSize: () => {},
	hasResizes: false,
	resetAllSizes: () => {},
});

export const minScale = 0.6;
export const maxScale = 1.6;
const storageKey = "sightline.pageScale";

interface ProviderProps {
	sizes: Record<string, VisualSize>;
	onSizesChange: (next: Record<string, VisualSize>) => void;
	children: ReactNode;
}

export function ViewScaleProvider({
	sizes,
	onSizesChange,
	children,
}: ProviderProps) {
	const [scale, setScaleState] = useState(1);

	// Read after mount rather than during render: the server has no storage,
	// and reading it during render would make the first paint disagree with
	// the markup the server sent.
	useEffect(() => {
		try {
			const stored = Number(window.localStorage.getItem(storageKey));
			if (Number.isFinite(stored) && stored >= minScale && stored <= maxScale) {
				setScaleState(stored);
			}
		} catch {
			// Private browsing, or storage turned off. The default stands.
		}
	}, []);

	const setScale = useCallback((next: number) => {
		const clamped = Math.min(maxScale, Math.max(minScale, next));
		setScaleState(clamped);
		try {
			window.localStorage.setItem(storageKey, String(clamped));
		} catch {
			// Not being able to remember the choice is not a reason to refuse
			// to apply it.
		}
	}, []);

	const sizeFor = useCallback(
		(visualId: string | null | undefined) =>
			visualId ? sizes[visualId] : undefined,
		[sizes],
	);

	const setSize = useCallback(
		(visualId: string, size: VisualSize) => {
			onSizesChange({ ...sizes, [visualId]: size });
		},
		[sizes, onSizesChange],
	);

	const resetSize = useCallback(
		(visualId: string) => {
			const next = { ...sizes };
			delete next[visualId];
			onSizesChange(next);
		},
		[sizes, onSizesChange],
	);

	const resetAllSizes = useCallback(() => onSizesChange({}), [onSizesChange]);

	const value = useMemo(
		() => ({
			scale,
			setScale,
			sizeFor,
			setSize,
			resetSize,
			resetAllSizes,
			hasResizes: Object.keys(sizes).length > 0,
		}),
		[scale, setScale, sizeFor, setSize, resetSize, resetAllSizes, sizes],
	);

	return (
		<ViewScaleContext.Provider value={value}>
			{children}
		</ViewScaleContext.Provider>
	);
}

export function useViewScale(): ViewScaleState {
	return useContext(ViewScaleContext);
}

// The reader's zoom control.
//
// Placed with the page actions rather than floating, because it is a setting
// the reader adjusts once and then forgets, not something they reach for while
// reading. It changes the page's own layout rather than scaling a picture of
// it, so text stays sharp and a wider page reflows to use the space.
export function ZoomControl() {
	const { scale, setScale } = useViewScale();
	const step = 0.1;

	return (
		<div className={styles.zoom} role="group" aria-label="Page size">
			<button
				type="button"
				className={styles.zoomButton}
				onClick={() => setScale(scale - step)}
				disabled={scale <= minScale}
				aria-label="Smaller"
				title="Make everything smaller"
			>
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<path d="M5 12h14" />
				</svg>
			</button>

			<button
				type="button"
				className={styles.zoomValue}
				onClick={() => setScale(1)}
				title="Back to normal size"
				disabled={scale === 1}
			>
				{Math.round(scale * 100)}%
			</button>

			<button
				type="button"
				className={styles.zoomButton}
				onClick={() => setScale(scale + step)}
				disabled={scale >= maxScale}
				aria-label="Larger"
				title="Make everything larger"
			>
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<path d="M12 5v14M5 12h14" />
				</svg>
			</button>
		</div>
	);
}

// Applies the reader's zoom to whatever it wraps.
//
// CSS zoom rather than a transform: a transform scales a rendered box, leaving
// the layout at its original size, so the page would keep the same line breaks
// and gain scrollbars. Zoom changes the layout itself, which is what a reader
// asking for smaller text actually wants.
export function ScaledArea({ children }: { children: ReactNode }) {
	const { scale } = useViewScale();
	return (
		<div className={styles.scaled} style={scale === 1 ? undefined : { zoom: scale }}>
			{children}
		</div>
	);
}
