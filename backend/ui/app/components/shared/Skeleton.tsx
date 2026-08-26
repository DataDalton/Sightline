import type { CSSProperties } from "react";
import styles from "./Skeleton.module.css";

// Placeholders for content that has not arrived.
//
// One set of these rather than a definition per surface, so two things loading
// beside each other pulse together instead of at their own speeds. A skeleton
// shaped like what replaces it is also what stops the page jumping when the
// data lands.
//
// Everything here is decorative and hidden from assistive technology: the
// content that replaces it is what should be announced, and a screen reader
// reading out a dozen empty boxes is worse than silence.

interface BlockProps {
	width?: number | string;
	height?: number | string;
	radius?: "sm" | "lg" | "circle";
	// Set on the sidebar and header, where the surface tokens do not read.
	onChrome?: boolean;
	className?: string;
	style?: CSSProperties;
}

export function Skeleton({
	width,
	height = 12,
	radius = "sm",
	onChrome,
	className,
	style,
}: BlockProps) {
	return (
		<div
			aria-hidden="true"
			className={[
				styles.block,
				onChrome ? styles.onChrome : "",
				radius === "lg" ? styles.rounded : "",
				radius === "circle" ? styles.circle : "",
				className ?? "",
			]
				.filter(Boolean)
				.join(" ")}
			style={{ width, height, ...style }}
		/>
	);
}

// A paragraph. The last line is short, because a stack of equal bars reads as a
// chart rather than as text.
export function SkeletonText({
	lines = 3,
	onChrome,
}: {
	lines?: number;
	onChrome?: boolean;
}) {
	return (
		<div className={styles.stack} aria-hidden="true">
			{Array.from({ length: lines }, (_, i) => (
				<Skeleton
					key={i}
					className={styles.line}
					onChrome={onChrome}
					height={12}
				/>
			))}
		</div>
	);
}

// A grid of cards.
//
// The card itself is real: its border, padding and radius are the ones the
// content lands in, and only the icon and the two lines of text stand in. A
// solid rectangle the size of a card says something is coming without saying
// what, and a page of them pulsing together reads as an error state.
export function SkeletonCards({ count = 6 }: { count?: number }) {
	return (
		<div className={styles.cards} aria-hidden="true">
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className={styles.card}>
					<Skeleton width={22} height={22} radius="circle" />
					<div className={styles.cardBody}>
						<Skeleton height={13} width="70%" />
						<Skeleton height={10} width="40%" />
					</div>
				</div>
			))}
		</div>
	);
}

// A table, including its header row, so the border and background are already
// on screen and only the text changes when the data lands.
export function SkeletonTable({
	rows = 5,
	columns = 4,
}: {
	rows?: number;
	columns?: number;
}) {
	// The first column carries the label and is normally the widest, so it gets
	// the room rather than every column sharing equally.
	const template = `2fr ${Array.from({ length: Math.max(0, columns - 1) })
		.map(() => "1fr")
		.join(" ")}`;

	return (
		<div className={styles.tableShell} aria-hidden="true">
			<div
				className={`${styles.tableRow} ${styles.tableHead}`}
				style={{ gridTemplateColumns: template }}
			>
				{Array.from({ length: columns }, (_, i) => (
					<Skeleton key={i} height={10} />
				))}
			</div>
			{Array.from({ length: rows }, (_, row) => (
				<div
					key={row}
					className={styles.tableRow}
					style={{ gridTemplateColumns: template }}
				>
					{Array.from({ length: columns }, (_, col) => (
						<Skeleton key={col} height={12} />
					))}
				</div>
			))}
		</div>
	);
}

// A report page: a heading, a row of figures, and a chart card below them.
//
// Shaped like what arrives rather than as two grey slabs, so the eye can tell
// a report is coming and roughly what is in it. The cards draw their real
// chrome and hold still.
export function SkeletonReport() {
	return (
		<div className={styles.report} aria-hidden="true">
			<div className={styles.reportHeader}>
				<Skeleton height={20} width="34%" />
				<Skeleton height={11} width="52%" />
			</div>

			<div className={styles.kpis}>
				{Array.from({ length: 4 }, (_, i) => (
					<div key={i} className={styles.card}>
						<Skeleton height={10} width="55%" />
						<Skeleton height={20} width="40%" />
					</div>
				))}
			</div>

			<div className={styles.card}>
				<Skeleton height={12} width="26%" />
				<div className={styles.chart}>
					{/* Uneven, so it reads as a chart rather than as a table. */}
					{[62, 88, 47, 74, 95, 55, 81, 38, 69, 90].map((h, i) => (
						<Skeleton
							key={i}
							height={`${h}%`}
							style={{ flex: 1, alignSelf: "flex-end" }}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
