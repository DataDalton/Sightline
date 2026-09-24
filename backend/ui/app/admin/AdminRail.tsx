"use client";

import { adminNav, type PaneId } from "./nav";
import styles from "./Admin.module.css";

// The one navigation control in administration.
//
// Every destination is on screen at once under its group heading, so choosing
// one is reading rather than recalling which tab it was filed behind. The
// active item is the only thing in the rail carrying a background, which is
// what makes the current position readable at a glance rather than from a two
// pixel border.
//
// The rail keeps the page background rather than taking a surface of its own.
// The application sidebar is already a filled panel immediately to its left,
// and a second one beside it reads as two chrome columns competing to be the
// navigation. A rule down the right edge marks the column instead.
export function AdminRail({
	active,
	onSelect,
}: {
	active: PaneId;
	onSelect: (id: PaneId) => void;
}) {
	return (
		// The column is the grid cell and stretches to the full height of the
		// pane beside it; the rail inside it is what sticks. Sticky on the cell
		// itself has no room to travel, because the cell is exactly as tall as
		// the rail, so it never moved on a pane long enough to scroll.
		<div className={styles.railColumn}>
			<nav className={styles.rail} aria-label="Administration">
				{adminNav.map((group) => (
					<div key={group.label} className={styles.railGroup}>
						<h2 className={styles.railGroupLabel}>{group.label}</h2>
						{group.panes.map((pane) => (
							<button
								key={pane.id}
								type="button"
								className={`${styles.railItem} ${
									active === pane.id
										? styles.railItemActive
										: ""
								}`}
								// Marks the destination rather than the control, so
								// a screen reader announces this as where the reader
								// is and not merely as a pressed button.
								aria-current={
									active === pane.id ? "page" : undefined
								}
								onClick={() => onSelect(pane.id)}
							>
								{pane.label}
							</button>
						))}
					</div>
				))}
			</nav>
		</div>
	);
}
