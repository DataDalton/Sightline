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
}

const ShellContext = createContext<ShellState>({
	navOpen: false,
	toggleNav: () => {},
	closeNav: () => {},
});

export function ShellProvider({ children }: { children: ReactNode }) {
	const [navOpen, setNavOpen] = useState(false);
	const pathname = usePathname();

	const toggleNav = useCallback(() => setNavOpen((v) => !v), []);
	const closeNav = useCallback(() => setNavOpen(false), []);

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

	const value = useMemo(
		() => ({ navOpen, toggleNav, closeNav }),
		[navOpen, toggleNav, closeNav],
	);

	return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell() {
	return useContext(ShellContext);
}
