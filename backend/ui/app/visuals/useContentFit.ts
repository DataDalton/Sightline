"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gridGap, rowHeight } from "../../lib/visuals/layout";

// Rows a content-sized visual needs, by id.
//
// Tiles and headings are as tall as what they hold, and that changes with the
// width: they wrap onto more lines as the page narrows. A box drawn by hand is
// either too short, and the content spills under whatever sits below, or too
// tall, and an empty band is left under it. So each one is measured at its
// natural height and given the fewest rows that hold it. The published page
// and the editor both use this, so a narrow preview shows what a reader gets.
//
// The element handed to observe must be at its natural height rather than
// stretched to its box, or the measurement would only ever read back the box.
// See .fitBox in ContentFit.module.css.
export function useContentFit(): {
	// Rows each one needs, for arranging the page.
	fitted: Record<string, number>;
	// Its natural height in pixels, so it can be drawn exactly that tall and
	// what is under it closes up rather than leaving the rest of a row empty.
	natural: Record<string, number>;
	observe: (element: HTMLElement | null) => (() => void) | undefined;
} {
	const [natural, setNatural] = useState<Record<string, number>>({});
	const observer = useRef<ResizeObserver | null>(null);
	const observed = useRef(new Set<HTMLElement>());

	useEffect(() => {
		const watcher = new ResizeObserver((entries) => {
			const measured: Record<string, number> = {};
			for (const entry of entries) {
				const element = entry.target as HTMLElement;
				const id = element.dataset.fitId;
				// Nothing drawn yet, so nothing to size by.
				if (!id || element.offsetHeight === 0) continue;
				measured[id] = element.offsetHeight;
			}
			setNatural((current) => {
				let next = current;
				for (const [id, pixels] of Object.entries(measured)) {
					if (pixels !== current[id]) {
						if (next === current) next = { ...current };
						next[id] = pixels;
					}
				}
				return next;
			});
		});
		observer.current = watcher;
		for (const element of observed.current) watcher.observe(element);
		return () => watcher.disconnect();
	}, []);

	const observe = useCallback((element: HTMLElement | null) => {
		if (!element) return;
		observed.current.add(element);
		observer.current?.observe(element);
		return () => {
			observed.current.delete(element);
			observer.current?.unobserve(element);
		};
	}, []);

	const fitted = useMemo(() => {
		const rows: Record<string, number> = {};
		for (const [id, pixels] of Object.entries(natural)) {
			rows[id] = Math.max(
				1,
				Math.ceil((pixels + gridGap) / (rowHeight + gridGap)),
			);
		}
		return rows;
	}, [natural]);

	return { fitted, natural, observe };
}
