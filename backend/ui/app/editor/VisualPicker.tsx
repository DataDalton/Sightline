"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	categoryLabels,
	categoryOrder,
	visualCatalog,
	type VisualCategory,
	type VisualTypeDefinition,
} from "../../lib/visuals/catalog";
import { VisualThumbnail } from "./VisualThumbnail";
import { VisualPreview } from "./VisualPreview";
import styles from "./VisualPicker.module.css";

// Choosing what to add.
//
// A picker is where chart choice actually happens, so it shows the mark rather
// than only naming it, and puts the guidance next to the choice instead of in
// documentation nobody opens. The types people reach for least often are
// exactly the ones a text list hides, which is why every entry has a drawing.
//
// Categories are the organising principle rather than an alphabetical list,
// because an author arrives knowing what they want to say ("compare these",
// "show the trend") and not which chart name corresponds to it.

interface VisualPickerProps {
	open: boolean;
	onPick: (type: string) => void;
	onClose: () => void;
	// Which category to open at. Set when the picker is reached from something
	// that already knows what kind of thing is wanted, such as the filter
	// strip, so the author is not asked the question twice.
	initialCategory?: VisualCategory;
}

export function VisualPicker({
	open,
	onPick,
	onClose,
	initialCategory,
}: VisualPickerProps) {
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState<VisualCategory | "all">(
		initialCategory ?? "all",
	);
	const [hovered, setHovered] = useState<VisualTypeDefinition | null>(null);
	// Viewport coordinates of the preview, measured from the card it belongs
	// to. Portalled and fixed, so the dialog cannot clip a preview anchored to
	// a card in the last row.
	const [previewAt, setPreviewAt] = useState<{
		left: number;
		top: number;
	} | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		setSearch("");
		setCategory(initialCategory ?? "all");
		setHovered(null);
		setPreviewAt(null);
		// Focus goes to the search box, so typing narrows immediately rather
		// than requiring a click first.
		const timer = setTimeout(() => inputRef.current?.focus(), 20);

		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, onClose, initialCategory]);

	// Beside the card, or on its other side when there is no room. A preview
	// half off the screen is worse than one on the left.
	const place = useCallback((element: HTMLElement) => {
		const card = element.getBoundingClientRect();
		const width = 280;
		const height = 380;
		const gap = 10;

		const right = card.right + gap;
		const left =
			right + width > window.innerWidth - 8
				? Math.max(8, card.left - width - gap)
				: right;

		// Anchored to the top of the card, then pulled up only as far as it
		// takes to fit, so the preview stays beside what it describes.
		const top = Math.max(
			8,
			Math.min(card.top, window.innerHeight - height - 8),
		);

		setPreviewAt({ left, top });
	}, []);

	const show = useCallback(
		(definition: VisualTypeDefinition, element: HTMLElement) => {
			setHovered(definition);
			place(element);
		},
		[place],
	);

	const grouped = useMemo(() => {
		const term = search.trim().toLowerCase();
		const matches = visualCatalog.filter((definition) => {
			if (category !== "all" && definition.category !== category)
				return false;
			if (term === "") return true;
			// Guidance is searched as well as the label, so someone typing
			// "over time" finds the line chart without knowing its name.
			return (
				definition.label.toLowerCase().includes(term) ||
				definition.guidance.toLowerCase().includes(term) ||
				definition.type.toLowerCase().includes(term)
			);
		});

		const map = new Map<VisualCategory, VisualTypeDefinition[]>();
		for (const definition of matches) {
			const list = map.get(definition.category) ?? [];
			list.push(definition);
			map.set(definition.category, list);
		}
		return categoryOrder
			.filter((c) => map.has(c))
			.map((c) => ({ category: c, items: map.get(c) ?? [] }));
	}, [search, category]);

	const total = grouped.reduce((sum, g) => sum + g.items.length, 0);

	if (!open) return null;

	return (
		<div
			className={styles.overlay}
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className={styles.dialog}
				ref={panelRef}
				role="dialog"
				aria-label="Add a visual"
				aria-modal="true"
			>
				<div className={styles.header}>
					<div className={styles.searchWrap}>
						<svg
							className={styles.searchIcon}
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
						>
							<circle cx="11" cy="11" r="7" />
							<path d="M21 21l-4.35-4.35" />
						</svg>
						<input
							ref={inputRef}
							type="text"
							className={styles.search}
							placeholder="Search by name, or by what you want to show"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>
					<button
						type="button"
						className={styles.close}
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				<div className={styles.filters}>
					<button
						type="button"
						className={`${styles.filterChip} ${category === "all" ? styles.filterActive : ""}`}
						onClick={() => setCategory("all")}
					>
						All
					</button>
					{categoryOrder.map((c) => (
						<button
							key={c}
							type="button"
							className={`${styles.filterChip} ${category === c ? styles.filterActive : ""}`}
							onClick={() => setCategory(c)}
						>
							{categoryLabels[c]}
						</button>
					))}
				</div>

				<div className={styles.body}>
					{total === 0 ? (
						<div className={styles.empty}>
							Nothing matches &quot;{search}&quot;.
						</div>
					) : (
						grouped.map(({ category: c, items }) => (
							<section key={c} className={styles.group}>
								<h3 className={styles.groupTitle}>
									{categoryLabels[c]}
								</h3>
								<div className={styles.grid}>
									{items.map((definition) => (
										<button
											key={definition.type}
											type="button"
											className={styles.card}
											onClick={() =>
												onPick(definition.type)
											}
											onMouseEnter={(e) =>
												show(
													definition,
													e.currentTarget,
												)
											}
											onFocus={(e) =>
												show(
													definition,
													e.currentTarget,
												)
											}
											onMouseLeave={() => {
												setHovered(null);
												setPreviewAt(null);
											}}
										>
											<span className={styles.preview}>
												<VisualThumbnail
													type={definition.type}
													size={52}
												/>
											</span>
											<span className={styles.cardLabel}>
												{definition.label}
											</span>
											<span className={styles.cardMeta}>
												{describeEncoding(definition)}
											</span>
										</button>
									))}
								</div>
							</section>
						))
					)}
				</div>

				{/* The guidance used to be read from here. It is in the
				    preview now, beside the drawing it describes, so this says
				    the one thing the preview cannot: that there is a preview,
				    and that the keyboard reaches it too. */}
				<div className={styles.footer}>
					<span className={styles.footerHint}>
						Point at a visual, or tab to it, to see what it does.
					</span>
				</div>
			</div>

			{hovered &&
				previewAt &&
				createPortal(
					<VisualPreview definition={hovered} box={previewAt} />,
					document.body,
				)}
		</div>
	);
}

// What the visual needs, in the terms an author thinks in.
function describeEncoding(definition: VisualTypeDefinition): string {
	const { dimensions: d, measures: m } = definition.encoding;
	const parts: string[] = [];

	if (d.min > 0) {
		parts.push(d.min === 1 ? "1 dimension" : `${d.min} dimensions`);
	}
	if (m.min > 0) {
		parts.push(m.min === 1 ? "1 measure" : `${m.min} measures`);
	}
	if (parts.length === 0) return "No fields required";
	return `Needs ${parts.join(" and ")}`;
}
