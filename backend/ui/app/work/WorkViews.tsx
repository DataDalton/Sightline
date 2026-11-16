"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Toggle } from "../components/shared/Toggle";
import { postJson } from "./labels";
import styles from "../r/FieldPicker.module.css";
import workStyles from "./Work.module.css";

// Saved views of the queue, chosen and saved the way a report page's views
// are. A view holds the filters, the tab and the grouping. Saving one never
// changes what anybody else sees unless it is shared.

export interface WorkSavedView<State> {
	view_id: string;
	owner_email: string;
	name: string;
	shared: boolean;
	state: State;
}

const viewsKey = "/api/work/views";

export function WorkViews<State>({
	me,
	current,
	activeViewId,
	onApply,
}: {
	me: string;
	// What saving now would keep.
	current: State;
	activeViewId: string | null;
	// Null goes back to the queue with nothing chosen.
	onApply: (view: WorkSavedView<State> | null) => void;
}) {
	const { data, mutate } = useSWR<{ views: WorkSavedView<State>[] }>(
		viewsKey,
	);
	const views = data?.views ?? [];
	const [open, setOpen] = useState(false);
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState("");
	const [shared, setShared] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<WorkSavedView<State> | null>(null);
	const wrapperRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			if (!wrapperRef.current?.contains(event.target as Node)) {
				setOpen(false);
				setNaming(false);
			}
		};
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, [open]);

	const save = async () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		setBusy(true);
		setError(null);
		try {
			const answer = await postJson(viewsKey, {
				name: trimmed,
				shared,
				state: current,
			});
			const saved = await mutate();
			const view = saved?.views.find((v) => v.view_id === answer.id);
			if (view) onApply(view);
			setNaming(false);
			setName("");
			setShared(false);
			setOpen(false);
		} catch (failure) {
			setError(
				failure instanceof Error ? failure.message : "Could not save",
			);
		} finally {
			setBusy(false);
		}
	};

	const remove = async (view: WorkSavedView<State>) => {
		setBusy(true);
		setError(null);
		try {
			await postJson(viewsKey, { remove: view.view_id });
			await mutate();
			if (activeViewId === view.view_id) onApply(null);
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "Could not delete the view",
			);
		} finally {
			setBusy(false);
			setDeleting(null);
		}
	};

	const activeName =
		views.find((v) => v.view_id === activeViewId)?.name ?? "Default view";

	return (
		<div className={styles.wrapper} ref={wrapperRef}>
			<button
				type="button"
				className={`${styles.trigger} ${styles.triggerQuiet}`}
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
					aria-hidden="true"
				>
					<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
				</svg>
				<span>Viewing: {activeName}</span>
				<svg
					className={styles.triggerChevron}
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.4"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="m6 9 6 6 6-6" />
				</svg>
			</button>

			{open && (
				<div className={styles.panel} style={{ width: 340 }}>
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
								className={`${styles.checkbox} ${activeViewId === null ? styles.checked : ""}`}
								aria-hidden="true"
							/>
							<span className={styles.itemLabel}>
								Default view
							</span>
						</button>

						{views.length > 0 && (
							<div className={styles.groupTitle}>Saved</div>
						)}
						{views.map((view) => {
							const own =
								view.owner_email.toLowerCase() ===
								me.toLowerCase();
							return (
								<div
									key={view.view_id}
									className={styles.viewRow}
								>
									<button
										type="button"
										className={styles.item}
										onClick={() => {
											onApply(view);
											setOpen(false);
										}}
									>
										<span
											className={`${styles.checkbox} ${activeViewId === view.view_id ? styles.checked : ""}`}
											aria-hidden="true"
										/>
										<span className={styles.itemLabel}>
											{view.name}
										</span>
										{view.shared && (
											<span className={styles.kindTag}>
												shared
											</span>
										)}
									</button>
									{own && (
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
							);
						})}
					</div>

					<div className={styles.footer}>
						{naming ? (
							<div className={workStyles.viewNaming}>
								<input
									className={styles.searchInput}
									placeholder="View name"
									value={name}
									maxLength={80}
									autoFocus
									onChange={(e) => setName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") void save();
										if (e.key === "Escape")
											setNaming(false);
									}}
								/>
								<Toggle
									checked={shared}
									onChange={setShared}
									label="Share with everyone who uses the queue"
								/>
								<div className={workStyles.viewNamingActions}>
									<button
										type="button"
										className={styles.footerButton}
										onClick={() => setNaming(false)}
									>
										Cancel
									</button>
									<button
										type="button"
										className={`${styles.footerButton} ${styles.primary}`}
										onClick={() => void save()}
										disabled={busy || name.trim() === ""}
									>
										{busy ? "Saving" : "Save"}
									</button>
								</div>
							</div>
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
					body={`${deleting.name} is deleted${deleting.shared ? ", for everyone it was shared with too" : ""}. The queue itself does not change.`}
					busy={busy}
					onConfirm={() => void remove(deleting)}
					onCancel={() => setDeleting(null)}
				/>
			)}
		</div>
	);
}
