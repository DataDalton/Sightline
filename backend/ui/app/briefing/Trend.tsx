import type { Point } from "../../lib/briefing/card";
import styles from "./Briefing.module.css";

// A figure's recent history with its usual range behind it.
//
// The shaded band is where the latest period would have been unremarkable,
// so a final point outside it reads as unusual before any number is read.
// Drawn in a fixed coordinate space and stretched to its box, with strokes
// that keep their width, so one drawing fits a wide card and a small tile.

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
	const line = values
		.map(
			(v, i) =>
				`${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`,
		)
		.join(" ");
	const area = `${line} L${width},${height} L0,${height} Z`;
	const last = values[values.length - 1];

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
			<path
				className={styles.trendLine}
				d={line}
				vectorEffect="non-scaling-stroke"
			/>
			<line
				className={styles.trendDot}
				x1={width}
				x2={width}
				y1={y(last)}
				y2={y(last)}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
