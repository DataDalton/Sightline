"use client";

import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	type ReactNode,
} from "react";

// A reader's own size for each visual.
//
// Visual size is about the report. A reader who makes the trend chart tall
// because that is the one they study is describing an arrangement worth
// keeping, so it is held by the page and saved with a view like any other
// personalisation. Page zoom is left to the browser.

// A reader's own size for one visual, in grid columns and rows. The same units
// the author arranged in, so a resized visual takes part in the same layout
// rather than being a pixel exception laid over it.
export interface VisualSize {
	w?: number;
	h?: number;
}

interface ViewScaleState {
	sizeFor: (visualId: string | null | undefined) => VisualSize | undefined;
	setSize: (visualId: string, size: VisualSize) => void;
	resetSize: (visualId: string) => void;
	// True where the reader has resized anything, so the page can offer to put
	// it all back.
	hasResizes: boolean;
	resetAllSizes: () => void;
}

const ViewScaleContext = createContext<ViewScaleState>({
	sizeFor: () => undefined,
	setSize: () => {},
	resetSize: () => {},
	hasResizes: false,
	resetAllSizes: () => {},
});

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
			sizeFor,
			setSize,
			resetSize,
			resetAllSizes,
			hasResizes: Object.keys(sizes).length > 0,
		}),
		[sizeFor, setSize, resetSize, resetAllSizes, sizes],
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
