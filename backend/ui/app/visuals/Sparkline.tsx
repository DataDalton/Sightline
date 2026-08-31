"use client";

// The shape of a figure, drawn small enough to sit inside a tile.
//
// Hand-drawn SVG rather than a chart. ECharts is the largest asset the client
// downloads and it is loaded only when a real chart is on the page, so pulling
// it in to draw twelve points inside a scorecard would make a page of tiles pay
// for a renderer it otherwise never needs. A polyline is a polyline.
//
// No axes, no labels, no grid. A sparkline answers "which way and how steadily"
// and nothing else; anything that invites a value to be read off it is
// promising a precision it does not have, which is what the figure above it is
// for.

interface SparklineProps {
	values: (number | null)[];
	width?: number;
	height?: number;
	// Drawn in this colour, falling back to the tile's own text colour so it
	// reads as part of the figure rather than as decoration beside it.
	color?: string;
	label?: string;
	// The range to draw against, when several sparklines have to be
	// comparable. Without it each one fills its own box, which is right for a
	// single tile and wrong for a grid of them: twelve series each scaled to
	// themselves all look the same shape.
	domain?: { min: number; max: number };
	// Fills the area under the line. Reads better at the small sizes a grid of
	// these uses, where a hairline alone is easy to lose.
	fill?: boolean;
	// Scales to the width of whatever it is in, keeping width and height as the
	// shape rather than as a size. A fixed width wider than its column is what
	// put a horizontal scrollbar under a grid of these.
	stretch?: boolean;
}

export function Sparkline({
	values,
	width = 72,
	height = 20,
	color,
	label,
	domain,
	fill = false,
	stretch = false,
}: SparklineProps) {
	const points = values.filter((v): v is number => v !== null);
	// One point is a dot, not a trend. Two is the fewest that has a direction.
	if (points.length < 2) return null;

	const min = domain ? domain.min : Math.min(...points);
	const max = domain ? domain.max : Math.max(...points);
	const span = max - min;

	// Inset by the stroke so the extremes are not clipped by the viewbox.
	const pad = 1.5;
	const usableW = width - pad * 2;
	const usableH = height - pad * 2;

	// A flat series has no range to scale against. Drawn down the middle
	// rather than at the top or the bottom, either of which would read as an
	// extreme when the truth is that nothing moved.
	const y = (value: number) =>
		span === 0
			? pad + usableH / 2
			: pad + usableH - ((value - min) / span) * usableH;

	const step = points.length > 1 ? usableW / (points.length - 1) : 0;
	const coords = points.map(
		(value, index) => [pad + step * index, y(value)] as const,
	);
	const path = coords.map(([x, cy]) => `${x},${cy}`).join(" ");
	const [lastX, lastY] = coords[coords.length - 1];

	const stroke = color ?? "currentColor";

	return (
		<svg
			width={stretch ? undefined : width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio={stretch ? "none" : undefined}
			role={label ? "img" : "presentation"}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			style={{
				display: "block",
				overflow: "visible",
				...(stretch ? { width: "100%" } : {}),
			}}
		>
			{fill && (
				<polygon
					points={`${pad},${height - pad} ${path} ${pad + usableW},${height - pad}`}
					fill={stroke}
					opacity="0.14"
				/>
			)}
			<polyline
				points={path}
				fill="none"
				stroke={stroke}
				strokeWidth="1.5"
				strokeLinejoin="round"
				strokeLinecap="round"
				opacity="0.75"
			/>
			{/* The latest point, marked. Where a series has got to is the part
			    of it a reader is actually looking for. */}
			<circle cx={lastX} cy={lastY} r="2" fill={stroke} />
		</svg>
	);
}
