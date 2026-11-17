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
	folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
	lock: "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4",
	search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.35-4.35",
	table: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18",
	columns: "M4 4h16v16H4zM10 4v16M16 4v4M16 12v4",
	bell: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0",
	chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
	inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
	page: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6",
	filter: "M3 5h18l-7 8v6l-4 2v-8z",
	power: "M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10",
	grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
};
