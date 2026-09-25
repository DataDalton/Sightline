"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ago } from "../admin/when";
import type { ExploreState } from "../../lib/explore/state";
import styles from "./Explore.module.css";

// Explorations saved to come back to, and the current one saved or updated.
//
// A saved view holds the question rather than the answer: the dataset, the
// columns and the conditions. Opening it runs the question again, so it shows
// the data as it is now.

export interface SavedView {
	id: string;
	name: string;
	state: ExploreState;
	modifiedOn: string;
}

export const viewsKey = "/api/explore/views";

function Icon({ d, size = 14 }: { d: string; size?: number }) {
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
			<path d={d} />
		</svg>
	);
}

const bookmark = "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z";

export function SavedViews({
	current,
	currentView,
	modified,
	sourceTitle,
	onOpen,
	onSaved,
}: {
	// What is on screen now, or null before a dataset is chosen.
	current: ExploreState | null;
	// The saved view that is open, if one is.
	currentView: { id: string; name: string } | null;
	// Whether what is on screen differs from the open view as saved.
	modified: boolean;
	sourceTitle: (key: string) => string;
	onOpen: (view: SavedView) => void;
	onSaved: (view: SavedView) => void;
}) {
	const { data, mutate } = useSWR<{ views: SavedView[] }>(viewsKey);
	const views = data?.views ?? [];
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const away = (e: MouseEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", key);
		};
	}, [open]);

	const request = async (url: string, init: RequestInit) => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch(url, {
				...init,
				headers: { "Content-Type": "application/json" },
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) throw new Error(body?.error ?? "Could not save");
			await mutate();
			return body;
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "Could not save",
			);
			return null;
		} finally {
			setBusy(false);
		}
	};

	const saveNew = async () => {
		if (!current || !name.trim()) return;
		const view = await request(viewsKey, {
			method: "POST",
			body: JSON.stringify({ name, state: current }),
		});
		if (view) {
			setName("");
			onSaved(view as SavedView);
		}
	};

	const update = async () => {
		if (!current || !currentView) return;
		const view = await request(`${viewsKey}/${currentView.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: current }),
		});
		if (view) onSaved(view as SavedView);
	};

	const remove = async (id: string) => {
		setConfirming(null);
		await request(`${viewsKey}/${id}`, { method: "DELETE" });
	};

	// The address carries the exploration, so copying it shares exactly what
	// is on screen. Whoever opens it sees it under their own access.
	const copyLink = () => {
		void navigator.clipboard?.writeText(window.location.href).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<div className={styles.viewsWrap} ref={wrapRef}>
			{current && (
				<button
					type="button"
					className={styles.headerButton}
					onClick={copyLink}
					title="Copy a link to this exploration"
				>
					<Icon d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1 1M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1-1" />
					{copied ? "Copied" : "Copy link"}
				</button>
			)}
			<button
				type="button"
				className={`${styles.headerButton} ${open ? styles.headerButtonOn : ""}`}
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
			>
				<Icon d={bookmark} />
				Saved views
				{views.length > 0 && (
					<span className={styles.viewsCount}>{views.length}</span>
				)}
			</button>

			{open && (
				<div
					className={styles.viewsPanel}
					role="dialog"
					aria-label="Saved views"
				>
					{current ? (
						<div className={styles.viewsSave}>
							{currentView && modified && (
								<button
									type="button"
									className={styles.viewsUpdate}
									disabled={busy}
									onClick={() => void update()}
								>
									Update &ldquo;{currentView.name}&rdquo;
								</button>
							)}
							<form
								className={styles.viewsSaveRow}
								onSubmit={(e) => {
									e.preventDefault();
									void saveNew();
								}}
							>
								<input
									className={styles.viewsName}
									value={name}
									placeholder={
										currentView
											? "Save a copy as"
											: "Name this view"
									}
									aria-label="View name"
									maxLength={120}
									onChange={(e) => setName(e.target.value)}
								/>
								<button
									type="submit"
									className={styles.viewsSaveButton}
									disabled={busy || !name.trim()}
								>
									Save
								</button>
							</form>
							{failure && (
								<p className={styles.viewsFailure}>{failure}</p>
							)}
						</div>
					) : (
						<p className={styles.viewsHint}>
							Choose a dataset and some columns to save a view.
						</p>
					)}

					{views.length === 0 ? (
						<div className={styles.viewsEmpty}>
							<span
								className={styles.viewsEmptyIcon}
								aria-hidden="true"
							>
								<Icon d={bookmark} size={20} />
							</span>
							<p className={styles.viewsEmptyTitle}>
								No saved views yet
							</p>
							<p className={styles.viewsEmptyText}>
								Save an exploration to come back to it, with the
								data as it is when you open it.
							</p>
						</div>
					) : (
						<ul className={styles.viewsList}>
							{views.map((view) => (
								<li
									key={view.id}
									className={`${styles.viewsItem} ${
										view.id === currentView?.id
											? styles.viewsItemOn
											: ""
									}`}
								>
									<button
										type="button"
										className={styles.viewsOpen}
										onClick={() => {
											onOpen(view);
											setOpen(false);
										}}
									>
										<span className={styles.viewsItemName}>
											{view.name}
										</span>
										<span className={styles.viewsItemMeta}>
											{sourceTitle(view.state.sourceKey)}{" "}
											· {view.state.columns.length}{" "}
											{view.state.columns.length === 1
												? "column"
												: "columns"}
											{view.state.conditions.length > 0 &&
												` · ${view.state.conditions.length} ${
													view.state.conditions
														.length === 1
														? "filter"
														: "filters"
												}`}{" "}
											· {ago(view.modifiedOn)}
										</span>
									</button>
									{confirming === view.id ? (
										<span className={styles.viewsConfirm}>
											<button
												type="button"
												className={styles.viewsDelete}
												onClick={() =>
													void remove(view.id)
												}
											>
												Delete
											</button>
											<button
												type="button"
												className={styles.viewsKeep}
												onClick={() =>
													setConfirming(null)
												}
											>
												Keep
											</button>
										</span>
									) : (
										<button
											type="button"
											className={styles.viewsIcon}
											title="Delete this view"
											aria-label={`Delete ${view.name}`}
											onClick={() =>
												setConfirming(view.id)
											}
										>
											<Icon d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
										</button>
									)}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
