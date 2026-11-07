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

export const builtinThemes: ReportTheme[] = [
	{
		id: "ocean",
		name: "Ocean",
		accent: "#0ea5e9",
		chart: [
			"#0ea5e9",
			"#14b8a6",
			"#6366f1",
			"#22d3ee",
			"#3b82f6",
			"#2dd4bf",
			"#818cf8",
			"#38bdf8",
		],
	},
	{
		id: "forest",
		name: "Forest",
		accent: "#22a35a",
		chart: [
			"#22a35a",
			"#84a93f",
			"#0f9d8a",
			"#c28f2c",
			"#5f9e6e",
			"#a3b18a",
			"#3f8f5f",
			"#b5892e",
		],
	},
	{
		id: "sunset",
		name: "Sunset",
		accent: "#ea580c",
		chart: [
			"#ea580c",
			"#db2777",
			"#d97706",
			"#c026d3",
			"#dc2626",
			"#f59e0b",
			"#be185d",
			"#9333ea",
		],
	},
	{
		id: "slate",
		name: "Slate",
		accent: "#64748b",
		chart: [
			"#64748b",
			"#94a3b8",
			"#475569",
			"#0ea5e9",
			"#7c8ba1",
			"#a8b3c2",
			"#526077",
			"#38bdf8",
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

// The custom properties a theme sets. A shorter list of colours repeats, so every
// series position still has one.
export function themeTokens(theme: ReportTheme): Record<string, string> {
	const tokens: Record<string, string> = {
		"--brand": theme.accent,
		"--brand-strong": theme.accent,
	};
	for (let i = 0; i < seriesCount; i++) {
		tokens[`--chart-${i + 1}`] = theme.chart[i % theme.chart.length];
	}
	return tokens;
}
