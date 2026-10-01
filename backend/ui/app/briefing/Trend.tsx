import type { Point } from "../../lib/briefing/card";
import styles from "./Briefing.module.css";

// A figure's recent history with its usual range behind it.
//
// The shaded band is where the latest period would have been unremarkable,
// so a final point outside it reads as unusual before any number is read.
// Periods that have not settled, or not loaded, are drawn dotted, since they
// may still change. Drawn in a fixed coordinate space and stretched to its
// box, with strokes that keep their width, so one drawing fits a wide card
// and a small tile.

const width = 300;
const height = 80;
const pad = 6;

export function Trend({
	series,
	low,
	high,
	tone,
	compact = false,
}: {
	series: Point[];
	low: number | null;
	high: number | null;
	tone: "good" | "bad" | "neutral";
	compact?: boolean;
}) {
	if (series.length < 2) return null;
	const values = series.map((p) => p.value);
	const all = [
		...values,
		...(low !== null ? [low] : []),
		...(high !== null ? [high] : []),
	];
	let min = Math.min(...all);
	let max = Math.max(...all);
	if (min === max) {
		min -= 1;
		max += 1;
	}
	const y = (v: number) =>
		pad + (height - 2 * pad) * (1 - (v - min) / (max - min));
	const x = (i: number) => (width * i) / (series.length - 1);
	const path = (from: number, to: number) =>
		values
			.slice(from, to + 1)
			.map(
				(v, i) =>
					`${i === 0 ? "M" : "L"}${x(from + i).toFixed(1)},${y(v).toFixed(1)}`,
			)
			.join(" ");
	const line = path(0, values.length - 1);
	const area = `${line} L${width},${height} L0,${height} Z`;
	const last = values[values.length - 1];
	// The settled part is drawn solid up to the last settled point, and the
	// rest dotted from there.
	const firstPending = series.findIndex((p) => p.pending);
	const settledEnd =
		firstPending < 0 ? values.length - 1 : Math.max(firstPending - 1, 0);
	const pending = firstPending >= 0;

	return (
		<svg
			className={`${styles.trend} ${compact ? styles.trendCompact : ""}`}
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			role="img"
			aria-label="Recent history against the usual range"
			data-tone={tone}
		>
			{low !== null && high !== null && (
				<rect
					className={styles.trendBand}
					x={0}
					width={width}
					y={y(high)}
					height={Math.max(y(low) - y(high), 1)}
				/>
			)}
			<path className={styles.trendArea} d={area} />
			{settledEnd > 0 && (
				<path
					className={styles.trendLine}
					d={path(0, settledEnd)}
					vectorEffect="non-scaling-stroke"
				/>
			)}
			{pending && (
				<path
					className={`${styles.trendLine} ${styles.trendPending}`}
					d={path(settledEnd, values.length - 1)}
					vectorEffect="non-scaling-stroke"
				/>
			)}
			<line
				className={`${styles.trendDot} ${pending ? styles.trendDotPending : ""}`}
				x1={width}
				x2={width}
				y1={y(last)}
				y2={y(last)}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
