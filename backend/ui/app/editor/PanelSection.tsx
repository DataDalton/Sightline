"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import styles from "./Editor.module.css";

// The pieces the properties panel is built from.
//
// The panel held nine stacked groups with no way to close any of them, so
// reaching the tooltip settings meant scrolling past the series colours every
// time. A group collapses now, and its header carries a count of what has been
// set inside it, so an author can see where the changes are without opening
// each one.
//
// Which groups start open is a per-panel decision the caller makes. Once
// somebody opens or closes one, that choice outranks the default and survives
// switching tabs, because SectionGroup holds it above both tabs.

interface SectionStore {
	isOpen: (id: string, fallback: boolean) => boolean;
	set: (id: string, open: boolean) => void;
}

const SectionContext = createContext<SectionStore | null>(null);

export function SectionGroup({ children }: { children: ReactNode }) {
	const [opened, setOpened] = useState<Record<string, boolean>>({});
	const store: SectionStore = {
		isOpen: (id, fallback) => opened[id] ?? fallback,
		set: (id, open) => setOpened((current) => ({ ...current, [id]: open })),
	};
	return (
		<SectionContext.Provider value={store}>
			{children}
		</SectionContext.Provider>
	);
}

export function Section({
	id,
	title,
	// How many settings inside carry a value. Left undefined where counting is
	// meaningless, and hidden at zero so an untouched group stays quiet.
	count,
	defaultOpen = true,
	children,
}: {
	id: string;
	title: string;
	count?: number;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	const store = useContext(SectionContext);
	const [local, setLocal] = useState(defaultOpen);
	const open = store ? store.isOpen(id, defaultOpen) : local;
	const toggle = () => (store ? store.set(id, !open) : setLocal(!open));

	return (
		<div className={styles.section}>
			<button
				type="button"
				className={styles.sectionHead}
				aria-expanded={open}
				onClick={toggle}
			>
				<Chevron open={open} />
				<span className={styles.sectionTitle}>{title}</span>
				{count !== undefined && count > 0 && (
					<span className={styles.sectionCount}>{count}</span>
				)}
			</button>
			{open && <div className={styles.sectionBody}>{children}</div>}
		</div>
	);
}

// Explanatory text under a control.
//
// A quiet line rather than the bordered block the panel used to put under every
// setting. Forty of those in one column stop being explanation and become the
// thing the reader has to look past to find the controls.
export function Hint({ children }: { children: ReactNode }) {
	return <p className={styles.hint}>{children}</p>;
}

export function Chevron({ open }: { open: boolean }) {
	return (
		<svg
			className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
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
			<path d="M9 18l6-6-6-6" />
		</svg>
	);
}

export function ArrowUpIcon() {
	return (
		<svg
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
			<path d="M12 19V5M5 12l7-7 7 7" />
		</svg>
	);
}

export function ArrowDownIcon() {
	return (
		<svg
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
			<path d="M12 5v14M19 12l-7 7-7-7" />
		</svg>
	);
}

export function CloseIcon() {
	return (
		<svg
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
			<path d="M18 6L6 18M6 6l12 12" />
		</svg>
	);
}
