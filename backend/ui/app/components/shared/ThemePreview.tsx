"use client";

import { seriesCount, type ReportTheme } from "../../../lib/visuals/themes";
import styles from "./ThemePreview.module.css";

// A small report drawn in a theme, so its colours can be judged where they end up. A real report
// takes its accent and chart colours the same way.

export type ThemePart = "accent" | number;

// The two grounds a report can sit on, so a theme is judged on either rather than on whichever
// the viewer happens to have on. Fixed, because the preview shows a choice of ground.
const grounds = {
	dark: {
		page: "#131519",
		card: "#1a1d22",
		line: "#2f343c",
		text: "#eef1f5",
		muted: "#8b95a3",
	},
	light: {
		page: "#f1f3f6",
		card: "#ffffff",
		line: "#d9dee4",
		text: "#1a2433",
		muted: "#667180",
	},
};

export type ThemeGround = keyof typeof grounds;

// Bars and lines with a fixed shape, so one theme differs from another only in its colours.
const barHeights = [62, 88, 48, 74, 36, 56, 28, 42];
const linePoints = [
	[12, 34, 26, 48, 40, 62, 55],
	[44, 40, 52, 38, 46, 34, 42],
	[66, 58, 70, 64, 74, 70, 80],
];

function contrastOn(hex: string): string {
	const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16);
	const brightness =
		(channel(1) * 299 + channel(3) * 587 + channel(5) * 114) / 1000;
	return brightness > 150 ? "#111418" : "#ffffff";
}

export function ThemePreview({
	theme,
	ground = "dark",
	highlight = null,
}: {
	theme: Pick<ReportTheme, "accent" | "chart">;
	ground?: ThemeGround;
	// Fades everything but this part, to show where one colour goes.
	highlight?: ThemePart | null;
}) {
	const look = grounds[ground];
	const seen = (part: ThemePart) =>
		highlight === null || highlight === part ? 1 : 0.15;
	const series = (index: number) => theme.chart[index % theme.chart.length];
	const accent = { opacity: seen("accent") };

	return (
		<div
			className={styles.preview}
			style={{ background: look.page, color: look.text }}
			aria-hidden="true"
		>
			<div className={styles.head}>
				<span className={styles.title}>Revenue Overview</span>
				<span
					className={styles.button}
					style={{
						...accent,
						background: theme.accent,
						color: contrastOn(theme.accent),
					}}
				>
					Button
				</span>
			</div>
			<div className={styles.tabs} style={{ borderColor: look.line }}>
				<span
					className={styles.tabOn}
					style={{ ...accent, borderColor: theme.accent }}
				>
					Selected tab
				</span>
				<span style={{ color: look.muted }}>Another tab</span>
			</div>
			<div className={styles.tiles}>
				{["Revenue", "Margin"].map((label, index) => (
					<div
						key={label}
						className={styles.tile}
						style={{
							background: look.card,
							borderColor: look.line,
						}}
					>
						<span style={{ color: look.muted }}>{label}</span>
						<strong>{index === 0 ? "$10.8M" : "$4.6M"}</strong>
						<span
							className={styles.track}
							style={{ background: look.line }}
						>
							<span
								className={styles.fill}
								style={{
									...accent,
									width: index === 0 ? "90%" : "62%",
									background: theme.accent,
								}}
							/>
						</span>
					</div>
				))}
			</div>
			<div className={styles.charts}>
				<svg
					viewBox="0 0 160 96"
					className={styles.chart}
					style={{ background: look.card, borderColor: look.line }}
				>
					{barHeights.slice(0, seriesCount).map((height, index) => (
						<rect
							key={index}
							x={8 + index * 18.5}
							y={92 - height}
							width={13}
							height={height}
							rx={1.5}
							fill={series(index)}
							opacity={seen(index)}
						/>
					))}
				</svg>
				<svg
					viewBox="0 0 160 96"
					className={styles.chart}
					style={{ background: look.card, borderColor: look.line }}
				>
					{linePoints.map((points, index) => (
						<polyline
							key={index}
							fill="none"
							stroke={series(index)}
							strokeWidth={2}
							strokeLinejoin="round"
							opacity={seen(index)}
							points={points
								.map((y, at) => `${8 + at * 24},${92 - y}`)
								.join(" ")}
						/>
					))}
				</svg>
			</div>
		</div>
	);
}
