"use client";

import {
	colorNames,
	type BoardLink,
	type ColorName,
} from "../../lib/boards/definition";
import { arrowPath, type Guide, type Rect } from "../../lib/boards/geometry";
import { dashOf, strokeOf } from "./palette";
import styles from "./Boards.module.css";

// The arrows between items, and the alignment guides shown while an item
// moves. Drawn under the items in board coordinates.
//
// Each arrow colour has its own arrowhead, since a marker cannot take the
// colour of the line that uses it in every browser. The selected arrow is
// drawn in the selection colour with its own head.

function markerId(color: ColorName | "selected"): string {
	return `board-head-${color}`;
}

function Heads() {
	const all: (ColorName | "selected")[] = [...colorNames, "selected"];
	return (
		<defs>
			{all.map((color) => (
				<marker
					key={color}
					id={markerId(color)}
					viewBox="0 0 10 10"
					refX="8.5"
					refY="5"
					markerWidth="5"
					markerHeight="5"
					markerUnits="strokeWidth"
					orient="auto-start-reverse"
				>
					<path
						d="M0,0 L10,5 L0,10 z"
						style={{
							fill:
								color === "selected"
									? "var(--brand-strong)"
									: strokeOf(
											color === "none"
												? "default"
												: color,
										),
						}}
					/>
				</marker>
			))}
		</defs>
	);
}

export function ArrowLayer({
	links,
	rectOf,
	selectedId,
	guides,
	onSelect,
	onOpen,
}: {
	links: BoardLink[];
	rectOf: (id: string) => Rect | null;
	selectedId: string | null;
	guides: Guide[];
	onSelect: (id: string) => void;
	onOpen: (id: string) => void;
}) {
	return (
		<svg
			className={styles.links}
			aria-hidden={links.length ? undefined : true}
		>
			<Heads />
			{links.map((link) => {
				const a = rectOf(link.from);
				const b = rectOf(link.to);
				if (!a || !b) return null;
				const path = arrowPath(a, b, link.route ?? "straight");
				const on = selectedId === link.id;
				const width = link.width ?? 2;
				const color = link.color ?? "default";
				const head = `url(#${markerId(on ? "selected" : color)})`;
				const ends = link.ends ?? "end";
				// A flowing arrow needs dashes to move, so a solid one flows as
				// dashed. One dash and its gap is how far the pattern travels
				// before it repeats.
				const line =
					link.flow && (link.line ?? "solid") === "solid"
						? "dashed"
						: link.line;
				const cycle = line === "dotted" ? width * 2 : width * 5;
				return (
					<g key={link.id}>
						<path
							d={path.d}
							className={styles.linkHit}
							style={{ strokeWidth: Math.max(14, width + 10) }}
							onPointerDown={(e) => {
								e.stopPropagation();
								onSelect(link.id);
							}}
							onDoubleClick={(e) => {
								e.stopPropagation();
								onOpen(link.id);
							}}
						/>
						<path
							d={path.d}
							className={`${styles.link} ${link.flow ? styles.linkFlow : ""}`}
							style={
								{
									stroke: on
										? "var(--brand-strong)"
										: strokeOf(color),
									strokeWidth: on ? width + 0.5 : width,
									strokeDasharray: dashOf(line, width),
									strokeLinecap:
										line === "dotted" ? "round" : "butt",
									"--flow-cycle": `${cycle}px`,
									// The same speed along the line whatever its
									// width, rather than one cycle per beat.
									animationDuration: `${cycle / 24}s`,
								} as React.CSSProperties
							}
							markerEnd={ends === "none" ? undefined : head}
							markerStart={ends === "both" ? head : undefined}
						/>
						{link.label && (
							<text
								x={path.mid.x}
								y={path.mid.y}
								className={styles.linkLabel}
								textAnchor="middle"
								dominantBaseline="central"
							>
								{link.label}
							</text>
						)}
					</g>
				);
			})}
			{guides.map((guide, i) =>
				guide.axis === "x" ? (
					<line
						key={i}
						className={styles.guide}
						x1={guide.at}
						x2={guide.at}
						y1={guide.from - 16}
						y2={guide.to + 16}
					/>
				) : (
					<line
						key={i}
						className={styles.guide}
						y1={guide.at}
						y2={guide.at}
						x1={guide.from - 16}
						x2={guide.to + 16}
					/>
				),
			)}
		</svg>
	);
}
