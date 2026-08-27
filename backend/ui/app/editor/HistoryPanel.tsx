"use client";

import { useState } from "react";
import useSWR from "swr";
import type { Change } from "../../lib/platform/versionDiff";
import { SkeletonText } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { Hint } from "./PanelSection";
import styles from "./Editor.module.css";

// Who changed what, and putting a version back.
//
// The entries describe the report rather than the database: "Removed Freight
// from the table" rather than an operation name, because the question someone
// opens a history with is whether to roll a change back.
//
// Restoring never rewrites the past. The version being undone stays in the
// list, and the restore appears as its own entry, so it can be undone in turn.

interface HistoryEntry {
	version: number;
	author: string | null;
	createdOn: string;
	label: string | null;
	changes: Change[];
	isCurrent: boolean;
}

interface HistoryPanelProps {
	slug: string;
	// Bumped by the editor after a save, so the list picks the new version up
	// without the author having to close and reopen it.
	refreshKey: number;
	onRestored: () => void;
}

function when(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return "";
	const minutes = Math.floor((Date.now() - then) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return hours === 1 ? "1 hr ago" : `${hours} hrs ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
	return new Date(then).toLocaleDateString();
}

function personFor(email: string | null): string {
	if (!email) return "Someone";
	const local = email.split("@")[0] ?? email;
	return local
		.replace(/[._-]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

const kindMarks: Record<Change["kind"], string> = {
	added: "+",
	removed: "−",
	changed: "•",
	moved: "↕",
	renamed: "✎",
};

export function HistoryPanel({
	slug,
	refreshKey,
	onRestored,
}: HistoryPanelProps) {
	const { data, isLoading, mutate } = useSWR<{
		entries: HistoryEntry[];
		canRestore: boolean;
	}>(`/api/report/${encodeURIComponent(slug)}/history?k=${refreshKey}`);

	const showSkeleton = useDeferredLoading(isLoading);

	const [restoring, setRestoring] = useState<number | null>(null);
	const [confirming, setConfirming] = useState<number | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const restore = async (version: number) => {
		setRestoring(version);
		setFailure(null);
		try {
			const response = await fetch(
				`/api/report/${encodeURIComponent(slug)}/history`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ version }),
				},
			);
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? "Could not restore that version");
				return;
			}
			setConfirming(null);
			await mutate();
			onRestored();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "Could not restore",
			);
		} finally {
			setRestoring(null);
		}
	};

	const entries = data?.entries ?? [];

	return (
		<div className={styles.historyPanel}>
			<Hint>
				Every save, and what it changed. Restoring applies an old
				version as a new one, so nothing is lost and a restore can
				itself be undone.
			</Hint>

			{failure && <div className={styles.historyError}>{failure}</div>}

			{showSkeleton && <SkeletonText lines={4} />}

			{!isLoading && entries.length === 0 && (
				<p className={styles.listEmpty}>
					No saves recorded yet. The history starts at the next one.
				</p>
			)}

			<ol className={styles.historyList}>
				{entries.map((entry) => (
					<li
						key={entry.version}
						className={`${styles.historyEntry} ${
							entry.isCurrent ? styles.historyCurrent : ""
						}`}
					>
						<div className={styles.historyMeta}>
							<span className={styles.historyAuthor}>
								{personFor(entry.author)}
							</span>
							<span
								className={styles.historyWhen}
								title={new Date(
									entry.createdOn,
								).toLocaleString()}
							>
								{when(entry.createdOn)}
							</span>
							{entry.isCurrent && (
								<span className={styles.historyBadge}>
									current
								</span>
							)}
						</div>

						{entry.label && (
							<div className={styles.historyLabel}>
								{entry.label}
							</div>
						)}

						<ul className={styles.changeList}>
							{entry.changes.map((change, i) => (
								<li key={i} className={styles.change}>
									<span
										className={`${styles.changeMark} ${
											styles[
												change.kind === "added"
													? "markAdded"
													: change.kind === "removed"
														? "markRemoved"
														: "markChanged"
											]
										}`}
										aria-hidden="true"
									>
										{kindMarks[change.kind]}
									</span>
									{change.text}
								</li>
							))}
						</ul>

						{data?.canRestore && !entry.isCurrent && (
							<div className={styles.historyActions}>
								{confirming === entry.version ? (
									<>
										<span className={styles.hint}>
											Put the report back to this?
										</span>
										<button
											type="button"
											className={`${styles.toolButton} ${styles.primary}`}
											onClick={() =>
												restore(entry.version)
											}
											disabled={restoring !== null}
										>
											{restoring === entry.version
												? "Restoring"
												: "Restore"}
										</button>
										<button
											type="button"
											className={styles.toolButton}
											onClick={() => setConfirming(null)}
										>
											Cancel
										</button>
									</>
								) : (
									<button
										type="button"
										className={styles.toolButton}
										onClick={() =>
											setConfirming(entry.version)
										}
									>
										Restore this version
									</button>
								)}
							</div>
						)}
					</li>
				))}
			</ol>
		</div>
	);
}
