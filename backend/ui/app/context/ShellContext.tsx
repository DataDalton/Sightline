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
import { usePathname } from "next/navigation";

// Shell state shared between the header and the sidebar.
//
// On a narrow screen the sidebar is a drawer, so the button that opens it and
// the panel it opens live in different components. This is the smallest thing
// that lets them agree.

interface ShellState {
	navOpen: boolean;
	toggleNav: () => void;
	closeNav: () => void;
	paletteOpen: boolean;
	openPalette: () => void;
	closePalette: () => void;
}

const ShellContext = createContext<ShellState>({
	navOpen: false,
	toggleNav: () => {},
	closeNav: () => {},
	paletteOpen: false,
	openPalette: () => {},
	closePalette: () => {},
});

export function ShellProvider({ children }: { children: ReactNode }) {
	const [navOpen, setNavOpen] = useState(false);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const pathname = usePathname();

	const toggleNav = useCallback(() => setNavOpen((v) => !v), []);
	const closeNav = useCallback(() => setNavOpen(false), []);
	const openPalette = useCallback(() => setPaletteOpen(true), []);
	const closePalette = useCallback(() => setPaletteOpen(false), []);

	// Navigating is the end of the interaction the drawer was opened for, so
	// it closes on its own rather than covering the page the reader just
	// asked for.
	useEffect(() => {
		setNavOpen(false);
	}, [pathname]);

	// Escape closes it, matching every other overlay in the app.
	useEffect(() => {
		if (!navOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setNavOpen(false);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [navOpen]);

	// The palette opens from anywhere, including from inside a dialog, because
	// it is the way out of wherever somebody currently is.
	//
	// Bound on the window in the capture phase so a field that stops the event
	// cannot swallow the shortcut. A plain "k" is left alone: the point is the
	// modifier, and claiming the letter would break typing in every input.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setPaletteOpen((open) => !open);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);

	// Navigating from the palette is what it was opened to do.
	useEffect(() => {
		setPaletteOpen(false);
	}, [pathname]);

	const value = useMemo(
		() => ({
			navOpen,
			toggleNav,
			closeNav,
			paletteOpen,
			openPalette,
			closePalette,
		}),
		[navOpen, toggleNav, closeNav, paletteOpen, openPalette, closePalette],
	);

	return (
		<ShellContext.Provider value={value}>{children}</ShellContext.Provider>
	);
}

export function useShell() {
	return useContext(ShellContext);
}
