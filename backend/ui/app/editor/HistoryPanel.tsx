"use client";

import { useState } from "react";
import useSWR from "swr";
import type { Change } from "../../lib/platform/versionDiff";
import type { SourceMeta } from "../visuals/types";
import { Modal } from "../components/shared/Modal";
import { SkeletonText } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { CompareVersions } from "./CompareVersions";
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
//
// The summary answers whether to roll a version back. Comparing answers what
// exactly it did, which is the question that follows, and it opens over the
// canvas rather than in this panel because two versions of a definition need
// the width.
//
// Restoring asks in a dialog rather than in the entry. It rewrites every page
// of the report, which is the largest single thing this panel can do, and a
// confirmation that appears inside a scrolling list can be agreed to without
// being read. The dialog also has room to say what a restore actually does,
// which is the part that stops it feeling irreversible.

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
	// Handed through to the comparison, which draws both versions of the page
	// with the renderer a reader gets rather than describing them.
	reportId: string;
	sources: Record<string, SourceMeta>;
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

// Putting the report back to an earlier version.
//
// Says what a restore does before asking, because "restore" reads as throwing
// the newer work away and it does not: the version being undone stays in the
// list, the restore lands as a new version of its own, and undoing the undo is
// the same two clicks. Somebody who knows that presses the button. Somebody who
// does not goes and asks a colleague first.
function RestoreDialog({
	entry,
	version,
	busy,
	failure,
	onConfirm,
	onClose,
}: {
	entry: HistoryEntry | undefined;
	version: number;
	busy: boolean;
	failure: string | null;
	onConfirm: () => void;
	onClose: () => void;
}) {
	return (
		<Modal
			isOpen
			onClose={onClose}
			title={`Restore version ${version}`}
			width="440px"
		>
			<div className={styles.restoreBody}>
				<p className={styles.restoreLead}>
					Every page goes back to how it stood
					{entry
						? ` when ${personFor(entry.author)} saved it ${when(entry.createdOn)}`
						: ""}
					.
				</p>

				{entry && entry.changes.length > 0 && (
					<ul className={styles.restoreChanges}>
						{entry.changes.slice(0, 4).map((change, i) => (
							<li key={i}>{change.text}</li>
						))}
						{entry.changes.length > 4 && (
							<li className={styles.restoreMore}>
								and {entry.changes.length - 4} more
							</li>
						)}
					</ul>
				)}

				<Hint>
					Nothing is lost. The version you are on now stays in the
					history, the restore is recorded as its own version, and it
					can be undone the same way.
				</Hint>

				{failure && (
					<div className={styles.historyError}>{failure}</div>
				)}

				<div className={styles.protectActions}>
					<button
						type="button"
						className={styles.discardButton}
						onClick={onClose}
						disabled={busy}
					>
						Cancel
					</button>
					<button
						type="button"
						className={styles.saveButton}
						onClick={onConfirm}
						disabled={busy}
					>
						{busy ? "Restoring" : `Restore version ${version}`}
					</button>
				</div>
			</div>
		</Modal>
	);
}

export function HistoryPanel({
	slug,
	reportId,
	sources,
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
	const [comparing, setComparing] = useState<number | null>(null);
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

			{failure && confirming === null && (
				<div className={styles.historyError}>{failure}</div>
			)}

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

						<div className={styles.historyActions}>
							{/* Offered on the current version too. What the
							    last save did is the comparison people reach
							    for most. */}
							<button
								type="button"
								className={styles.toolButton}
								onClick={() => setComparing(entry.version)}
							>
								Compare
							</button>
							{data?.canRestore && !entry.isCurrent && (
								<button
									type="button"
									className={styles.toolButton}
									onClick={() => {
										setFailure(null);
										setConfirming(entry.version);
									}}
								>
									Restore this version
								</button>
							)}
						</div>
					</li>
				))}
			</ol>

			{confirming !== null && (
				<RestoreDialog
					entry={entries.find((e) => e.version === confirming)}
					version={confirming}
					busy={restoring === confirming}
					failure={failure}
					onConfirm={() => restore(confirming)}
					onClose={() => {
						setConfirming(null);
						setFailure(null);
					}}
				/>
			)}

			{comparing !== null && (
				<CompareVersions
					slug={slug}
					reportId={reportId}
					sources={sources}
					version={comparing}
					versions={entries.map((entry) => ({
						version: entry.version,
						author: entry.author,
						createdOn: entry.createdOn,
					}))}
					onClose={() => setComparing(null)}
				/>
			)}
		</div>
	);
}
