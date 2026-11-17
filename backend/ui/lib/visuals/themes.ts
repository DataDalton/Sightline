// Report themes: a named accent and set of chart colours.
//
// Applied by overriding the same custom properties the whole interface reads, so
// a theme reaches charts, tiles and controls without any of them knowing about
// themes. Colours only, because the surfaces belong to the reader's light or dark
// choice, and a report that fought that choice would be unreadable in one of them.
// That is also why the built-in sets are chosen to hold up against both grounds.

export interface ReportTheme {
	id: string;
	name: string;
	accent: string;
	// One colour per series position.
	chart: string[];
}

export const seriesCount = 8;

// Every colour here holds up on both the light and the dark report ground, and
// the colours within a theme stay far enough apart to tell series apart. The
// test beside this file checks both, so a theme added later meets the same bar.
// The last two are shades of one hue, for a report that wants a calm look.
export const builtinThemes: ReportTheme[] = [
	{
		id: "ocean",
		name: "Ocean",
		accent: "#0284c7",
		chart: [
			"#0284c7",
			"#0d9488",
			"#4f46e5",
			"#0891b2",
			"#7c3aed",
			"#059669",
			"#2563eb",
			"#64748b",
		],
	},
	{
		id: "forest",
		name: "Forest",
		accent: "#15803d",
		chart: [
			"#15803d",
			"#a16207",
			"#0f766e",
			"#65a30d",
			"#b45309",
			"#4d7c0f",
			"#0e7490",
			"#92400e",
		],
	},
	{
		id: "sunset",
		name: "Sunset",
		accent: "#ea580c",
		chart: [
			"#ea580c",
			"#be185d",
			"#d97706",
			"#9333ea",
			"#dc2626",
			"#c026d3",
			"#b45309",
			"#e11d48",
		],
	},
	{
		id: "slate",
		name: "Slate",
		accent: "#475569",
		chart: [
			"#475569",
			"#0284c7",
			"#94a3b8",
			"#0f766e",
			"#4d7c0f",
			"#7c3aed",
			"#be185d",
			"#b45309",
		],
	},
	{
		id: "clear",
		name: "Clear view",
		accent: "#0072b2",
		chart: [
			"#0072b2",
			"#e69f00",
			"#009e73",
			"#cc79a7",
			"#d55e00",
			"#56b4e9",
			"#a68b00",
			"#7f7f7f",
		],
	},
	{
		id: "vivid",
		name: "Vivid",
		accent: "#2563eb",
		chart: [
			"#2563eb",
			"#dc2626",
			"#16a34a",
			"#9333ea",
			"#ea580c",
			"#0891b2",
			"#c026d3",
			"#ca8a04",
		],
	},
	{
		id: "aurora",
		name: "Aurora",
		accent: "#059669",
		chart: [
			"#059669",
			"#0891b2",
			"#7c3aed",
			"#65a30d",
			"#2563eb",
			"#c026d3",
			"#0d9488",
			"#4f46e5",
		],
	},
	{
		id: "twilight",
		name: "Twilight",
		accent: "#7c3aed",
		chart: [
			"#7c3aed",
			"#db2777",
			"#4f46e5",
			"#e11d48",
			"#a21caf",
			"#2563eb",
			"#ea580c",
			"#0891b2",
		],
	},
	{
		id: "earth",
		name: "Earth",
		accent: "#92400e",
		chart: [
			"#92400e",
			"#65a30d",
			"#b45309",
			"#57534e",
			"#a16207",
			"#3f6212",
			"#c2410c",
			"#0f766e",
		],
	},
	{
		id: "berry",
		name: "Berry",
		accent: "#be185d",
		chart: [
			"#be185d",
			"#7e22ce",
			"#e11d48",
			"#4338ca",
			"#c026d3",
			"#9f1239",
			"#b45309",
			"#ea580c",
		],
	},
	{
		id: "citrus",
		name: "Citrus",
		accent: "#d97706",
		chart: [
			"#d97706",
			"#65a30d",
			"#ea580c",
			"#ca8a04",
			"#16a34a",
			"#c2410c",
			"#4d7c0f",
			"#b45309",
		],
	},
	{
		id: "mineral",
		name: "Mineral",
		accent: "#0f766e",
		chart: [
			"#0f766e",
			"#b91c1c",
			"#1d4ed8",
			"#a16207",
			"#7e22ce",
			"#be123c",
			"#047857",
			"#c2410c",
		],
	},
	{
		id: "lagoon",
		name: "Lagoon",
		accent: "#0e7490",
		chart: [
			"#0e7490",
			"#16a34a",
			"#0284c7",
			"#65a30d",
			"#0d9488",
			"#2563eb",
			"#15803d",
			"#a16207",
		],
	},
	{
		id: "desert",
		name: "Desert",
		accent: "#c2410c",
		chart: [
			"#c2410c",
			"#a16207",
			"#78716c",
			"#b45309",
			"#9a3412",
			"#a8a29e",
			"#d97706",
			"#be123c",
		],
	},
	{
		id: "orchard",
		name: "Orchard",
		accent: "#16a34a",
		chart: [
			"#16a34a",
			"#dc2626",
			"#ca8a04",
			"#be185d",
			"#4d7c0f",
			"#ea580c",
			"#15803d",
			"#9f1239",
		],
	},
	{
		id: "contrast",
		name: "High contrast",
		accent: "#1d4ed8",
		chart: [
			"#1d4ed8",
			"#c2410c",
			"#15803d",
			"#7e22ce",
			"#be123c",
			"#0e7490",
			"#a16207",
			"#6b7280",
		],
	},
	{
		id: "heritage",
		name: "Heritage",
		accent: "#4e6e9e",
		chart: [
			"#4e6e9e",
			"#d07a32",
			"#b4504f",
			"#5d9a95",
			"#5a8f48",
			"#b8962e",
			"#8e6e96",
			"#a8746a",
		],
	},
	{
		id: "fjord",
		name: "Fjord",
		accent: "#4c6a92",
		chart: [
			"#4c6a92",
			"#5f8fa3",
			"#a3555e",
			"#c07b56",
			"#6f9165",
			"#8e6f93",
			"#b38f3f",
			"#3f7a7a",
		],
	},
	{
		id: "blues",
		name: "Blue shades",
		accent: "#2563eb",
		chart: [
			"#1d4ed8",
			"#2563eb",
			"#3b82f6",
			"#60a5fa",
			"#0369a1",
			"#0284c7",
			"#0ea5e9",
			"#38bdf8",
		],
	},
	{
		id: "greens",
		name: "Green shades",
		accent: "#15803d",
		chart: [
			"#15803d",
			"#16a34a",
			"#22c55e",
			"#047857",
			"#059669",
			"#10b981",
			"#65a30d",
			"#4d7c0f",
		],
	},
];

const hexColor = /^#[0-9a-fA-F]{6}$/;

// Themes an administrator has defined, stored as text in the settings table.
// Anything malformed is dropped rather than applied, because a bad colour would
// quietly fall back to something nobody chose.
export function parseCustomThemes(raw: unknown): ReportTheme[] {
	if (typeof raw !== "string" || raw.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const themes: ReportTheme[] = [];
	for (const entry of parsed) {
		const held = entry as Partial<ReportTheme> | null;
		if (typeof held?.id !== "string" || !held.id) continue;
		if (typeof held.name !== "string" || !held.name.trim()) continue;
		if (typeof held.accent !== "string" || !hexColor.test(held.accent)) {
			continue;
		}
		const chart = Array.isArray(held.chart)
			? held.chart.filter(
					(c): c is string =>
						typeof c === "string" && hexColor.test(c),
				)
			: [];
		if (chart.length === 0) continue;
		themes.push({
			id: held.id,
			name: held.name,
			accent: held.accent,
			chart,
		});
	}
	return themes;
}

// An administrator's theme wins over a built-in with the same id, so a built-in
// can be adjusted without every report that uses it being changed.
export function allThemes(custom: ReportTheme[]): ReportTheme[] {
	const ids = new Set(custom.map((theme) => theme.id));
	return [...custom, ...builtinThemes.filter((t) => !ids.has(t.id))];
}

// Dark or white text on the accent, whichever reads. The app's own text colour
// on a button suits its yellow and is unreadable on a dark accent.
export function contrastOn(hex: string): string {
	const channel = (offset: number) => {
		const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928
			? value / 12.92
			: ((value + 0.055) / 1.055) ** 2.4;
	};
	const luminance =
		0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
	// The luminance at which black and white text read equally well.
	return luminance > 0.179 ? "#16181d" : "#ffffff";
}

// The custom properties a theme sets. A shorter list of colours repeats, so every
// series position still has one. The subtle tint is mixed against the raised
// surface, so it is pale on light and dark on dark from one value.
export function themeTokens(theme: ReportTheme): Record<string, string> {
	const tokens: Record<string, string> = {
		"--brand": theme.accent,
		"--brand-strong": theme.accent,
		"--brand-contrast": contrastOn(theme.accent),
		"--brand-text": theme.accent,
		"--brand-subtle": `color-mix(in srgb, ${theme.accent} 18%, var(--surface-raised))`,
	};
	for (let i = 0; i < seriesCount; i++) {
		tokens[`--chart-${i + 1}`] = theme.chart[i % theme.chart.length];
	}
	return tokens;
}
