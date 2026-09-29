"use client";

import type { ReactNode } from "react";
import styles from "./Editor.module.css";

// The column of buttons beside the canvas while a report is being edited.
//
// Each button opens one panel over the edge of the canvas, and pressing it
// again closes it. The canvas never changes width, so opening a panel does not move
// anything the author is arranging. The selected visual's panel
// opens by itself when a visual is selected, since that is almost always why
// it was. The assistant has a button of its own, so asking for a change is next
// to making it by hand.

export type EditorPanel = "visual" | "page" | "report" | "history";

function Icon({ children }: { children: ReactNode }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

function RailButton({
	label,
	active,
	disabled,
	title,
	onClick,
	children,
}: {
	label: string;
	active: boolean;
	disabled?: boolean;
	title?: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className={`${styles.railButton} ${active ? styles.railButtonOn : ""}`}
			onClick={onClick}
			disabled={disabled}
			aria-pressed={active}
			title={title ?? label}
		>
			{children}
			<span className={styles.railLabel}>{label}</span>
		</button>
	);
}

export function EditorRail({
	panel,
	onPanel,
	hasSelection,
	assistant,
}: {
	panel: EditorPanel | null;
	onPanel: (panel: EditorPanel | null) => void;
	hasSelection: boolean;
	// Absent where no assistant is configured.
	assistant?: { open: boolean; onToggle: () => void };
}) {
	const toggle = (next: EditorPanel) => onPanel(panel === next ? null : next);

	return (
		<nav className={styles.rail} aria-label="Editor panels">
			<RailButton
				label="Visual"
				active={panel === "visual"}
				disabled={!hasSelection}
				title={
					hasSelection
						? "The selected visual's data and format"
						: "Select a visual on the canvas to set it up"
				}
				onClick={() => toggle("visual")}
			>
				<Icon>
					<path d="M3 3v18h18" />
					<path d="M7 15l4-4 3 3 5-6" />
				</Icon>
			</RailButton>
			<RailButton
				label="Page"
				active={panel === "page"}
				title="This page's name, filters and settings"
				onClick={() => toggle("page")}
			>
				<Icon>
					<rect x="4" y="3" width="16" height="18" rx="2" />
					<path d="M8 8h8M8 12h8M8 16h5" />
				</Icon>
			</RailButton>
			<RailButton
				label="Report"
				active={panel === "report"}
				title="The report's subtitle, placement and protection"
				onClick={() => toggle("report")}
			>
				<Icon>
					<path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
					<path d="M14 3v5h5" />
				</Icon>
			</RailButton>
			<RailButton
				label="History"
				active={panel === "history"}
				title="Every published version, and putting one back"
				onClick={() => toggle("history")}
			>
				<Icon>
					<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
					<path d="M3 3v5h5" />
					<path d="M12 7v5l3 2" />
				</Icon>
			</RailButton>

			{assistant && (
				<>
					<span className={styles.railDivider} aria-hidden="true" />
					<RailButton
						label="Assistant"
						active={assistant.open}
						title="Describe a change and have it made on the page"
						onClick={assistant.onToggle}
					>
						<Icon>
							<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
							<path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />
						</Icon>
					</RailButton>
				</>
			)}
		</nav>
	);
}
