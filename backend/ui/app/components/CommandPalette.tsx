"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import type { SearchTarget, TargetKind } from "../../lib/platform/search";
import { rankTarget } from "../../lib/platform/searchMatch";
import styles from "./CommandPalette.module.css";

// Everything reachable, one keystroke away.
//
// Reaching a report was Home, then a category, then the report, and that path
// gets longer as the estate grows. This is the flat route: type part of a name
// and go, without knowing which category somebody filed it under.
//
// Matching runs in the browser. The list is bounded by what one person can
// reach, so it is small enough to filter locally, and a request per keystroke
// is what makes a palette feel slower than the navigation it replaces.

interface SearchResponse {
	targets: SearchTarget[];
	recent: string[];
	favourites: string[];
}

const kindIcons: Record<TargetKind, string> = {
	report: "M3 3v18h18M7 15l4-4 3 3 5-6",
	category: "M3 7h7v6H3zM14 7h7v6h-7zM3 16h18v5H3z",
	personal: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
	shared: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87",
	view: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
	action: "M9 18l6-6-6-6",
};

const groupOrder: { kind: TargetKind; label: string }[] = [
	{ kind: "report", label: "Reports" },
	{ kind: "category", label: "Categories" },
	{ kind: "personal", label: "My pages" },
	{ kind: "shared", label: "Shared with me" },
	{ kind: "view", label: "Saved views" },
	{ kind: "action", label: "Go to" },
];

export function CommandPalette({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const router = useRouter();
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	// Fetched only once the palette has been opened, so the cost lands on
	// somebody who used it rather than on every page load.
	const { data } = useSWR<SearchResponse>(open ? "/api/search" : null, {
		revalidateOnFocus: false,
		dedupingInterval: 30000,
	});

	const targets = useMemo(() => data?.targets ?? [], [data]);
	const favourites = useMemo(() => new Set(data?.favourites ?? []), [data]);

	// With nothing typed the palette answers a different question: not "where
	// is this" but "where was I". Favourites first because they were chosen,
	// then recents, which are only evidence.
	const initial = useMemo(() => {
		if (!data) return [];
		const byId = new Map(targets.map((t) => [t.id, t]));
		const picked: SearchTarget[] = [];
		const seen = new Set<string>();

		for (const reportId of data.favourites) {
			const target = byId.get(`report:${reportId}`);
			if (target && !seen.has(target.id)) {
				picked.push(target);
				seen.add(target.id);
			}
		}
		for (const reportId of data.recent) {
			const target = byId.get(`report:${reportId}`);
			if (target && !seen.has(target.id)) {
				picked.push(target);
				seen.add(target.id);
			}
		}
		return picked.slice(0, 8);
	}, [data, targets]);

	const results = useMemo(() => {
		const trimmed = query.trim().toLowerCase();
		if (!trimmed) return initial;

		return targets
			.map((target) => {
				const rank = rankTarget(
					target.title,
					`${target.context ?? ""} ${target.keywords}`,
					trimmed,
				);
				return rank === null ? null : { target, rank };
			})
			.filter((row): row is { target: SearchTarget; rank: number } =>
				Boolean(row),
			)
			.sort(
				(a, b) =>
					b.rank - a.rank ||
					a.target.title.localeCompare(b.target.title),
			)
			.slice(0, 40)
			.map((row) => row.target);
	}, [query, targets, initial]);

	// Grouped for display, flat for the keyboard. The cursor indexes the flat
	// list so arrowing runs straight through the groups.
	const grouped = useMemo(() => {
		if (!query.trim()) {
			return results.length
				? [{ label: "Jump back in", items: results }]
				: [];
		}
		return groupOrder
			.map(({ kind, label }) => ({
				label,
				items: results.filter((t) => t.kind === kind),
			}))
			.filter((group) => group.items.length > 0);
	}, [results, query]);

	const flat = useMemo(
		() => grouped.flatMap((group) => group.items),
		[grouped],
	);

	useEffect(() => {
		setCursor(0);
	}, [query, open]);

	useEffect(() => {
		if (open) {
			setQuery("");
			// Focused after the portal has mounted, or the browser has nothing
			// to move focus to yet.
			const id = requestAnimationFrame(() => inputRef.current?.focus());
			return () => cancelAnimationFrame(id);
		}
	}, [open]);

	const go = useCallback(
		(target: SearchTarget) => {
			onClose();
			router.push(target.href);
		},
		[onClose, router],
	);

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setCursor((c) => (flat.length ? (c + 1) % flat.length : 0));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setCursor((c) =>
				flat.length ? (c - 1 + flat.length) % flat.length : 0,
			);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const target = flat[cursor];
			if (target) go(target);
		} else if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		}
	};

	// Keeps the highlighted row on screen when the keyboard moves past the
	// edge of the scroll box.
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const active = list.querySelector<HTMLElement>(
			`[data-index="${cursor}"]`,
		);
		active?.scrollIntoView({ block: "nearest" });
	}, [cursor]);

	if (!open || typeof document === "undefined") return null;

	let index = -1;

	return createPortal(
		<div
			className={styles.backdrop}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className={styles.panel}
				role="dialog"
				aria-modal="true"
				aria-label="Search"
				onKeyDown={onKeyDown}
			>
				<div className={styles.searchRow}>
					<svg
						className={styles.searchIcon}
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<circle cx="11" cy="11" r="8" />
						<path d="M21 21l-4.35-4.35" />
					</svg>
					<input
						ref={inputRef}
						type="text"
						className={styles.input}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search reports, pages and settings"
						aria-label="Search"
						autoComplete="off"
						spellCheck={false}
					/>
					<span className={styles.escHint}>Esc</span>
				</div>

				<div className={styles.results} ref={listRef}>
					{grouped.length === 0 ? (
						<div className={styles.empty}>
							{!data
								? "Loading"
								: query.trim()
									? `Nothing matches "${query.trim()}"`
									: "Open a report and it appears here."}
						</div>
					) : (
						grouped.map((group) => (
							<div key={group.label}>
								<div className={styles.groupTitle}>
									{group.label}
								</div>
								{group.items.map((target) => {
									index += 1;
									const at = index;
									const isFavourite =
										target.kind === "report" &&
										favourites.has(
											target.id.slice("report:".length),
										);
									return (
										<button
											key={target.id}
											type="button"
											data-index={at}
											className={`${styles.item} ${
												at === cursor
													? styles.itemActive
													: ""
											}`}
											onMouseMove={() => setCursor(at)}
											onClick={() => go(target)}
										>
											<span className={styles.itemIcon}>
												<svg
													width="14"
													height="14"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
													aria-hidden="true"
												>
													<path
														d={
															kindIcons[
																target.kind
															]
														}
													/>
												</svg>
											</span>
											<span className={styles.itemText}>
												<span
													className={styles.itemTitle}
												>
													{target.title}
												</span>
												{target.context && (
													<span
														className={
															styles.itemContext
														}
													>
														{target.context}
													</span>
												)}
											</span>
											{isFavourite && (
												<svg
													className={styles.star}
													width="13"
													height="13"
													viewBox="0 0 24 24"
													fill="currentColor"
													aria-label="Favourite"
												>
													<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />
												</svg>
											)}
										</button>
									);
								})}
							</div>
						))
					)}
				</div>

				<div className={styles.footer}>
					<span>
						<kbd>&uarr;</kbd> <kbd>&darr;</kbd> to move
					</span>
					<span>
						<kbd>&crarr;</kbd> to open
					</span>
				</div>
			</div>
		</div>,
		document.body,
	);
}
