"use client";

import { useState } from "react";
import {
	builtinThemes,
	parseCustomThemes,
	seriesCount,
	type ReportTheme,
} from "../../lib/visuals/themes";
import {
	ThemePreview,
	type ThemeGround,
	type ThemePart,
} from "../components/shared/ThemePreview";
import styles from "./Themes.module.css";

// The workspace's themes. Editors choose one on each report, under Edit, Report, Theme. Built-in
// ones are always offered, and changing one is stored as a theme with the same id, which takes
// its place on every report using it. Stored as text in one setting.

const starter: string[] = [
	"#2563eb",
	"#0d9488",
	"#d97706",
	"#7c3aed",
	"#db2777",
	"#0891b2",
	"#65a30d",
	"#dc2626",
];

const defaultHelp = "Point at a colour to see where it goes on a report.";

function partHelp(part: ThemePart | null): string {
	if (part === null) return defaultHelp;
	if (part === "accent") {
		return "Accent. Buttons, the selected tab and progress bars on the report.";
	}
	return `Chart colour ${part + 1}. The ${part === 0 ? "first" : `number ${part + 1}`} measure or category in any chart.`;
}

function ThemeCard({
	theme,
	ground,
	onChange,
	badge,
	actions,
}: {
	theme: ReportTheme;
	ground: ThemeGround;
	// Absent where the colours are shown and cannot be changed here.
	onChange?: (patch: Partial<ReportTheme>) => void;
	badge?: string;
	actions: React.ReactNode;
}) {
	const [pointed, setPointed] = useState<ThemePart | null>(null);
	const chart = Array.from(
		{ length: seriesCount },
		(_, i) => theme.chart[i % theme.chart.length],
	);
	const point = (part: ThemePart) => ({
		onMouseEnter: () => setPointed(part),
		onMouseLeave: () => setPointed(null),
		onFocus: () => setPointed(part),
		onBlur: () => setPointed(null),
	});
	const swatch = (part: ThemePart, value: string, label: string) =>
		onChange ? (
			<label key={label} className={styles.swatch} {...point(part)}>
				<input
					type="color"
					value={value}
					aria-label={`${theme.name}, ${label}`}
					onChange={(e) => {
						if (part === "accent") {
							onChange({ accent: e.target.value });
							return;
						}
						const next = [...chart];
						next[part] = e.target.value;
						onChange({ chart: next });
					}}
				/>
				<span>{label}</span>
			</label>
		) : (
			<span
				key={label}
				className={styles.swatch}
				tabIndex={0}
				{...point(part)}
			>
				<span
					className={styles.swatchChip}
					style={{ background: value }}
				/>
				<span>{label}</span>
			</span>
		);

	return (
		<div className={styles.card}>
			<ThemePreview theme={theme} ground={ground} highlight={pointed} />
			<div className={styles.cardHead}>
				{onChange ? (
					<input
						className={styles.name}
						value={theme.name}
						aria-label="Theme name"
						onChange={(e) =>
							onChange({ name: e.target.value || " " })
						}
					/>
				) : (
					<strong>{theme.name}</strong>
				)}
				{badge && <span className={styles.badge}>{badge}</span>}
				<span className={styles.cardActions}>{actions}</span>
			</div>
			<div className={styles.swatches}>
				{swatch("accent", theme.accent, "Accent")}
				<span className={styles.divider} aria-hidden="true" />
				{chart.map((color, i) => swatch(i, color, String(i + 1)))}
			</div>
			<p className={styles.help}>{partHelp(pointed)}</p>
		</div>
	);
}

export function ThemeManager({
	value,
	onChange,
}: {
	value: string;
	onChange: (next: string) => void;
}) {
	const [ground, setGround] = useState<ThemeGround>("dark");
	const themes = parseCustomThemes(value);
	const store = (next: ReportTheme[]) =>
		onChange(next.length > 0 ? JSON.stringify(next) : "");
	const update = (id: string, patch: Partial<ReportTheme>) =>
		store(themes.map((t) => (t.id === id ? { ...t, ...patch } : t)));
	const remove = (id: string) => store(themes.filter((t) => t.id !== id));
	const copy = (theme: ReportTheme) =>
		store([
			...themes,
			{
				...theme,
				id: `custom-${Date.now()}`,
				name: `${theme.name} copy`,
			},
		]);

	const builtinIds = new Set(builtinThemes.map((t) => t.id));
	const changedIds = new Set(themes.map((t) => t.id));
	const own = themes.filter((t) => !builtinIds.has(t.id));
	const originals = builtinThemes.map(
		(theme) => themes.find((t) => t.id === theme.id) ?? theme,
	);

	return (
		<div className={styles.themes}>
			<div className={styles.intro}>
				<p>
					Choose one on a report under Edit, then Report, then Theme.
					Each reader&apos;s light or dark choice stays theirs.
				</p>
				<div
					className={styles.segments}
					role="group"
					aria-label="Preview on"
				>
					{(
						[
							["dark", "On dark"],
							["light", "On light"],
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							className={`${styles.segment} ${ground === id ? styles.segmentOn : ""}`}
							aria-pressed={ground === id}
							onClick={() => setGround(id)}
						>
							{label}
						</button>
					))}
				</div>
			</div>

			<h3 className={styles.heading}>Built in</h3>
			<div className={styles.grid}>
				{originals.map((theme) => {
					const changed = changedIds.has(theme.id);
					return (
						<ThemeCard
							key={theme.id}
							theme={theme}
							ground={ground}
							badge={changed ? "Changed" : undefined}
							onChange={
								changed
									? (patch) => update(theme.id, patch)
									: undefined
							}
							actions={
								<>
									<button
										type="button"
										className={styles.button}
										onClick={() => copy(theme)}
									>
										Make a copy
									</button>
									{changed ? (
										<button
											type="button"
											className={styles.button}
											onClick={() => remove(theme.id)}
										>
											Back to the original
										</button>
									) : (
										<button
											type="button"
											className={styles.button}
											onClick={() =>
												store([...themes, theme])
											}
										>
											Change colours
										</button>
									)}
								</>
							}
						/>
					);
				})}
			</div>

			<div className={styles.headingRow}>
				<h3 className={styles.heading}>Your themes</h3>
				<button
					type="button"
					className={styles.add}
					onClick={() =>
						store([
							...themes,
							{
								id: `custom-${Date.now()}`,
								name: "New theme",
								accent: starter[0],
								chart: starter,
							},
						])
					}
				>
					Add a theme
				</button>
			</div>
			{own.length === 0 ? (
				<p className={styles.none}>
					None yet. Add one, or make a copy of a built-in theme.
				</p>
			) : (
				<div className={styles.grid}>
					{own.map((theme) => (
						<ThemeCard
							key={theme.id}
							theme={theme}
							ground={ground}
							onChange={(patch) => update(theme.id, patch)}
							actions={
								<button
									type="button"
									className={styles.button}
									onClick={() => remove(theme.id)}
								>
									Remove
								</button>
							}
						/>
					))}
				</div>
			)}
		</div>
	);
}
