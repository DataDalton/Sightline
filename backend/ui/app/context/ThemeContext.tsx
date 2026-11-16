"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react";

// Theme has three states. "system" follows the operating system and is the
// default; "light" and "dark" are explicit choices that override it. The
// explicit choice is written to the root element as data-theme, which is what
// the token layer keys off.

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const storageKey = "sightline-theme";

interface ThemeContextValue {
	preference: ThemePreference;
	resolved: ResolvedTheme;
	setPreference: (next: ThemePreference) => void;
	// Changes whenever the colours on screen change, from light or dark or from
	// the reader's own colours. Anything that reads the palette off the
	// document reads it again when this changes.
	paintKey: string;
	// Set by whatever puts colours on the document, with a value naming them.
	setColours: (signature: string) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
	preference: "system",
	resolved: "light",
	setPreference: () => {},
	paintKey: "light",
	setColours: () => {},
});

// Runs before first paint so the page never renders in the wrong theme and
// then corrects itself. Kept in sync with the logic below. Also paints the
// reader's own colours from what PersonalTheme kept in this browser, under the
// same storage key and limited to the properties a theme sets.
export const themeBootstrapScript = `
(function() {
	try {
		var stored = localStorage.getItem('${storageKey}');
		if (stored === 'light' || stored === 'dark') {
			document.documentElement.setAttribute('data-theme', stored);
		}
	} catch (e) {}
	try {
		var colours = JSON.parse(localStorage.getItem('sightline-colours') || 'null');
		if (colours && typeof colours === 'object') {
			for (var name in colours) {
				var value = colours[name];
				var hex = /^#[0-9a-fA-F]{6}$/.test(value);
				var tint = /^color-mix\\(in srgb, #[0-9a-fA-F]{6} \\d+%, var\\(--surface-raised\\)\\)$/.test(value);
				if ((/^--(brand|brand-strong|brand-contrast|chart-[1-8])$/.test(name) && hex) || (name === '--brand-subtle' && tint)) {
					document.documentElement.style.setProperty(name, value);
				}
			}
		}
	} catch (e) {}
})();
`;

function systemTheme(): ResolvedTheme {
	if (typeof window === "undefined") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function readStored(): ThemePreference {
	if (typeof window === "undefined") return "system";
	try {
		const stored = localStorage.getItem(storageKey);
		if (stored === "light" || stored === "dark") return stored;
	} catch {
		// Private browsing and blocked site data both land here. The system
		// preference is a correct answer, so there is nothing to recover.
	}
	return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	// Starts at the server-rendered default and corrects on mount, so the
	// markup matches between server and client.
	const [preference, setPreferenceState] =
		useState<ThemePreference>("system");
	const [resolved, setResolved] = useState<ResolvedTheme>("light");
	const [colours, setColours] = useState("");

	useEffect(() => {
		const stored = readStored();
		setPreferenceState(stored);
		setResolved(stored === "system" ? systemTheme() : stored);
	}, []);

	// Track system changes only while the user is following the system.
	useEffect(() => {
		if (preference !== "system") return;
		const query = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => setResolved(query.matches ? "dark" : "light");
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, [preference]);

	const setPreference = useCallback((next: ThemePreference) => {
		setPreferenceState(next);
		setResolved(next === "system" ? systemTheme() : next);

		try {
			if (next === "system") localStorage.removeItem(storageKey);
			else localStorage.setItem(storageKey, next);
		} catch {
			// Persisting is a convenience. The choice still applies to this
			// session even when storage is unavailable.
		}

		const root = document.documentElement;
		if (next === "system") root.removeAttribute("data-theme");
		else root.setAttribute("data-theme", next);
	}, []);

	return (
		<ThemeContext.Provider
			value={{
				preference,
				resolved,
				setPreference,
				paintKey: `${resolved}|${colours}`,
				setColours,
			}}
		>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	return useContext(ThemeContext);
}
