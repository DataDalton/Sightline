"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { usePageFilters, type FilterClause } from "../visuals/PageFilters";
import type { GridState } from "../../lib/visuals/gridState";
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
	// What the page's filter controls and switchers were set to.
	pageFilters?: Record<string, FilterClause[]>;
	dimension?: string | null;
	grain?: string | null;
	// What was chosen inside each table: its sort, column filters and search.
	gridStates?: Record<string, GridState>;
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
	// Whether the page opened with nothing asked of it, which is when a reader's
	// own default view is put on it. A link says what it wants, and that wins.
	mayOpenOnDefault?: boolean;
	onApply: (view: SavedView | null) => void;
}

export function SavedViews({
	reportId,
	pageId,
	current,
	activeViewId,
	requestedViewId,
	mayOpenOnDefault = false,
	onApply: applyToPage,
}: SavedViewsProps) {
	const { applySelection } = usePageFilters();

	// A view saved before filters were recorded leaves the filters as they are.
	const onApply = (view: SavedView | null) => {
		if (!view) {
			applySelection(null);
		} else if (view.config.pageFilters) {
			applySelection({
				filters: view.config.pageFilters,
				dimension: view.config.dimension,
				grain: view.config.grain,
			});
		}
		applyToPage(view);
	};

	const [open, setOpen] = useState(false);
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The view waiting on a yes before it is deleted.
	const [deleting, setDeleting] = useState<SavedView | null>(null);
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

	// The reader's own default, once, when the page opens with nothing else
	// asked of it. Only their own: somebody else's default is not this reader's
	// choice.
	const defaultApplied = useRef(false);
	useEffect(() => {
		if (!mayOpenOnDefault || !data || defaultApplied.current) return;
		defaultApplied.current = true;
		const own = views.find((v) => v.isDefault && v.isOwner);
		if (own) onApply(own);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mayOpenOnDefault, data]);

	// Sets or clears the view this reader opens on. The server keeps it to one.
	const setOpenOn = async (view: SavedView) => {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/views", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					viewId: view.viewId,
					reportId,
					pageId,
					name: view.name,
					config: view.config,
					isShared: view.isShared,
					isDefault: !view.isDefault,
				}),
			});
			if (!response.ok) throw new Error("Could not change that");
			await mutate();
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "Could not change that",
			);
		} finally {
			setBusy(false);
		}
	};

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
		setError(null);
		try {
			const response = await fetch(`/api/views/${viewId}`, {
				method: "DELETE",
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				throw new Error(detail?.error ?? "Could not delete the view");
			}
			await mutate();
			if (activeViewId === viewId) onApply(null);
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "Could not delete the view",
			);
		} finally {
			setBusy(false);
			setDeleting(null);
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
							// The delete control sits beside the view rather than inside it, since
							// a button nested in a button is not reachable or announced reliably.
							<div key={view.viewId} className={styles.viewRow}>
								<button
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
									{view.isShared && (
										<span className={styles.kindTag}>
											shared
										</span>
									)}
								</button>
								{view.isOwner && (
									<button
										type="button"
										className={styles.viewDelete}
										onClick={() => void setOpenOn(view)}
										disabled={busy}
										aria-pressed={view.isDefault}
										aria-label={`Open this page with ${view.name}`}
										title={
											view.isDefault
												? "This page opens with this view. Click to stop."
												: "Open this page with this view"
										}
									>
										<svg
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill={
												view.isDefault
													? "currentColor"
													: "none"
											}
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
											aria-hidden="true"
										>
											<path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z" />
										</svg>
									</button>
								)}
								{view.isOwner && (
									<button
										type="button"
										className={styles.viewDelete}
										onClick={() => setDeleting(view)}
										disabled={busy}
										aria-label={`Delete ${view.name}`}
										title="Delete this view"
									>
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
											<path d="M18 6L6 18M6 6l12 12" />
										</svg>
									</button>
								)}
							</div>
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

			{deleting && (
				<ConfirmDialog
					title="Delete this view?"
					body={`${deleting.name} is deleted, for anyone it was shared with too. The report itself does not change.`}
					busy={busy}
					onConfirm={() => void remove(deleting.viewId)}
					onCancel={() => setDeleting(null)}
				/>
			)}
		</div>
	);
}
