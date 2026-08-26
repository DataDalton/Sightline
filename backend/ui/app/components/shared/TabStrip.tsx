"use client";

import styles from "./TabStrip.module.css";

// Views of one thing, inside a pane.
//
// For a pane holding several related lists that would otherwise be stacked and
// scrolled past. Distinct from the tabs at the top of a page: those move
// between subjects, this moves between views of the subject already chosen.

export interface Tab<T extends string> {
	id: T;
	label: string;
	// Shown as a pill beside the label. Left out where the number is not
	// something anybody decides on.
	count?: number;
}

export function TabStrip<T extends string>({
	tabs,
	value,
	onChange,
	label,
}: {
	tabs: readonly Tab<T>[];
	value: T;
	onChange: (id: T) => void;
	label: string;
}) {
	return (
		<div className={styles.strip} role="tablist" aria-label={label}>
			{tabs.map((tab) => {
				const on = tab.id === value;
				return (
					<button
						key={tab.id}
						type="button"
						role="tab"
						aria-selected={on}
						className={`${styles.tab} ${on ? styles.tabOn : ""}`}
						onClick={() => onChange(tab.id)}
					>
						{tab.label}
						{tab.count !== undefined && (
							<span className={styles.count}>{tab.count}</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
