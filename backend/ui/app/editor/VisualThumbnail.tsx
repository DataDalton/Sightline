"use client";

// Miniature previews of each visual type.
//
// A picker that lists "Waterfall" and "Treemap" as words asks an author to
// already know what those look like. A small drawing of the mark answers the
// question directly, which matters most for the types people reach for least
// often, and those are exactly the ones a text list hides.
//
// Drawn as inline SVG on a 64 by 40 viewbox rather than rendered from real
// data: a preview has to be instant and identical every time, and a live
// chart would be neither.
//
// Still. What a control does is answered by the preview beside the card, drawn
// at a size where the answer fits; a drawing this size that moves is a thing
// twitching in the corner of the eye while somebody reads the one next to it.

import styles from "./VisualThumbnail.module.css";

interface ThumbnailProps {
	type: string;
	// Sized by the caller so the same drawing works in a grid and in a list.
	size?: number;
}

const bar = "var(--chart-1)";
const alt = "var(--chart-2)";
const third = "var(--chart-3)";
const muted = "var(--border-strong)";

function Frame({ children }: { children: React.ReactNode }) {
	return (
		<svg
			viewBox="0 0 64 40"
			width="100%"
			height="100%"
			role="presentation"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

// Baseline and left axis, shared by the cartesian previews so they read as a
// family rather than as unrelated drawings.
function Axes() {
	return (
		<>
			<line
				x1="8"
				y1="34"
				x2="60"
				y2="34"
				stroke={muted}
				strokeWidth="1"
			/>
			<line x1="8" y1="6" x2="8" y2="34" stroke={muted} strokeWidth="1" />
		</>
	);
}

export function VisualThumbnail({ type, size = 40 }: ThumbnailProps) {
	const content = (() => {
		switch (type) {
			case "kpiRow":
				return (
					<>
						<rect
							x="4"
							y="10"
							width="16"
							height="20"
							rx="2"
							fill={bar}
							opacity="0.25"
						/>
						<rect
							x="6"
							y="14"
							width="10"
							height="3"
							rx="1"
							fill={bar}
						/>
						<rect
							x="6"
							y="20"
							width="12"
							height="6"
							rx="1"
							fill={bar}
						/>
						<rect
							x="24"
							y="10"
							width="16"
							height="20"
							rx="2"
							fill={alt}
							opacity="0.25"
						/>
						<rect
							x="26"
							y="14"
							width="10"
							height="3"
							rx="1"
							fill={alt}
						/>
						<rect
							x="26"
							y="20"
							width="12"
							height="6"
							rx="1"
							fill={alt}
						/>
						<rect
							x="44"
							y="10"
							width="16"
							height="20"
							rx="2"
							fill={third}
							opacity="0.25"
						/>
						<rect
							x="46"
							y="14"
							width="10"
							height="3"
							rx="1"
							fill={third}
						/>
						<rect
							x="46"
							y="20"
							width="12"
							height="6"
							rx="1"
							fill={third}
						/>
					</>
				);

			case "gauge":
				return (
					<>
						<path
							d="M14 30 A18 18 0 0 1 50 30"
							fill="none"
							stroke={muted}
							strokeWidth="5"
							strokeLinecap="round"
						/>
						<path
							d="M14 30 A18 18 0 0 1 38 13.5"
							fill="none"
							stroke={bar}
							strokeWidth="5"
							strokeLinecap="round"
						/>
					</>
				);

			case "barChart":
				return (
					<>
						<Axes />
						<rect
							x="13"
							y="20"
							width="7"
							height="14"
							fill={bar}
							rx="1"
						/>
						<rect
							x="24"
							y="12"
							width="7"
							height="22"
							fill={bar}
							rx="1"
						/>
						<rect
							x="35"
							y="24"
							width="7"
							height="10"
							fill={bar}
							rx="1"
						/>
						<rect
							x="46"
							y="17"
							width="7"
							height="17"
							fill={bar}
							rx="1"
						/>
					</>
				);

			case "horizontalBarChart":
				return (
					<>
						<line
							x1="10"
							y1="6"
							x2="10"
							y2="34"
							stroke={muted}
							strokeWidth="1"
						/>
						<rect
							x="11"
							y="9"
							width="30"
							height="6"
							fill={bar}
							rx="1"
						/>
						<rect
							x="11"
							y="18"
							width="44"
							height="6"
							fill={bar}
							rx="1"
						/>
						<rect
							x="11"
							y="27"
							width="20"
							height="6"
							fill={bar}
							rx="1"
						/>
					</>
				);

			case "comboChart":
				return (
					<>
						<Axes />
						<rect
							x="13"
							y="22"
							width="7"
							height="12"
							fill={bar}
							rx="1"
						/>
						<rect
							x="24"
							y="16"
							width="7"
							height="18"
							fill={bar}
							rx="1"
						/>
						<rect
							x="35"
							y="25"
							width="7"
							height="9"
							fill={bar}
							rx="1"
						/>
						<rect
							x="46"
							y="19"
							width="7"
							height="15"
							fill={bar}
							rx="1"
						/>
						<polyline
							points="16,14 27,9 38,17 49,11"
							fill="none"
							stroke={third}
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</>
				);

			case "lineChart":
				return (
					<>
						<Axes />
						<polyline
							points="11,27 22,16 33,21 44,10 57,14"
							fill="none"
							stroke={bar}
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</>
				);

			case "areaChart":
				return (
					<>
						<Axes />
						<path
							d="M11 27 L22 16 L33 21 L44 10 L57 14 L57 34 L11 34 Z"
							fill={bar}
							opacity="0.28"
						/>
						<polyline
							points="11,27 22,16 33,21 44,10 57,14"
							fill="none"
							stroke={bar}
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</>
				);

			case "timelineChart":
				return (
					<>
						{[
							{ y: 8, x: 6, w: 22 },
							{ y: 16, x: 14, w: 26 },
							{ y: 24, x: 26, w: 30 },
						].map((span) => (
							<rect
								key={span.y}
								x={span.x}
								y={span.y}
								width={span.w}
								height="5"
								fill={bar}
								rx="2"
							/>
						))}
					</>
				);

			case "calendarChart":
				return (
					<>
						{Array.from({ length: 12 }, (_, wk) =>
							Array.from({ length: 5 }, (_, day) => (
								<rect
									key={`${wk}-${day}`}
									x={5 + wk * 4.6}
									y={9 + day * 4.6}
									width="3.6"
									height="3.6"
									fill={bar}
									fillOpacity={
										0.15 + ((wk * 3 + day * 5) % 7) / 8
									}
									rx="0.6"
								/>
							)),
						)}
					</>
				);

			case "choroplethChart":
				return (
					<>
						<rect
							x="4"
							y="8"
							width="56"
							height="24"
							fill={muted}
							opacity="0.2"
							rx="1"
						/>
						<path
							d="M8 14 L18 11 L24 16 L20 24 L10 22 Z"
							fill={bar}
						/>
						<path
							d="M26 12 L38 10 L42 18 L32 24 L26 20 Z"
							fill={bar}
							fillOpacity="0.5"
						/>
						<path
							d="M44 13 L56 12 L57 22 L46 25 Z"
							fill={bar}
							fillOpacity="0.8"
						/>
					</>
				);

			case "sankeyChart":
				return (
					<>
						<path
							d="M12 12 C32 12, 32 15, 52 15"
							fill="none"
							stroke={bar}
							strokeOpacity="0.45"
							strokeWidth="7"
						/>
						<path
							d="M12 24 C32 24, 32 28, 52 28"
							fill="none"
							stroke={alt}
							strokeOpacity="0.45"
							strokeWidth="9"
						/>
						<path
							d="M12 30 C32 30, 32 17, 52 17"
							fill="none"
							stroke={third}
							strokeOpacity="0.35"
							strokeWidth="4"
						/>
						<rect x="8" y="7" width="4" height="12" fill={bar} />
						<rect x="8" y="21" width="4" height="12" fill={alt} />
						<rect x="52" y="9" width="4" height="12" fill={bar} />
						<rect x="52" y="23" width="4" height="10" fill={alt} />
					</>
				);

			case "histogramChart":
				return (
					<>
						{[6, 14, 24, 30, 22, 13, 7, 3].map((h, i) => (
							<rect
								key={i}
								x={7 + i * 7}
								y={34 - h}
								width="6"
								height={h}
								fill={bar}
							/>
						))}
					</>
				);

			case "boxPlot":
				return (
					<>
						{[
							{ x: 16, min: 5, q1: 12, med: 18, q3: 25, max: 33 },
							{ x: 32, min: 9, q1: 15, med: 20, q3: 27, max: 31 },
							{ x: 48, min: 3, q1: 10, med: 22, q3: 28, max: 36 },
						].map((box) => (
							<g key={box.x}>
								<line
									x1={box.x}
									y1={box.min}
									x2={box.x}
									y2={box.max}
									stroke={muted}
								/>
								<rect
									x={box.x - 5}
									y={box.q1}
									width="10"
									height={box.q3 - box.q1}
									fill={bar}
									fillOpacity="0.4"
									stroke={bar}
								/>
								<line
									x1={box.x - 5}
									y1={box.med}
									x2={box.x + 5}
									y2={box.med}
									stroke={third}
									strokeWidth="1.6"
								/>
							</g>
						))}
					</>
				);

			case "paretoChart":
				return (
					<>
						{[26, 19, 13, 9, 6, 4].map((h, i) => (
							<rect
								key={i}
								x={8 + i * 9}
								y={34 - h}
								width="6"
								height={h}
								fill={bar}
								rx="1"
							/>
						))}
						<polyline
							points="11,24 20,17 29,12 38,9 47,7 56,6"
							fill="none"
							stroke={third}
							strokeWidth="1.6"
						/>
					</>
				);

			case "slopeChart":
				return (
					<>
						{[
							{ then: 30, now: 10, up: true },
							{ then: 20, now: 24, up: false },
							{ then: 12, now: 30, up: false },
						].map((pair) => (
							<g key={pair.then}>
								<line
									x1="14"
									y1={pair.then}
									x2="50"
									y2={pair.now}
									stroke={pair.up ? bar : alt}
									strokeWidth="1.6"
								/>
								<circle
									cx="14"
									cy={pair.then}
									r="2.2"
									fill={pair.up ? bar : alt}
								/>
								<circle
									cx="50"
									cy={pair.now}
									r="2.2"
									fill={pair.up ? bar : alt}
								/>
							</g>
						))}
					</>
				);

			case "bulletChart":
				return (
					<>
						{[
							{ y: 8, actual: 40, target: 32 },
							{ y: 18, actual: 22, target: 34 },
							{ y: 28, actual: 33, target: 26 },
						].map((row) => (
							<g key={row.y}>
								<rect
									x="8"
									y={row.y}
									width="46"
									height="5"
									fill={muted}
									opacity="0.35"
									rx="1"
								/>
								<rect
									x="8"
									y={row.y}
									width={row.actual}
									height="5"
									fill={row.actual >= row.target ? bar : alt}
									rx="1"
								/>
								<rect
									x={8 + row.target}
									y={row.y - 2}
									width="1.5"
									height="9"
									fill={muted}
								/>
							</g>
						))}
					</>
				);

			case "smallMultiples":
				return (
					<>
						{[
							{ x: 5, y: 6, pts: "0,10 5,7 10,8 15,3" },
							{ x: 24, y: 6, pts: "0,4 5,6 10,5 15,9" },
							{ x: 43, y: 6, pts: "0,9 5,6 10,4 15,2" },
							{ x: 5, y: 24, pts: "0,6 5,8 10,5 15,7" },
							{ x: 24, y: 24, pts: "0,3 5,5 10,8 15,10" },
							{ x: 43, y: 24, pts: "0,8 5,5 10,6 15,4" },
						].map((panel) => (
							<g
								key={`${panel.x}-${panel.y}`}
								transform={`translate(${panel.x} ${panel.y})`}
							>
								<rect
									width="16"
									height="11"
									fill={muted}
									opacity="0.15"
									rx="1"
								/>
								<polyline
									points={panel.pts}
									fill="none"
									stroke={bar}
									strokeWidth="1.2"
								/>
							</g>
						))}
					</>
				);

			case "waterfallChart":
				return (
					<>
						<Axes />
						<rect
							x="12"
							y="24"
							width="7"
							height="10"
							fill={alt}
							rx="1"
						/>
						<rect
							x="23"
							y="18"
							width="7"
							height="6"
							fill={alt}
							rx="1"
						/>
						<rect
							x="34"
							y="18"
							width="7"
							height="7"
							fill="var(--danger)"
							rx="1"
						/>
						<rect
							x="45"
							y="25"
							width="7"
							height="9"
							fill={alt}
							rx="1"
						/>
						<line
							x1="19"
							y1="24"
							x2="23"
							y2="24"
							stroke={muted}
							strokeDasharray="2 1"
						/>
						<line
							x1="30"
							y1="18"
							x2="34"
							y2="18"
							stroke={muted}
							strokeDasharray="2 1"
						/>
					</>
				);

			case "pieChart":
				return (
					<>
						<circle cx="32" cy="20" r="14" fill={bar} />
						<path
							d="M32 20 L32 6 A14 14 0 0 1 45 25 Z"
							fill={alt}
						/>
						<path
							d="M32 20 L45 25 A14 14 0 0 1 26 33 Z"
							fill={third}
						/>
					</>
				);

			case "donutChart":
				return (
					<>
						<circle cx="32" cy="20" r="14" fill={bar} />
						<path
							d="M32 20 L32 6 A14 14 0 0 1 45 25 Z"
							fill={alt}
						/>
						<path
							d="M32 20 L45 25 A14 14 0 0 1 26 33 Z"
							fill={third}
						/>
						<circle
							cx="32"
							cy="20"
							r="7"
							fill="var(--surface-raised)"
						/>
					</>
				);

			case "treemapChart":
				return (
					<>
						<rect
							x="6"
							y="6"
							width="30"
							height="18"
							fill={bar}
							rx="1"
						/>
						<rect
							x="38"
							y="6"
							width="20"
							height="18"
							fill={alt}
							rx="1"
						/>
						<rect
							x="6"
							y="26"
							width="18"
							height="10"
							fill={third}
							rx="1"
						/>
						<rect
							x="26"
							y="26"
							width="14"
							height="10"
							fill={bar}
							opacity="0.55"
							rx="1"
						/>
						<rect
							x="42"
							y="26"
							width="16"
							height="10"
							fill={alt}
							opacity="0.55"
							rx="1"
						/>
					</>
				);

			case "funnelChart":
				return (
					<>
						<path d="M8 7 L56 7 L48 15 L16 15 Z" fill={bar} />
						<path d="M17 18 L47 18 L41 26 L23 26 Z" fill={alt} />
						<path d="M24 29 L40 29 L35 36 L29 36 Z" fill={third} />
					</>
				);

			case "stackedBarChart":
				return (
					<>
						<Axes />
						<rect
							x="13"
							y="8"
							width="7"
							height="10"
							fill={third}
							rx="1"
						/>
						<rect x="13" y="18" width="7" height="8" fill={alt} />
						<rect x="13" y="26" width="7" height="8" fill={bar} />
						<rect
							x="26"
							y="8"
							width="7"
							height="6"
							fill={third}
							rx="1"
						/>
						<rect x="26" y="14" width="7" height="12" fill={alt} />
						<rect x="26" y="26" width="7" height="8" fill={bar} />
						<rect
							x="39"
							y="8"
							width="7"
							height="13"
							fill={third}
							rx="1"
						/>
						<rect x="39" y="21" width="7" height="6" fill={alt} />
						<rect x="39" y="27" width="7" height="7" fill={bar} />
					</>
				);

			case "scatterChart":
				return (
					<>
						<Axes />
						<circle cx="16" cy="27" r="2.5" fill={bar} />
						<circle cx="24" cy="20" r="2.5" fill={bar} />
						<circle cx="31" cy="24" r="2.5" fill={bar} />
						<circle cx="38" cy="13" r="2.5" fill={bar} />
						<circle cx="45" cy="17" r="2.5" fill={bar} />
						<circle cx="53" cy="10" r="2.5" fill={bar} />
					</>
				);

			case "heatmapChart":
			case "heatmap":
				return (
					<>
						{[0, 1, 2, 3].map((row) =>
							[0, 1, 2, 3, 4].map((col) => (
								<rect
									key={`${row}-${col}`}
									x={8 + col * 10}
									y={7 + row * 7.5}
									width="9"
									height="6.5"
									rx="1"
									fill={bar}
									opacity={
										0.15 + ((row * 5 + col) % 6) * 0.15
									}
								/>
							)),
						)}
					</>
				);

			case "radarChart":
				return (
					<>
						<polygon
							points="32,7 51,19 44,33 20,33 13,19"
							fill="none"
							stroke={muted}
							strokeWidth="1"
						/>
						<polygon
							points="32,13 44,20 40,29 24,29 20,20"
							fill={bar}
							opacity="0.3"
							stroke={bar}
							strokeWidth="1.5"
						/>
					</>
				);

			case "table":
				return (
					<>
						<rect
							x="6"
							y="7"
							width="52"
							height="7"
							fill={muted}
							opacity="0.4"
							rx="1"
						/>
						{[0, 1, 2].map((i) => (
							<g key={i}>
								<rect
									x="6"
									y={17 + i * 7}
									width="20"
									height="4"
									fill={muted}
									opacity="0.5"
									rx="1"
								/>
								<rect
									x="30"
									y={17 + i * 7}
									width="12"
									height="4"
									fill={bar}
									opacity="0.6"
									rx="1"
								/>
								<rect
									x="46"
									y={17 + i * 7}
									width="12"
									height="4"
									fill={bar}
									opacity="0.6"
									rx="1"
								/>
							</g>
						))}
					</>
				);

			case "matrixTable":
				return (
					<>
						<rect
							x="4"
							y="6"
							width="56"
							height="6"
							fill={muted}
							opacity="0.4"
							rx="1"
						/>
						{/* Indentation is the point of a matrix, so the preview
						    shows the hierarchy rather than a flat grid. */}
						<rect
							x="5"
							y="15"
							width="18"
							height="4"
							fill={muted}
							opacity="0.6"
							rx="1"
						/>
						<rect
							x="9"
							y="21"
							width="16"
							height="4"
							fill={muted}
							opacity="0.45"
							rx="1"
						/>
						<rect
							x="13"
							y="27"
							width="14"
							height="4"
							fill={muted}
							opacity="0.35"
							rx="1"
						/>
						<line
							x1="31"
							y1="13"
							x2="31"
							y2="34"
							stroke={muted}
							strokeWidth="1"
						/>
						<rect
							x="34"
							y="15"
							width="10"
							height="4"
							fill={bar}
							opacity="0.7"
							rx="1"
						/>
						<rect
							x="34"
							y="21"
							width="10"
							height="4"
							fill={bar}
							opacity="0.5"
							rx="1"
						/>
						<rect
							x="34"
							y="27"
							width="10"
							height="4"
							fill={bar}
							opacity="0.35"
							rx="1"
						/>
						<line
							x1="47"
							y1="13"
							x2="47"
							y2="34"
							stroke={muted}
							strokeWidth="1"
						/>
						<rect
							x="49"
							y="15"
							width="10"
							height="4"
							fill={alt}
							opacity="0.7"
							rx="1"
						/>
						<rect
							x="49"
							y="21"
							width="10"
							height="4"
							fill={alt}
							opacity="0.5"
							rx="1"
						/>
						<rect
							x="49"
							y="27"
							width="10"
							height="4"
							fill={alt}
							opacity="0.35"
							rx="1"
						/>
					</>
				);

			case "definitionList":
				return (
					<>
						{[0, 1, 2, 3].map((i) => (
							<g key={i}>
								<rect
									x="8"
									y={9 + i * 7}
									width="18"
									height="4"
									fill={muted}
									opacity="0.45"
									rx="1"
								/>
								<rect
									x="30"
									y={9 + i * 7}
									width="26"
									height="4"
									fill={bar}
									opacity="0.5"
									rx="1"
								/>
							</g>
						))}
					</>
				);

			case "dropdownFilter":
				return (
					<>
						<rect
							x="8"
							y="13"
							width="48"
							height="13"
							rx="3"
							fill="none"
							stroke={muted}
							strokeWidth="1.5"
						/>
						<rect
							x="12"
							y="18"
							width="22"
							height="3"
							rx="1"
							fill={muted}
							opacity="0.7"
						/>
						<path
							d="M46 18 L49 21 L52 18"
							fill="none"
							stroke={bar}
							strokeWidth="1.8"
							strokeLinecap="round"
						/>
					</>
				);

			case "searchFilter":
				return (
					<>
						<rect
							x="8"
							y="13"
							width="48"
							height="13"
							rx="6.5"
							fill="none"
							stroke={muted}
							strokeWidth="1.5"
						/>
						<circle
							cx="17"
							cy="19.5"
							r="3.2"
							fill="none"
							stroke={bar}
							strokeWidth="1.6"
						/>
						<line
							x1="19.5"
							y1="22"
							x2="22"
							y2="24.5"
							stroke={bar}
							strokeWidth="1.6"
							strokeLinecap="round"
						/>
						<rect
							x="27"
							y="18"
							width="20"
							height="3"
							rx="1"
							fill={muted}
							opacity="0.55"
						/>
					</>
				);

			case "bulkFilter":
				return (
					<>
						<rect
							x="8"
							y="7"
							width="48"
							height="26"
							rx="3"
							fill="none"
							stroke={muted}
							strokeWidth="1.5"
						/>
						{[0, 1, 2, 3].map((i) => (
							<rect
								key={i}
								x="12"
								y={12 + i * 5}
								width={i % 2 === 0 ? 30 : 22}
								height="3"
								rx="1"
								fill={bar}
								opacity="0.5"
							/>
						))}
					</>
				);

			case "dateRangeFilter":
				return (
					<>
						<rect
							x="8"
							y="9"
							width="20"
							height="22"
							rx="3"
							fill="none"
							stroke={muted}
							strokeWidth="1.5"
						/>
						<line
							x1="8"
							y1="15"
							x2="28"
							y2="15"
							stroke={muted}
							strokeWidth="1.5"
						/>
						<rect
							x="36"
							y="9"
							width="20"
							height="22"
							rx="3"
							fill="none"
							stroke={muted}
							strokeWidth="1.5"
						/>
						<line
							x1="36"
							y1="15"
							x2="56"
							y2="15"
							stroke={muted}
							strokeWidth="1.5"
						/>
						<line
							x1="29"
							y1="20"
							x2="35"
							y2="20"
							stroke={bar}
							strokeWidth="1.8"
						/>
					</>
				);

			case "numericRangeFilter":
				return (
					<>
						<line
							x1="8"
							y1="20"
							x2="56"
							y2="20"
							stroke={muted}
							strokeWidth="2"
							strokeLinecap="round"
						/>
						<line
							x1="22"
							y1="20"
							x2="44"
							y2="20"
							stroke={bar}
							strokeWidth="2"
							strokeLinecap="round"
						/>
						<circle
							cx="22"
							cy="20"
							r="4"
							fill="var(--surface-raised)"
							stroke={bar}
							strokeWidth="2"
						/>
						<circle
							cx="44"
							cy="20"
							r="4"
							fill="var(--surface-raised)"
							stroke={bar}
							strokeWidth="2"
						/>
					</>
				);

			// A container: the box, and the things it holds drawn inside it.
			case "group":
				return (
					<>
						<rect
							x="6"
							y="6"
							width="52"
							height="28"
							rx="3"
							fill="none"
							stroke={bar}
							strokeWidth="1.5"
						/>
						<rect
							x="10"
							y="12"
							width="20"
							height="18"
							rx="2"
							fill={bar}
							opacity="0.45"
						/>
						<rect
							x="34"
							y="12"
							width="20"
							height="8"
							rx="2"
							fill={alt}
							opacity="0.5"
						/>
						<rect
							x="34"
							y="23"
							width="20"
							height="7"
							rx="2"
							fill={third}
							opacity="0.5"
						/>
					</>
				);

			// Filters and text blocks fell through to the dashed placeholder
			// below, which is what the picker showed for nine of its
			// thirty-four types: a card with a name, a line of encoding and an
			// empty box where every other card had a drawing.

			case "toggleFilter":
				return (
					<>
						<rect
							x="14"
							y="14"
							width="36"
							height="14"
							rx="7"
							fill={bar}
							opacity="0.25"
							stroke={bar}
							strokeWidth="1.5"
						/>
						<circle cx="43" cy="21" r="5" fill={bar} />
					</>
				);

			case "presenceFilter":
				return (
					<>
						<rect
							x="8"
							y="10"
							width="22"
							height="20"
							rx="3"
							fill="none"
							stroke={muted}
							strokeWidth="1.5"
						/>
						<line
							x1="12"
							y1="17"
							x2="26"
							y2="17"
							stroke={muted}
							strokeWidth="2"
							strokeLinecap="round"
						/>
						<line
							x1="12"
							y1="23"
							x2="21"
							y2="23"
							stroke={muted}
							strokeWidth="2"
							strokeLinecap="round"
						/>
						<rect
							x="34"
							y="10"
							width="22"
							height="20"
							rx="3"
							fill="none"
							stroke={bar}
							strokeWidth="1.5"
							strokeDasharray="3 2"
						/>
						<line
							x1="40"
							y1="26"
							x2="50"
							y2="14"
							stroke={bar}
							strokeWidth="1.8"
							strokeLinecap="round"
						/>
					</>
				);

			case "thresholdControl":
				return (
					<>
						<line
							x1="8"
							y1="26"
							x2="56"
							y2="26"
							stroke={muted}
							strokeWidth="2"
							strokeLinecap="round"
						/>
						<line
							x1="8"
							y1="26"
							x2="38"
							y2="26"
							stroke={bar}
							strokeWidth="2"
							strokeLinecap="round"
						/>
						<circle
							cx="38"
							cy="26"
							r="4.5"
							fill="var(--surface-raised)"
							stroke={bar}
							strokeWidth="2"
						/>
						<line
							x1="38"
							y1="9"
							x2="38"
							y2="19"
							stroke={bar}
							strokeWidth="1.5"
							strokeDasharray="2 2"
						/>
						<rect
							x="30"
							y="6"
							width="16"
							height="6"
							rx="2"
							fill={bar}
							opacity="0.5"
						/>
					</>
				);

			// A group of dropdowns kept together, so it is drawn as several of
			// the one the plain dropdown filter draws.
			case "filterBar":
				return (
					<>
						{[0, 1, 2].map((i) => (
							<g key={i}>
								<rect
									x="8"
									y={7 + i * 10}
									width="48"
									height="8"
									rx="2"
									fill="none"
									stroke={muted}
									strokeWidth="1.3"
								/>
								<path
									d={`M46 ${10 + i * 10} L48.5 ${12.5 + i * 10} L51 ${10 + i * 10}`}
									fill="none"
									stroke={bar}
									strokeWidth="1.5"
									strokeLinecap="round"
								/>
							</g>
						))}
					</>
				);

			// A segmented choice: the same shape for both switchers, since to
			// a reader they are the same control pointed at different things.
			case "dimensionSwitch":
			case "periodSwitch":
				return (
					<>
						<rect
							x="8"
							y="13"
							width="48"
							height="14"
							rx="3"
							fill="none"
							stroke={muted}
							strokeWidth="1.5"
						/>
						<rect
							x="9.5"
							y="14.5"
							width="15"
							height="11"
							rx="2"
							fill={bar}
							opacity="0.75"
						/>
						<line
							x1="24.5"
							y1="14.5"
							x2="24.5"
							y2="25.5"
							stroke={muted}
							strokeWidth="1"
						/>
						<line
							x1="40"
							y1="14.5"
							x2="40"
							y2="25.5"
							stroke={muted}
							strokeWidth="1"
						/>
						<rect
							x="28"
							y="19"
							width="9"
							height="3"
							rx="1"
							fill={muted}
							opacity="0.6"
						/>
						<rect
							x="44"
							y="19"
							width="9"
							height="3"
							rx="1"
							fill={muted}
							opacity="0.6"
						/>
					</>
				);

			case "sectionHeader":
				return (
					<>
						<rect
							x="8"
							y="14"
							width="24"
							height="5"
							rx="1"
							fill={muted}
							opacity="0.85"
						/>
						<line
							x1="8"
							y1="25"
							x2="56"
							y2="25"
							stroke={bar}
							strokeWidth="1.5"
							strokeLinecap="round"
						/>
					</>
				);

			case "blockedNotice":
				return (
					<>
						<rect
							x="8"
							y="10"
							width="48"
							height="20"
							rx="3"
							fill={bar}
							opacity="0.12"
							stroke={bar}
							strokeWidth="1.5"
							strokeDasharray="3 2"
						/>
						<line
							x1="32"
							y1="15"
							x2="32"
							y2="22"
							stroke={bar}
							strokeWidth="2"
							strokeLinecap="round"
						/>
						<circle cx="32" cy="26" r="1.4" fill={bar} />
					</>
				);

			// The attributes of one thing, laid out as a header: a name across
			// the top with the fields under it in a row.
			case "entityHeader":
				return (
					<>
						<rect
							x="8"
							y="8"
							width="30"
							height="6"
							rx="1.5"
							fill={muted}
							opacity="0.85"
						/>
						{[0, 1, 2].map((i) => (
							<g key={i}>
								<rect
									x={8 + i * 17}
									y="21"
									width="12"
									height="3"
									rx="1"
									fill={muted}
									opacity="0.45"
								/>
								<rect
									x={8 + i * 17}
									y="27"
									width="9"
									height="4"
									rx="1"
									fill={bar}
									opacity="0.7"
								/>
							</g>
						))}
					</>
				);

			case "textPanel":
				return (
					<>
						<rect
							x="8"
							y="8"
							width="26"
							height="5"
							rx="1"
							fill={muted}
							opacity="0.75"
						/>
						{[0, 1, 2].map((i) => (
							<rect
								key={i}
								x="8"
								y={18 + i * 6}
								width={i === 2 ? 32 : 48}
								height="3"
								rx="1"
								fill={muted}
								opacity="0.4"
							/>
						))}
					</>
				);

			default:
				return (
					<>
						<rect
							x="8"
							y="8"
							width="48"
							height="24"
							rx="3"
							fill="none"
							stroke={muted}
							strokeWidth="1.5"
							strokeDasharray="3 2"
						/>
					</>
				);
		}
	})();

	return (
		<span className={styles.thumb} style={{ height: size }}>
			<Frame>{content}</Frame>
		</span>
	);
}
