"use client";

import { useEffect, type RefObject } from "react";

// Marks searched words in place, without changing the page, so a reader sees
// where a match is in a long table.
//
// Uses the browser's highlight registry, under a name of the caller's own so
// two tables on one page mark their own matches. The look is added to the page
// once per name, from here rather than a stylesheet, since the pseudo-element
// is newer than the stylesheet tooling. A browser without the registry simply
// shows no marks.

function canHighlight(): boolean {
	return typeof CSS !== "undefined" && "highlights" in CSS;
}

function ensureStyle(name: string): void {
	const id = `find-style-${name}`;
	if (document.getElementById(id)) return;
	const style = document.createElement("style");
	style.id = id;
	style.textContent = `::highlight(${name}) { background: color-mix(in srgb, var(--brand) 32%, transparent); }`;
	document.head.appendChild(style);
}

export function useFindHighlight(
	root: RefObject<HTMLElement | null>,
	name: string,
	words: string[],
	// What the marked text depends on, such as the rows on show.
	redrawWith: unknown,
): void {
	const key = words.join("\u001f");
	useEffect(() => {
		if (!canHighlight()) return;
		const element = root.current;
		CSS.highlights.delete(name);
		const needles = key
			.split("\u001f")
			.map((word) => word.toLowerCase())
			.filter((word) => word.length > 0);
		if (!element || needles.length === 0) return;
		ensureStyle(name);
		const ranges: Range[] = [];
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = (node.textContent ?? "").toLowerCase();
			for (const needle of needles) {
				let at = text.indexOf(needle);
				while (at >= 0) {
					const range = document.createRange();
					range.setStart(node, at);
					range.setEnd(node, at + needle.length);
					ranges.push(range);
					at = text.indexOf(needle, at + needle.length);
				}
			}
		}
		if (ranges.length > 0)
			CSS.highlights.set(name, new Highlight(...ranges));
		return () => {
			CSS.highlights.delete(name);
		};
	}, [root, name, key, redrawWith]);
}
