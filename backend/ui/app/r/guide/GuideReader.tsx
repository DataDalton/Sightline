"use client";

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type RefObject,
} from "react";
import { sectionsOf, type Block } from "../../../lib/guide/markdown";
import { GuideInline, GuideMarkdown } from "./GuideMarkdown";
import styles from "./Guide.module.css";

// Reading a guide that runs long: its sections in a bar that stays in view and
// marks the one being read, each section folded and unfolded on its own, text
// found and stepped through, and a link straight to any section. On a wide
// panel the sections move to a column down the left, as a documentation site
// lays them out.

const prefix = "guide-";
// Where a heading lands below the bar when jumped to.
const spyOffset = 96;

// Sections this reader folded, kept in their browser per report. A reader who
// folds the background once does not have to again.
function readFolded(key: string): Set<string> {
	try {
		const held = window.localStorage.getItem(key);
		return new Set(held ? (JSON.parse(held) as string[]) : []);
	} catch {
		return new Set();
	}
}

function Icon({ path, size = 14 }: { path: string; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}

const icons = {
	chevron: "M6 9l6 6 6-6",
	link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
	search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
	up: "M18 15l-6-6-6 6",
	down: "M6 9l6 6 6-6",
	collapse: "M7 14l5-5 5 5M7 20l5-5 5 5",
	expand: "M7 4l5 5 5-5M7 10l5 5 5-5",
	check: "M20 6L9 17l-5-5",
};

// Whether the browser can mark found text without changing the page.
function canHighlight(): boolean {
	return typeof CSS !== "undefined" && "highlights" in CSS;
}

// How found text looks. Added to the page once, from here rather than a
// stylesheet, since the pseudo-element is newer than the stylesheet tooling
// and a rule it cannot read would stop the whole sheet from building.
const findStyleId = "guide-find-style";
function ensureFindStyle(): void {
	if (document.getElementById(findStyleId)) return;
	const style = document.createElement("style");
	style.id = findStyleId;
	style.textContent = [
		"::highlight(guide-find) { background: color-mix(in srgb, var(--brand) 30%, transparent); }",
		"::highlight(guide-find-current) { background: var(--brand); color: var(--brand-contrast); }",
	].join(" ");
	document.head.appendChild(style);
}

export function GuideReader({
	blocks,
	slug,
	scrollRoot,
	wide,
	initialSection,
	fileHref,
}: {
	blocks: Block[];
	slug: string;
	// The panel's scrolling body, which the bar sticks to and the spy reads.
	scrollRoot: RefObject<HTMLDivElement | null>;
	wide: boolean;
	// A section named in the address, opened and scrolled to once.
	initialSection: string | null;
	fileHref: (name: string) => string | null;
}) {
	const { lead, sections } = useMemo(() => sectionsOf(blocks), [blocks]);
	const storageKey = `guide.folded.${slug}`;
	const [folded, setFolded] = useState<Set<string>>(() =>
		readFolded(storageKey),
	);
	const [query, setQuery] = useState("");
	const [matchIndex, setMatchIndex] = useState(0);
	const [matchCount, setMatchCount] = useState(0);
	const [current, setCurrent] = useState<string | null>(
		sections[0]?.id ?? null,
	);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const contentsRef = useRef<HTMLElement | null>(null);
	const ranges = useRef<Range[]>([]);
	const jumped = useRef(false);

	const needle = query.trim().toLowerCase();
	// A section holding found text opens while the text is looked for, without
	// changing what the reader folded.
	const foundIn = useMemo(
		() =>
			new Set(
				needle
					? sections
							.filter((section) =>
								section.text.toLowerCase().includes(needle),
							)
							.map((section) => section.id)
					: [],
			),
		[needle, sections],
	);
	const isOpen = (id: string) => !folded.has(id) || foundIn.has(id);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				storageKey,
				JSON.stringify([...folded]),
			);
		} catch {
			// A browser that keeps nothing folds afresh each time.
		}
	}, [folded, storageKey]);

	const setFold = (id: string, fold: boolean) =>
		setFolded((held) => {
			const next = new Set(held);
			if (fold) next.add(id);
			else next.delete(id);
			return next;
		});

	// The section a heading belongs to, for a heading inside one.
	const sectionOf = useCallback(
		(id: string) =>
			sections.find(
				(section) =>
					section.id === id ||
					section.blocks.some(
						(block) => block.t === "heading" && block.id === id,
					),
			)?.id ?? null,
		[sections],
	);

	const goTo = useCallback(
		(id: string) => {
			const owner = sectionOf(id);
			if (owner) {
				setFolded((held) => {
					if (!held.has(owner)) return held;
					const next = new Set(held);
					next.delete(owner);
					return next;
				});
			}
			// After the section has opened, so the heading has somewhere to be.
			requestAnimationFrame(() => {
				const target = contentRef.current?.querySelector(
					`#${CSS.escape(prefix + id)}`,
				);
				target?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		},
		[sectionOf],
	);

	// The address named a section. Opened once, when the guide has loaded.
	useEffect(() => {
		if (jumped.current || !initialSection || sections.length === 0) return;
		jumped.current = true;
		goTo(initialSection);
	}, [initialSection, sections.length, goTo]);

	// The section being read is the last whose heading has passed under the bar.
	useEffect(() => {
		const root = scrollRoot.current;
		if (!root) return;
		const spy = () => {
			const top = root.getBoundingClientRect().top + spyOffset;
			let reading: string | null = sections[0]?.id ?? null;
			for (const element of root.querySelectorAll<HTMLElement>(
				"[data-section]",
			)) {
				if (element.getBoundingClientRect().top <= top) {
					reading = element.dataset.section ?? reading;
				}
			}
			setCurrent(reading);
		};
		spy();
		root.addEventListener("scroll", spy, { passive: true });
		return () => root.removeEventListener("scroll", spy);
	}, [scrollRoot, sections]);

	// The marked section stays in view in the bar as the reader moves through.
	useEffect(() => {
		if (!current) return;
		contentsRef.current
			?.querySelector<HTMLElement>(
				`[data-contents="${CSS.escape(current)}"]`,
			)
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [current]);

	// Found text, marked where it is without changing the page, and the one
	// stepped to marked more strongly and brought into view.
	useEffect(() => {
		const root = contentRef.current;
		const highlights = canHighlight() ? CSS.highlights : null;
		if (highlights) ensureFindStyle();
		highlights?.delete("guide-find");
		highlights?.delete("guide-find-current");
		ranges.current = [];
		if (!root || !needle) {
			setMatchCount(0);
			return;
		}
		const found: Range[] = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = (node.textContent ?? "").toLowerCase();
			let at = text.indexOf(needle);
			while (at >= 0) {
				const range = document.createRange();
				range.setStart(node, at);
				range.setEnd(node, at + needle.length);
				found.push(range);
				at = text.indexOf(needle, at + needle.length);
			}
		}
		ranges.current = found;
		setMatchCount(found.length);
		if (highlights && found.length > 0) {
			highlights.set("guide-find", new Highlight(...found));
		}
	}, [needle, folded, foundIn, blocks]);

	useEffect(() => {
		const found = ranges.current;
		const highlights = canHighlight() ? CSS.highlights : null;
		highlights?.delete("guide-find-current");
		if (found.length === 0) return;
		const index = Math.min(matchIndex, found.length - 1);
		const range = found[index];
		if (highlights)
			highlights.set("guide-find-current", new Highlight(range));
		range.startContainer.parentElement?.scrollIntoView({
			behavior: "smooth",
			block: "center",
		});
	}, [matchIndex, matchCount]);

	// Marks cleared when the reader leaves the guide.
	useEffect(
		() => () => {
			if (!canHighlight()) return;
			CSS.highlights.delete("guide-find");
			CSS.highlights.delete("guide-find-current");
		},
		[],
	);

	const step = (by: number) => {
		if (matchCount === 0) return;
		setMatchIndex((index) => (index + by + matchCount) % matchCount);
	};

	const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			step(event.shiftKey ? -1 : 1);
		} else if (event.key === "Escape" && query) {
			event.stopPropagation();
			setQuery("");
		}
	};

	const copyLink = (id: string) => {
		const url = `${window.location.origin}${window.location.pathname}?guide=1&section=${encodeURIComponent(id)}`;
		void navigator.clipboard
			?.writeText(url)
			.then(() => {
				setCopiedId(id);
				setTimeout(
					() => setCopiedId((held) => (held === id ? null : held)),
					1500,
				);
			})
			.catch(() => {});
	};

	const targets = { fileHref, onAnchor: goTo };
	const navigable = sections.length >= 2;
	const allFolded = navigable && sections.every((s) => folded.has(s.id));

	const contentsLinks = sections.map((section) => (
		<button
			key={section.id}
			type="button"
			data-contents={section.id}
			aria-current={current === section.id ? "location" : undefined}
			className={`${styles.contentsItem} ${current === section.id ? styles.contentsItemOn : ""}`}
			onClick={() => goTo(section.id)}
		>
			{section.title}
		</button>
	));

	return (
		<div className={wide && navigable ? styles.readerWide : styles.reader}>
			<div className={styles.readerBar}>
				{navigable && !wide && (
					<nav
						ref={contentsRef}
						className={styles.contentsStrip}
						aria-label="Sections"
					>
						{contentsLinks}
					</nav>
				)}
				<div className={styles.readerTools}>
					<label className={styles.find}>
						<Icon path={icons.search} />
						<input
							type="search"
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setMatchIndex(0);
							}}
							onKeyDown={onFindKey}
							placeholder="Find in the guide"
							aria-label="Find in the guide"
						/>
						{needle && (
							<span
								className={styles.findCount}
								aria-live="polite"
							>
								{matchCount === 0
									? "None"
									: `${Math.min(matchIndex, matchCount - 1) + 1} of ${matchCount}`}
							</span>
						)}
					</label>
					{needle && (
						<>
							<button
								type="button"
								className={styles.toolButton}
								onClick={() => step(-1)}
								disabled={matchCount === 0}
								aria-label="Previous match"
								title="Previous match (Shift+Enter)"
							>
								<Icon path={icons.up} />
							</button>
							<button
								type="button"
								className={styles.toolButton}
								onClick={() => step(1)}
								disabled={matchCount === 0}
								aria-label="Next match"
								title="Next match (Enter)"
							>
								<Icon path={icons.down} />
							</button>
						</>
					)}
					{navigable && (
						<button
							type="button"
							className={styles.toolButton}
							onClick={() =>
								setFolded(
									allFolded
										? new Set()
										: new Set(sections.map((s) => s.id)),
								)
							}
							aria-label={
								allFolded ? "Expand all" : "Collapse all"
							}
							title={allFolded ? "Expand all" : "Collapse all"}
						>
							<Icon
								path={allFolded ? icons.expand : icons.collapse}
							/>
						</button>
					)}
				</div>
			</div>

			{wide && navigable && (
				<nav
					ref={contentsRef}
					className={styles.contentsRail}
					aria-label="Sections"
				>
					<span className={styles.contentsRailTitle}>
						On this page
					</span>
					{contentsLinks}
				</nav>
			)}

			<div ref={contentRef} className={styles.readerContent}>
				{lead.length > 0 && (
					<GuideMarkdown
						blocks={lead}
						idPrefix={prefix}
						{...targets}
					/>
				)}
				{sections.map((section) => {
					const open = isOpen(section.id);
					return (
						<section
							key={section.id}
							data-section={section.id}
							className={styles.section}
						>
							<div className={styles.sectionHeading}>
								<button
									type="button"
									className={`${styles.foldButton} ${open ? "" : styles.foldButtonClosed}`}
									aria-expanded={open}
									aria-controls={`${prefix}${section.id}-body`}
									onClick={() => setFold(section.id, open)}
									title={
										open
											? "Fold this section"
											: "Open this section"
									}
								>
									<Icon path={icons.chevron} />
								</button>
								<h3
									id={`${prefix}${section.id}`}
									className={styles.sectionTitle2}
									onClick={() =>
										!open && setFold(section.id, false)
									}
								>
									<GuideInline
										parts={section.heading.c}
										{...targets}
									/>
								</h3>
								<button
									type="button"
									className={styles.sectionLink}
									onClick={() => copyLink(section.id)}
									aria-label={`Copy a link to ${section.title}`}
									title="Copy a link to this section"
								>
									<Icon
										path={
											copiedId === section.id
												? icons.check
												: icons.link
										}
									/>
								</button>
								{copiedId === section.id && (
									<span
										className={styles.linkCopied}
										role="status"
									>
										Link copied
									</span>
								)}
							</div>
							{open && (
								<div id={`${prefix}${section.id}-body`}>
									<GuideMarkdown
										blocks={section.blocks}
										idPrefix={prefix}
										{...targets}
									/>
								</div>
							)}
						</section>
					);
				})}
			</div>
		</div>
	);
}
