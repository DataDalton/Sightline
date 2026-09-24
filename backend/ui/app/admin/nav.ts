// Every destination in administration, in the order the rail lists them.
//
// One flat list under group headings, rather than a tab opening a side nav
// opening a tab strip. Twenty destinations sat behind up to three nested
// controls, so reaching one meant remembering which of the outer two it was
// filed under, and nothing on screen said where the open one sat.
//
// The blurb is the pane's own explanation of what it answers. It shows under
// the heading, so a destination can be understood before it is opened and
// without a legend somewhere else.

// Which endpoint a destination needs. The shell fetches the one belonging to
// whatever is open, rather than every section fetching on every change. "own"
// means the destination fetches for itself and the shell asks for nothing.
export type Feed = "usage" | "security" | "platform" | "settings" | "own";

interface Pane {
	id: string;
	label: string;
	blurb: string;
	feed: Feed;
}

export const adminNav = [
	{
		label: "Activity",
		panes: [
			{
				id: "overview",
				label: "Overview",
				blurb: "Adoption, cost and failures across the window.",
				feed: "usage",
			},
			{
				id: "reports",
				label: "Reports",
				blurb: "What is being opened, and by how many different people.",
				feed: "usage",
			},
			{
				id: "people",
				label: "People",
				blurb: "Who is using it, and what they have been doing.",
				feed: "usage",
			},
			{
				id: "performance",
				label: "Query performance",
				blurb: "Which sources warehouse time accumulates against.",
				feed: "usage",
			},
		],
	},
	{
		label: "Access",
		panes: [
			{
				id: "roles",
				label: "Roles",
				blurb: "What each role allows the people holding it to do.",
				feed: "own",
			},
			{
				id: "assignments",
				label: "Who holds what",
				blurb: "Every assignment, the subject it names and the scope it applies in.",
				feed: "own",
			},
			{
				id: "grants",
				label: "Direct grants",
				blurb: "Permission attached to one report or category rather than held through a role.",
				feed: "own",
			},
			{
				id: "review",
				label: "Access review",
				blurb: "Whether a given person can open a given report, and which rule decides it.",
				feed: "own",
			},
			{
				id: "baseline",
				label: "Baseline access",
				blurb: "Where reachability comes from, and the groups holding a permission before any role or grant does.",
				feed: "own",
			},
		],
	},
	{
		label: "Audit",
		panes: [
			{
				id: "changes",
				label: "Change log",
				blurb: "Every change the platform recorded, and who made it.",
				feed: "own",
			},
			{
				id: "exports",
				label: "Export audit",
				blurb: "Every request to take data out of the platform.",
				feed: "security",
			},
			{
				id: "partitioning",
				label: "Cache partitioning",
				blurb: "Which memberships decide who may be served a stored answer.",
				feed: "security",
			},
		],
	},
	{
		label: "Content",
		panes: [
			{
				id: "sources",
				label: "Sources",
				blurb: "The datasets reports are built on, and how each is read.",
				feed: "platform",
			},
			{
				id: "categories",
				label: "Categories",
				blurb: "The sections navigation is built from, and what sits in each.",
				feed: "own",
			},
			{
				id: "personal",
				label: "Personal pages",
				blurb: "What people have built for themselves, and who they shared it with.",
				feed: "own",
			},
		],
	},
	{
		label: "Platform",
		panes: [
			{
				id: "health",
				label: "Health",
				blurb: "What the instance that served this request is holding.",
				feed: "platform",
			},
			{
				id: "runtime",
				label: "Runtime",
				blurb: "Where this deployment is connected, and how it is hosted.",
				feed: "platform",
			},
			{
				id: "branding",
				label: "Branding",
				blurb: "The name and mark in the header of every page.",
				feed: "settings",
			},
			{
				id: "warehouse",
				label: "Warehouse",
				blurb: "Which warehouse runs the queries and which catalogue they read.",
				feed: "settings",
			},
			{
				id: "caching",
				label: "Caching",
				blurb: "How long answers and memberships are reused before being asked again.",
				feed: "settings",
			},
		],
	},
] as const satisfies readonly { label: string; panes: readonly Pane[] }[];

export type PaneId = (typeof adminNav)[number]["panes"][number]["id"];

const panesById = new Map<string, Pane>(
	adminNav.flatMap((group) => group.panes.map((pane) => [pane.id, pane])),
);

const defaultPane: PaneId = "overview";

// Reads a pane out of the URL. Anything the rail does not list falls back to
// the default rather than rendering an empty shell, so a stale bookmark or a
// hand-edited address opens somewhere real.
export function paneFrom(value: string | null): PaneId {
	return value && panesById.has(value)
		? (value as PaneId)
		: (defaultPane as PaneId);
}

export function paneDetail(id: PaneId): Pane {
	return panesById.get(id) ?? panesById.get(defaultPane)!;
}

// The group a pane sits in, for the heading above it. Read from the same list
// the rail renders, so the two cannot disagree about where something lives.
export function groupOf(id: PaneId): string {
	for (const group of adminNav) {
		if (group.panes.some((pane) => pane.id === id)) return group.label;
	}
	return "";
}
