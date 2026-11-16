"use client";

import { useLayoutEffect, useMemo } from "react";
import useSWR from "swr";
import {
	allThemes,
	themeTokens,
	type ReportTheme,
} from "../../lib/visuals/themes";
import { usePersonalTheme } from "../context/PersonalTheme";
import { setThemeOverrides } from "./colors";

// Draws the page in a report's theme, and takes it off again on the way out so it
// never colours another page.
//
// Written two ways. The document gets the custom properties for everything drawn
// in CSS. The colour reader is told during render, because a chart reads its
// colours while it draws, which is before an effect could have written them.
//
// Pass null to apply nothing, which is how the page behind the editor stands aside
// while the editor shows the theme being chosen.
//
// A reader with their own colours keeps them, and the report's theme is not
// applied. The editor passes overPersonal, so an author still sees the theme
// they are choosing for everybody else.
export function useReportTheme(
	themeId: string | null | undefined,
	{ overPersonal = false }: { overPersonal?: boolean } = {},
): void {
	const { data } = useSWR<{ customThemes?: ReportTheme[] }>("/api/info");
	const { tokens: personal } = usePersonalTheme();
	const standAside = personal !== null && !overPersonal;
	const tokens = useMemo(() => {
		if (!themeId || standAside) return null;
		const theme = allThemes(data?.customThemes ?? []).find(
			(t) => t.id === themeId,
		);
		return theme ? themeTokens(theme) : null;
	}, [themeId, standAside, data?.customThemes]);

	if (tokens) setThemeOverrides(tokens);
	// Cleared during render as well as in the effect below, because the charts
	// under this page draw before that effect runs and would keep the report's
	// palette after the reader's own colours arrive.
	else if (standAside && themeId) setThemeOverrides(null);

	useLayoutEffect(() => {
		if (!tokens) return;
		// On the page's content alone, so the header and navigation stay the app's own.
		const root =
			document.getElementById("main") ?? document.documentElement;
		for (const [name, value] of Object.entries(tokens)) {
			root.style.setProperty(name, value);
		}
		return () => {
			for (const name of Object.keys(tokens)) {
				root.style.removeProperty(name);
			}
			setThemeOverrides(null);
		};
	}, [tokens]);
}
