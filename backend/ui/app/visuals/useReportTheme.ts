"use client";

import { useLayoutEffect, useMemo } from "react";
import useSWR from "swr";
import {
	allThemes,
	themeTokens,
	type ReportTheme,
} from "../../lib/visuals/themes";
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
export function useReportTheme(themeId: string | null | undefined): void {
	const { data } = useSWR<{ customThemes?: ReportTheme[] }>("/api/info");
	const tokens = useMemo(() => {
		if (!themeId) return null;
		const theme = allThemes(data?.customThemes ?? []).find(
			(t) => t.id === themeId,
		);
		return theme ? themeTokens(theme) : null;
	}, [themeId, data?.customThemes]);

	if (tokens) setThemeOverrides(tokens);

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
