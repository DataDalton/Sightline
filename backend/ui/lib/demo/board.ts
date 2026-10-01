import type { BoardItem, BoardLink } from "../boards/definition";

// The board the demonstration opens with, telling one quarter's revenue as a
// story, with live visuals from the reports, notes, a box and arrows in each
// style. Each visual is named by the report and title it is copied from, and
// the seed fills in what that visual holds.

export interface DemoVisualRef {
	slug: string;
	title: string;
	visualType: string;
}

export type DemoItem = Omit<BoardItem, "visual" | "origin"> & {
	from?: DemoVisualRef;
};

export const demoBoard: {
	title: string;
	items: DemoItem[];
	links: BoardLink[];
} = {
	title: "Q3 revenue story",
	items: [
		{
			id: "title",
			kind: "text",
			x: 0,
			y: -280,
			w: 1880,
			h: 80,
			text: "Q3 revenue: what moved and why",
		},
		{
			id: "trend",
			kind: "visual",
			x: 0,
			y: -170,
			w: 1240,
			h: 420,
			from: {
				slug: "revenue-overview",
				title: "Over time",
				visualType: "lineChart",
			},
		},
		{
			id: "europe",
			kind: "note",
			x: 1280,
			y: -170,
			w: 600,
			h: 190,
			color: "yellow",
			text: "Europe drove most of the drop on the 29th. Check with the EU team before Monday.",
		},
		{
			id: "checks",
			kind: "note",
			x: 1280,
			y: 60,
			w: 600,
			h: 190,
			color: "blue",
			text: "To check before Monday\n\n1. Is the Europe drop one day or a trend?\n2. Which regions are behind target?\n3. Did any channel move with it?",
		},
		{
			id: "regionHeading",
			kind: "text",
			x: 0,
			y: 290,
			w: 900,
			h: 80,
			text: "By region",
		},
		{
			id: "ranked",
			kind: "visual",
			x: 0,
			y: 380,
			w: 600,
			h: 400,
			from: {
				slug: "revenue-overview",
				title: "Ranked",
				visualType: "horizontalBarChart",
			},
		},
		{
			id: "target",
			kind: "visual",
			x: 640,
			y: 380,
			w: 600,
			h: 400,
			from: {
				slug: "regional-targets",
				title: "Against target",
				visualType: "bulletChart",
			},
		},
		{
			id: "channels",
			kind: "visual",
			x: 1280,
			y: 380,
			w: 600,
			h: 400,
			from: {
				slug: "revenue-overview",
				title: "Side by side",
				visualType: "matrixTable",
			},
		},
		{
			id: "review",
			kind: "shape",
			x: 640,
			y: 840,
			w: 600,
			h: 130,
			shape: "rounded",
			text: "Review with the EU team, Monday 9:00",
			style: {
				fill: "teal",
				stroke: "teal",
				strokeWidth: 2,
				textSize: "large",
				bold: true,
			},
		},
	],
	links: [
		{
			id: "europeToTrend",
			from: "europe",
			to: "trend",
			route: "orthogonal",
			color: "orange",
			width: 3,
			flow: true,
		},
		{
			id: "rankedToTarget",
			from: "ranked",
			to: "target",
			route: "curved",
			line: "dashed",
			color: "blue",
		},
		{
			id: "targetToReview",
			from: "target",
			to: "review",
			route: "straight",
			label: "Behind target",
		},
	],
};
