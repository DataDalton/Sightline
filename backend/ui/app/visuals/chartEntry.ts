"use client";

import dynamic from "next/dynamic";

// The charting library, loaded when a chart is actually on the page.
//
// Tree-shaken through echarts/core it is still the largest asset the client
// downloads, several times the next one. Imported directly it sat in the
// report's own chunk, so a page of grids and scorecards waited for a renderer
// it never used, and a page that does chart something waited for the whole
// library before any of it could paint.
//
// No server rendering: the canvas needs a real element to measure, so it has
// nothing to contribute to the first paint either way.
export const Chart = dynamic(() => import("./Chart").then((m) => m.Chart), {
	ssr: false,
});
