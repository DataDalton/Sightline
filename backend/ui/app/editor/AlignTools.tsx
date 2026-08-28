"use client";

import type { AlignMode } from "../../lib/visuals/layout";
import styles from "./Editor.module.css";

// Lining a selection up, and spreading it out.
//
// Only on the toolbar while more than one visual is selected, because every
// action here is about the relationship between two rectangles and none of them
// means anything applied to one. Hidden rather than disabled: a row of six
// permanently greyed controls is six controls an author learns to ignore.
//
// Distributing needs a middle to move, so it appears a member later than the
// rest rather than being offered and then doing nothing.

interface AlignToolsProps {
	count: number;
	onAlign: (mode: AlignMode) => void;
	onDistribute: (axis: "x" | "y") => void;
	disabled?: boolean;
}

// Each icon draws what the action does to two rectangles, rather than an
// abstraction of it, so the row reads without a tooltip once it has been used
// once.
const strokes = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.6,
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
};

function Icon({ children }: { children: React.ReactNode }) {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 20 20"
			aria-hidden="true"
			{...strokes}
		>
			{children}
		</svg>
	);
}

export function AlignTools({
	count,
	onAlign,
	onDistribute,
	disabled = false,
}: AlignToolsProps) {
	if (count < 2) return null;

	const tool = (
		label: string,
		onClick: () => void,
		icon: React.ReactNode,
	) => (
		<button
			type="button"
			className={styles.iconTool}
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
		>
			<Icon>{icon}</Icon>
		</button>
	);

	return (
		<>
			<span className={styles.divider} aria-hidden="true" />

			{tool(
				"Align left edges",
				() => onAlign("left"),
				<>
					<path d="M3 2v16" />
					<rect x="6" y="4" width="11" height="4" rx="1" />
					<rect x="6" y="12" width="7" height="4" rx="1" />
				</>,
			)}
			{tool(
				"Align right edges",
				() => onAlign("right"),
				<>
					<path d="M17 2v16" />
					<rect x="3" y="4" width="11" height="4" rx="1" />
					<rect x="7" y="12" width="7" height="4" rx="1" />
				</>,
			)}
			{tool(
				"Align top edges",
				() => onAlign("top"),
				<>
					<path d="M2 3h16" />
					<rect x="4" y="6" width="4" height="11" rx="1" />
					<rect x="12" y="6" width="4" height="7" rx="1" />
				</>,
			)}
			{tool(
				"Match widths",
				() => onAlign("matchWidth"),
				<>
					<rect x="3" y="4" width="14" height="4" rx="1" />
					<rect x="3" y="12" width="14" height="4" rx="1" />
					<path d="M3 10h14" strokeDasharray="2 2" />
				</>,
			)}
			{tool(
				"Match heights",
				() => onAlign("matchHeight"),
				<>
					<rect x="4" y="3" width="4" height="14" rx="1" />
					<rect x="12" y="3" width="4" height="14" rx="1" />
					<path d="M10 3v14" strokeDasharray="2 2" />
				</>,
			)}

			{count >= 3 && (
				<>
					{tool(
						"Space evenly across",
						() => onDistribute("x"),
						<>
							<rect x="2" y="6" width="3" height="8" rx="1" />
							<rect x="8.5" y="6" width="3" height="8" rx="1" />
							<rect x="15" y="6" width="3" height="8" rx="1" />
						</>,
					)}
					{tool(
						"Space evenly down",
						() => onDistribute("y"),
						<>
							<rect x="6" y="2" width="8" height="3" rx="1" />
							<rect x="6" y="8.5" width="8" height="3" rx="1" />
							<rect x="6" y="15" width="8" height="3" rx="1" />
						</>,
					)}
				</>
			)}
		</>
	);
}
