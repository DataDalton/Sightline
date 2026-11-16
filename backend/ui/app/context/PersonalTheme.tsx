"use client";

import { useLayoutEffect, useMemo } from "react";
import useSWR from "swr";
import {
	allThemes,
	themeTokens,
	type ReportTheme,
} from "../../lib/visuals/themes";
import type { UserThemeChoice } from "../../lib/platform/userTheme";
import { setPersonalOverrides } from "../visuals/colors";
import { useTheme } from "./ThemeContext";

// The colours a person chose for the whole app.
//
// Written onto the document root, so the navigation and header take them as
// well as the page. Kept in this browser too, so the next visit paints in them
// before anything has been fetched. See themeBootstrapScript.

export const personalThemeKey = "/api/user/theme";
export const coloursStorageKey = "sightline-colours";

export function usePersonalTheme(): {
	choice: UserThemeChoice | undefined;
	theme: ReportTheme | null;
	tokens: Record<string, string> | null;
	mutate: () => Promise<unknown>;
} {
	const { data: choice, mutate } = useSWR<UserThemeChoice>(personalThemeKey);
	const { data: info } = useSWR<{ customThemes?: ReportTheme[] }>(
		"/api/info",
	);
	const theme = useMemo(() => {
		if (!choice) return null;
		if (choice.own) return choice.own;
		if (!choice.themeId) return null;
		// A workspace theme removed since it was chosen falls back to the app's
		// colours rather than to a guess.
		return (
			allThemes(info?.customThemes ?? []).find(
				(t) => t.id === choice.themeId,
			) ?? null
		);
	}, [choice, info?.customThemes]);
	const tokens = useMemo(() => (theme ? themeTokens(theme) : null), [theme]);
	return { choice, theme, tokens, mutate };
}

function remember(tokens: Record<string, string> | null): void {
	try {
		if (tokens) {
			localStorage.setItem(coloursStorageKey, JSON.stringify(tokens));
		} else {
			localStorage.removeItem(coloursStorageKey);
		}
	} catch {
		// Storage refused, such as a private window. The colours still apply
		// once they are fetched, a moment later on the next visit.
	}
}

export function PersonalThemeLayer() {
	const { choice, tokens } = usePersonalTheme();
	const { setColours } = useTheme();

	// During render, because a chart reads its colours while it first draws.
	if (choice) setPersonalOverrides(tokens);

	useLayoutEffect(() => {
		// Until the choice has been read, whatever the bootstrap script painted
		// stays, so a returning reader never sees the app's colours flash first.
		if (!choice) return;
		const root = document.documentElement;
		remember(tokens);
		// Charts read the palette while they draw, so they are told to draw again.
		setColours(tokens ? JSON.stringify(tokens) : "");
		if (!tokens) {
			for (const name of applied(root)) root.style.removeProperty(name);
			return;
		}
		for (const [name, value] of Object.entries(tokens)) {
			root.style.setProperty(name, value);
		}
		return () => {
			for (const name of Object.keys(tokens)) {
				root.style.removeProperty(name);
			}
		};
	}, [choice, tokens, setColours]);

	return null;
}

// The colour properties currently set inline on the root, including any the
// bootstrap script wrote from a choice since cleared on another device.
function applied(root: HTMLElement): string[] {
	const names: string[] = [];
	for (let i = 0; i < root.style.length; i++) {
		const name = root.style.item(i);
		if (name.startsWith("--brand") || name.startsWith("--chart-")) {
			names.push(name);
		}
	}
	return names;
}
