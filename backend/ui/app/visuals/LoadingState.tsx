"use client";

import styles from "./Loading.module.css";

// Loading states for visuals.
//
// The variant is a per-visual style option because the right placeholder
// depends on what is coming: a chart-shaped skeleton reads as "a chart is
// loading" and holds the layout, while a spinner suits a tile too small for
// anything else. Holding the layout matters most, since a placeholder that is
// the wrong size makes the page jump when data lands.
//
// Every variant respects prefers-reduced-motion by falling back to a static
// shape rather than disappearing, so the reader still sees that something is
// pending.

export type LoadingVariant = "skeleton" | "bars" | "spinner" | "pulse" | "none";

interface LoadingStateProps {
	variant?: LoadingVariant;
	label?: string;
	height?: number | string;
	// Rows for the skeleton variant, so a table placeholder is table-shaped.
	rows?: number;
}

export function VisualLoadingState({
	variant = "skeleton",
	label,
	height,
	rows = 5,
}: LoadingStateProps) {
	if (variant === "none") return null;

	const style = height ? { height } : undefined;

	if (variant === "spinner") {
		return (
			<div className={styles.wrap} style={style} role="status" aria-busy="true">
				<span className={styles.spinner} aria-hidden="true" />
				{label && <span className={styles.label}>{label}</span>}
			</div>
		);
	}

	if (variant === "pulse") {
		return (
			<div className={styles.wrap} style={style} role="status" aria-busy="true">
				<span className={styles.pulse} aria-hidden="true" />
				<span className="sr-only">{label ?? "Loading"}</span>
			</div>
		);
	}

	if (variant === "bars") {
		return (
			<div className={styles.wrap} style={style} role="status" aria-busy="true">
				<div className={styles.bars} aria-hidden="true">
					{Array.from({ length: 5 }, (_, i) => (
						<span
							key={i}
							className={styles.barCol}
							style={{ height: `${45 + ((i * 37) % 55)}%` }}
						/>
					))}
				</div>
				{label && <span className={styles.label}>{label}</span>}
			</div>
		);
	}

	return (
		<div className={styles.skeleton} style={style} role="status" aria-busy="true">
			{Array.from({ length: rows }, (_, i) => (
				<span
					key={i}
					className={styles.bar}
					// Varied widths so the placeholder reads as content rather
					// than as a progress bar.
					style={{ width: `${100 - ((i * 13) % 45)}%` }}
					aria-hidden="true"
				/>
			))}
			<span className="sr-only">{label ?? "Loading"}</span>
		</div>
	);
}

// Shown over content that is already on screen while it refreshes, so the
// reader keeps their place instead of watching the page empty and refill.
export function RefreshOverlay({ label }: { label?: string }) {
	return (
		<div className={styles.overlay} role="status" aria-busy="true">
			<span className={styles.spinner} aria-hidden="true" />
			<span className="sr-only">{label ?? "Refreshing"}</span>
		</div>
	);
}
