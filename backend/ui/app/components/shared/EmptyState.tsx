import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

// What a screen shows with nothing in it yet. Says what would be here and how it gets here,
// so an empty page is somewhere to start rather than a dead end.
export function EmptyState({
	icon,
	title,
	children,
	action,
}: {
	// One SVG path, in the same 24 unit box as the navigation icons.
	icon: string;
	title: string;
	children?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className={styles.empty}>
			<span className={styles.icon} aria-hidden="true">
				<svg
					width="22"
					height="22"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.75"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d={icon} />
				</svg>
			</span>
			<strong className={styles.title}>{title}</strong>
			{children && <p className={styles.body}>{children}</p>}
			{action && <div className={styles.action}>{action}</div>}
		</div>
	);
}

export const emptyIcons = {
	rule: "M9 12l2 2 4-4M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
	check: "M20 6L9 17l-5-5",
	calendar:
		"M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
	send: "M3 11l18-8-8 18-2-8-8-2z",
	target: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
};
