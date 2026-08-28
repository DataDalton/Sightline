"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import styles from "./FieldPicker.module.css";

// Switching between saved views, and saving the current one.
//
// A view captures what the reader chose: columns, filters, sort. It never
// changes the report, so one person's arrangement cannot alter what anyone
// else opens.

export interface SavedViewConfig {
	dimensions?: string[];
	measures?: string[];
	filters?: unknown[];
	sort?: { field: string; direction: "asc" | "desc" }[];
	// How the reader arranged the grid: columns they moved out of report
	// order, and columns they pinned to the left edge.
	columnOrder?: string[];
	pinnedColumns?: string[];
	// Widths the reader dragged columns to, by column name.
	columnWidths?: Record<string, number>;
	// Sizes the reader dragged visuals to, in grid columns and rows.
	visualSizes?: Record<string, { w?: number; h?: number }>;
}

export interface SavedView {
	viewId: string;
	name: string;
	config: SavedViewConfig;
	isDefault: boolean;
	isShared: boolean;
	isOwner: boolean;
}

interface SavedViewsProps {
	reportId: string;
	pageId: string;
	current: SavedViewConfig;
	activeViewId: string | null;
	// A view a link asked for, applied once the list has loaded. The link
	// carries the view's id rather than a copy of its contents, so opening one
	// shows the view as it stands rather than as it was when the link was sent.
	requestedViewId?: string | null;
	onApply: (view: SavedView | null) => void;
}

export function SavedViews({
	reportId,
	pageId,
	current,
	activeViewId,
	requestedViewId,
	onApply,
}: SavedViewsProps) {
	const [open, setOpen] = useState(false);
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const wrapperRef = useRef<HTMLDivElement | null>(null);

	const { data, mutate } = useSWR<{ views: SavedView[] }>(
		`/api/views?pageId=${encodeURIComponent(pageId)}`,
	);
	const views = data?.views ?? [];

	// Applied once, when the list arrives. Guarded on having applied it rather
	// than on activeViewId, because a reader who follows a link and then
	// deliberately clears the view should not have it put back the moment the
	// list revalidates.
	const requestedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!requestedViewId || views.length === 0) return;
		if (requestedRef.current === requestedViewId) return;

		const wanted = views.find((v) => v.viewId === requestedViewId);
		requestedRef.current = requestedViewId;
		// A link to a view somebody has since deleted opens the page as the
		// report defines it, which is the only remaining honest answer.
		if (wanted) onApply(wanted);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [requestedViewId, views.length]);

	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (
				wrapperRef.current &&
				!wrapperRef.current.contains(e.target as Node)
			) {
				setOpen(false);
				setNaming(false);
			}
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [open]);

	const save = async () => {
		const trimmed = name.trim();
		if (!trimmed) return;

		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/views", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					reportId,
					pageId,
					name: trimmed,
					config: current,
				}),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				throw new Error(detail?.error ?? "Could not save");
			}
			const { view } = await response.json();
			await mutate();
			onApply(view);
			setNaming(false);
			setName("");
			setOpen(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not save");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (viewId: string) => {
		setBusy(true);
		try {
			await fetch(`/api/views/${viewId}`, { method: "DELETE" });
			await mutate();
			if (activeViewId === viewId) onApply(null);
		} finally {
			setBusy(false);
		}
	};

	const activeName =
		views.find((v) => v.viewId === activeViewId)?.name ?? "Default view";

	return (
		<div className={styles.wrapper} ref={wrapperRef}>
			<button
				type="button"
				className={styles.trigger}
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-haspopup="true"
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
				</svg>
				{activeName}
			</button>

			{open && (
				<div className={styles.panel} style={{ width: 300 }}>
					<div className={styles.list}>
						<button
							type="button"
							className={styles.item}
							onClick={() => {
								onApply(null);
								setOpen(false);
							}}
						>
							<span
								className={`${styles.checkbox} ${
									activeViewId === null ? styles.checked : ""
								}`}
								aria-hidden="true"
							/>
							<span className={styles.itemLabel}>
								Default view
							</span>
						</button>

						{views.length > 0 && (
							<div className={styles.groupTitle}>Saved</div>
						)}
						{views.map((view) => (
							<button
								key={view.viewId}
								type="button"
								className={styles.item}
								onClick={() => {
									onApply(view);
									setOpen(false);
								}}
							>
								<span
									className={`${styles.checkbox} ${
										activeViewId === view.viewId
											? styles.checked
											: ""
									}`}
									aria-hidden="true"
								/>
								<span className={styles.itemLabel}>
									{view.name}
								</span>
								<span className={styles.kindTag}>
									{view.isShared ? "shared" : ""}
									{view.isOwner && (
										<span
											role="button"
											tabIndex={0}
											onClick={(e) => {
												e.stopPropagation();
												void remove(view.viewId);
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													e.stopPropagation();
													void remove(view.viewId);
												}
											}}
											style={{ marginLeft: 8 }}
											aria-label={`Delete ${view.name}`}
										>
											✕
										</span>
									)}
								</span>
							</button>
						))}
					</div>

					<div className={styles.footer}>
						{naming ? (
							<>
								<input
									className={styles.searchInput}
									placeholder="View name"
									value={name}
									autoFocus
									onChange={(e) => setName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") void save();
									}}
								/>
								<button
									type="button"
									className={`${styles.footerButton} ${styles.primary}`}
									onClick={save}
									disabled={busy || name.trim() === ""}
								>
									{busy ? "Saving" : "Save"}
								</button>
							</>
						) : (
							<button
								type="button"
								className={`${styles.footerButton} ${styles.primary}`}
								onClick={() => setNaming(true)}
							>
								Save current view
							</button>
						)}
					</div>

					{error && (
						<div className={styles.empty} role="alert">
							{error}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
