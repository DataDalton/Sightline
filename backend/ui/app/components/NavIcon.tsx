// The marks beside each entry in the navigation, and on each category's card
// on the home page. A category names its mark by key, and an unknown key
// draws the default.

// The app's own pages. Not offered for categories, so a category never looks
// like a page of the app.
const pageIconPaths: Record<string, string> = {
	home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
	mine: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
	dictionary:
		"M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM9 7h7M9 11h5",
	explore: "M3 3h18v4H3zM3 10h18M3 15h18M3 20h18M9 10v10M15 10v10",
	// The same mark as the Ask button, so the two read as one feature.
	assist: "M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z",
	admin: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
	sheets: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18",
	status: "M22 12h-4l-3 9L9 3l-3 9H2",
	updates: "M3 11l18-8-8 18-2-8-8-2z",
	// A speech bubble with a magnifier, for reading conversations under review.
	review: "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 1 1 21 11.5zM11 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM13.2 13.2 15 15",
	// A board of three columns, for the work queue.
	work: "M3 4h18v16H3zM9 4v16M15 4v16M5 7h2M11 7h2M17 7h2M11 10h2",
	inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
	default: "M3 7h7v6H3zM14 7h7v6h-7zM3 16h18v5H3z",
};

export interface CategoryIcon {
	key: string;
	label: string;
	path: string;
}

// The marks a category can choose from, named by what they show rather than by
// any subject, so one set serves every organisation. Grouped loosely by theme,
// which is the order the picker lists them in.
export const categoryIcons: CategoryIcon[] = [
	// Measures and charts
	{
		key: "chart-line",
		label: "Line chart",
		path: "M3 3v18h18M7 15l4-4 3 3 5-6",
	},
	{
		key: "chart-rising",
		label: "Rising trend",
		path: "M3 3v18h18M7 16l3-6 4 4 4-8",
	},
	{ key: "chart-bar", label: "Bar chart", path: "M18 20V10M12 20V4M6 20v-6" },
	{
		key: "chart-pie",
		label: "Pie chart",
		path: "M21.2 15.9A10 10 0 1 1 8 2.8M22 12A10 10 0 0 0 12 2v10z",
	},
	{
		key: "gauge",
		label: "Gauge",
		path: "M12 14l4-4M3.3 19a10 10 0 1 1 17.4 0",
	},
	{
		key: "target",
		label: "Target",
		path: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
	},
	{ key: "activity", label: "Pulse", path: "M22 12h-4l-3 9L9 3l-3 9H2" },
	{
		key: "percent",
		label: "Percent",
		path: "M19 5L5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
	},
	// Money and trade
	{
		key: "dollar",
		label: "Money",
		path: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
	},
	{
		key: "wallet",
		label: "Wallet",
		path: "M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5M16 14h.01",
	},
	{ key: "card", label: "Payment card", path: "M1 4h22v16H1zM1 10h22" },
	{
		key: "receipt",
		label: "Receipt",
		path: "M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM8 8h8M8 12h8M8 16h5",
	},
	{
		key: "tag",
		label: "Price tag",
		path: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01",
	},
	{
		key: "cart",
		label: "Cart",
		path: "M9 22a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM20 22a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6",
	},
	{
		key: "box",
		label: "Package",
		path: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
	},
	{
		key: "truck",
		label: "Delivery",
		path: "M1 3h15v13H1zM16 8h4l3 3v5h-7zM5.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
	},
	{
		key: "factory",
		label: "Factory",
		path: "M2 20V8l6 4V8l6 4V4h8v16zM2 20h20M17 16h1M12 16h1M7 16h1",
	},
	// Documents and work
	{
		key: "document",
		label: "Document",
		path: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4",
	},
	{
		key: "clipboard",
		label: "Checklist",
		path: "M9 2h6v4H9zM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 14l2 2 4-4",
	},
	{
		key: "folder",
		label: "Folder",
		path: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
	},
	{
		key: "book",
		label: "Book",
		path: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15zM20 17v5H6.5A2.5 2.5 0 0 1 4 19.5",
	},
	{
		key: "briefcase",
		label: "Briefcase",
		path: "M2 7h20v14H2zM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M2 13h20",
	},
	{
		key: "calendar",
		label: "Calendar",
		path: "M3 4h18v18H3zM16 2v4M8 2v4M3 10h18",
	},
	{
		key: "clock",
		label: "Clock",
		path: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
	},
	{
		key: "grid",
		label: "Grid",
		path: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
	},
	{
		key: "table",
		label: "Table",
		path: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18",
	},
	{
		key: "search",
		label: "Search",
		path: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
	},
	// People and places
	{
		key: "people",
		label: "People",
		path: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87",
	},
	{
		key: "person",
		label: "Person",
		path: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
	},
	{
		key: "headset",
		label: "Support",
		path: "M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z",
	},
	{ key: "mail", label: "Mail", path: "M2 4h20v16H2zM22 6l-10 7L2 6" },
	{
		key: "megaphone",
		label: "Megaphone",
		path: "M3 11v3l14 5V6zM11.6 16.8a3 3 0 1 1-5.8-1.6",
	},
	{
		key: "building",
		label: "Building",
		path: "M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18zM2 22h20M9 6h2M13 6h2M9 10h2M13 10h2M9 14h2M13 14h2M10 22v-4h4v4",
	},
	{
		key: "hospital",
		label: "Health care",
		path: "M3 21V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14zM12 8v6M9 11h6M1 21h22",
	},
	{
		key: "heart",
		label: "Heart",
		path: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z",
	},
	{
		key: "map-pin",
		label: "Location",
		path: "M12 2a8 8 0 0 0-8 8c0 5.5 8 12 8 12s8-6.5 8-12a8 8 0 0 0-8-8zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
	},
	{
		key: "map",
		label: "Map",
		path: "M1 6v16l7-4 8 4 7-4V2l-7 4-8-4zM8 2v16M16 6v16",
	},
	{
		key: "globe",
		label: "Globe",
		path: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
	},
	{
		key: "plane",
		label: "Travel",
		path: "M2 16l20-8-4 12-6-4-3 4v-5l9-7-11 6z",
	},
	{
		key: "graduation",
		label: "Learning",
		path: "M22 10L12 5 2 10l10 5zM6 12v5c3 3 9 3 12 0v-5",
	},
	// Data, technology and control
	{
		key: "database",
		label: "Database",
		path: "M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5",
	},
	{
		key: "server",
		label: "Server",
		path: "M2 2h20v8H2zM2 14h20v8H2zM6 6h.01M6 18h.01",
	},
	{
		key: "layers",
		label: "Layers",
		path: "M12 2L2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
	},
	{
		key: "cloud",
		label: "Cloud",
		path: "M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z",
	},
	{
		key: "cpu",
		label: "Chip",
		path: "M4 4h16v16H4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3",
	},
	{ key: "code", label: "Code", path: "M16 18l6-6-6-6M8 6l-6 6 6 6" },
	{
		key: "link",
		label: "Link",
		path: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
	},
	{
		key: "shield",
		label: "Shield",
		path: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
	},
	{
		key: "lock",
		label: "Lock",
		path: "M5 11h14v11H5zM7 11V7a5 5 0 0 1 10 0v4",
	},
	{
		key: "key",
		label: "Key",
		path: "M21 2l-2 2M15.5 7.5l3 3L22 7l-3-3M11.4 11.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zM11.4 11.6L19 4",
	},
	{
		key: "wrench",
		label: "Maintenance",
		path: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z",
	},
	{
		key: "flask",
		label: "Research",
		path: "M9 2h6M10 2v7.5L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9.5V2M7 15h10",
	},
	{ key: "zap", label: "Energy", path: "M13 2L3 14h9l-1 8 10-12h-9z" },
	{
		key: "leaf",
		label: "Leaf",
		path: "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10zM2 21c0-3 1.9-5.4 5-6",
	},
	// Signals
	{
		key: "bell",
		label: "Bell",
		path: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
	},
	{
		key: "flag",
		label: "Flag",
		path: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7",
	},
	{
		key: "star",
		label: "Star",
		path: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
	},
	{
		key: "award",
		label: "Award",
		path: "M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM8.2 13.9L7 23l5-3 5 3-1.2-9.1",
	},
];

const iconPaths: Record<string, string> = {
	...pageIconPaths,
	...Object.fromEntries(categoryIcons.map((icon) => [icon.key, icon.path])),
};

export function NavIcon({
	name,
	size = 18,
}: {
	name: string | null;
	size?: number;
}) {
	const path = iconPaths[name ?? "default"] ?? iconPaths.default;
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}
