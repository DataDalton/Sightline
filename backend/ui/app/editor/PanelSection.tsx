"use client";

import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
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
	// Text being searched for across the panel. Every section is open while
	// it is set, and hides itself when nothing inside it matches.
	query: string;
	// Explanations sit behind a small "About this" rather than under every
	// control.
	compactHints: boolean;
}

const SectionContext = createContext<SectionStore | null>(null);

function readStored(key: string | undefined): Record<string, boolean> {
	if (!key) return {};
	try {
		const raw = window.localStorage.getItem(key);
		const parsed = raw ? JSON.parse(raw) : null;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function SectionGroup({
	children,
	query = "",
	persistKey,
	compactHints = false,
}: {
	children: ReactNode;
	query?: string;
	// Where the open and closed choices are kept between visits. Left out, they
	// last as long as the panel does.
	persistKey?: string;
	compactHints?: boolean;
}) {
	const [opened, setOpened] = useState<Record<string, boolean>>({});

	// Read after mount, so the server render and the first client render agree.
	useEffect(() => {
		setOpened(readStored(persistKey));
	}, [persistKey]);

	const store: SectionStore = {
		isOpen: (id, fallback) => opened[id] ?? fallback,
		set: (id, open) =>
			setOpened((current) => {
				const next = { ...current, [id]: open };
				if (persistKey) {
					try {
						window.localStorage.setItem(
							persistKey,
							JSON.stringify(next),
						);
					} catch {
						// Storage blocked. Kept for this visit only.
					}
				}
				return next;
			}),
		query: query.trim().toLowerCase(),
		compactHints,
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
	// Whether it starts open before anyone has opened or closed it. A group
	// that holds a change starts open whatever this says, so what has been set
	// is on screen without hunting for it.
	defaultOpen = true,
	// Other words somebody might search for that the group's text does not
	// use, such as "color" for a group that says "colour".
	keywords,
	children,
}: {
	id: string;
	title: string;
	count?: number;
	defaultOpen?: boolean;
	keywords?: string;
	children: ReactNode;
}) {
	const store = useContext(SectionContext);
	const fallback = defaultOpen || (count ?? 0) > 0;
	const [local, setLocal] = useState(fallback);
	const query = store?.query ?? "";
	const open = query ? true : store ? store.isOpen(id, fallback) : local;
	const toggle = () => (store ? store.set(id, !open) : setLocal(!open));

	// Hidden while a search is on and nothing inside says what was typed. Read
	// from what is drawn rather than from a list kept beside it, so a control
	// added to a group is found without anybody remembering to register it.
	const ref = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		if (!query) {
			element.hidden = false;
			return;
		}
		const text =
			`${title} ${keywords ?? ""} ${element.textContent ?? ""}`.toLowerCase();
		// At the start of a word, so "top" finds "Keep only the top" and not
		// the "stops" in an explanation beside something else.
		const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		element.hidden = !new RegExp(`(^|[^a-z0-9])${escaped}`).test(text);
	});

	return (
		<div ref={ref} className={styles.section} data-section={id}>
			<button
				type="button"
				className={styles.sectionHead}
				aria-expanded={open}
				onClick={toggle}
				disabled={Boolean(query)}
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
// thing the reader has to look past to find the controls. Where the panel asks
// for it, the line waits behind a small "About this" until somebody wants it.
export function Hint({ children }: { children: ReactNode }) {
	const store = useContext(SectionContext);
	if (store?.compactHints) {
		return (
			<details className={styles.hintMore}>
				<summary className={styles.hintSummary}>
					<InfoIcon />
					About this
				</summary>
				<p className={styles.hint}>{children}</p>
			</details>
		);
	}
	return <p className={styles.hint}>{children}</p>;
}

function InfoIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v5M12 8h.01" />
		</svg>
	);
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
