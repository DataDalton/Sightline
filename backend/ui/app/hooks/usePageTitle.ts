"use client";

import { useEffect } from "react";
import useSWR from "swr";
import { setResultMaxAge } from "../visuals/resultMemo";

// The document title, which is what a reader sees on a tab and in their history.
//
// Composed from two things the source cannot know: what this installation calls
// itself, which lives in the settings table, and where the reader currently is.
// Both arrive after the first render, so the title is set in an effect rather
// than declared as static metadata.

// What a fresh install calls itself, before an administrator has named it. Also
// what stands in for the moment before the settings table has been read.
const fallbackName = "Sightline";

// Middot rather than a hyphen, so a title that already contains a hyphen still
// reads as one place inside one application.
export const titleSeparator = "·";

export function usePageTitle(page?: string | null): void {
	// Shares the cache entry the header already fills, so this costs no extra
	// request and picks up a rename at the same moment the header does.
	const { data } = useSWR<{ name?: string; resultTtlSeconds?: number }>(
		"/api/info",
	);

	// The branding payload is on every page and already carries the platform
	// settings the client needs, so the grid and matrix lifetime rides along
	// with it rather than costing a request of its own.
	useEffect(() => {
		if (data?.resultTtlSeconds) setResultMaxAge(data.resultTtlSeconds);
	}, [data?.resultTtlSeconds]);
	const appName = data?.name || fallbackName;

	const where = page?.trim();

	useEffect(() => {
		document.title = where
			? `${where} ${titleSeparator} ${appName}`
			: appName;
	}, [where, appName]);
}
