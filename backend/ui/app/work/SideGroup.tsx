"use client";

import { useEffect, useState, type ReactNode } from "react";
import styles from "./Work.module.css";

// Where each reader's open and closed groups are kept, shared by every request
// so a group left open stays open on the next one.
const storageKey = "work.sideGroups";

function readStored(): Record<string, boolean> {
	try {
		const raw = window.localStorage.getItem(storageKey);
		const parsed = raw ? JSON.parse(raw) : null;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

// A titled group of fields in a request's sidebar. A collapsible group starts
// closed and shows a one-line summary of its values in its header, so what is
// set reads without opening it.
export function SideGroup({
	id,
	title,
	count,
	summary,
	collapsible = false,
	children,
}: {
	id: string;
	title: string;
	// Shown at the right of the header, such as how many sub-tasks are done.
	count?: string;
	summary?: string;
	collapsible?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(!collapsible);

	// Read after mount, so the server render and the first client render agree.
	useEffect(() => {
		if (!collapsible) return;
		const stored = readStored()[id];
		if (stored !== undefined) setOpen(stored);
	}, [collapsible, id]);

	const toggle = () => {
		const next = !open;
		setOpen(next);
		try {
			window.localStorage.setItem(
				storageKey,
				JSON.stringify({ ...readStored(), [id]: next }),
			);
		} catch {
			// Without storage the choice lasts until the page is left.
		}
	};

	return (
		<section className={styles.sideGroup} aria-label={title}>
			{collapsible ? (
				<button
					type="button"
					className={styles.sideGroupToggle}
					aria-expanded={open}
					onClick={toggle}
				>
					<svg
						className={styles.sideGroupChevron}
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M9 6l6 6-6 6" />
					</svg>
					<span className={styles.sideGroupTitle}>{title}</span>
					{!open && summary && (
						<span
							className={styles.sideGroupSummary}
							title={summary}
						>
							{summary}
						</span>
					)}
				</button>
			) : (
				<div className={styles.sideGroupHead}>
					<span className={styles.sideGroupTitle}>{title}</span>
					{count && (
						<span className={styles.sideGroupCount}>{count}</span>
					)}
				</div>
			)}
			{open && <div className={styles.sideGroupBody}>{children}</div>}
		</section>
	);
}
