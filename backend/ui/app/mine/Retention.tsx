"use client";

import { useState } from "react";
import useSWR, { mutate as refresh } from "swr";
import type { BinItem } from "../../lib/retention/store";
import type { RetentionKind } from "../../lib/retention/rules";
import { ago } from "../admin/when";
import { boardListKey } from "../boards/boardList";
import page from "./MyPages.module.css";
import styles from "./Retention.module.css";

// Retention as an owner sees it: the Keep mark on each of their items, and
// the items removed for going unused, which they can restore for a while
// before they are deleted.

export const retentionKey = "/api/retention";

// The lists each kind appears in, read again once one comes back.
const listKeys: Record<RetentionKind, string> = {
	page: "/api/personal",
	sheet: "/api/sheets",
	board: boardListKey,
	exploreView: "/api/explore/views",
};

// Marks an item Keep, or clears the mark. Answers what went wrong, or null.
export async function markKeep(
	kind: RetentionKind,
	id: string,
	keep: boolean,
): Promise<string | null> {
	try {
		const response = await fetch(retentionKey, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "keep", kind, id, keep }),
		});
		if (response.ok) {
			void refresh(listKeys[kind]);
			return null;
		}
		const body = await response.json().catch(() => null);
		return body?.error ?? "Could not change that.";
	} catch {
		return "Could not change that. Check the connection.";
	}
}

export function KeepIcon({ size = 12 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
			<path d="M9 12l2 2 4-4" />
		</svg>
	);
}

// Shown on an item its owner kept, so it is plain that retention passes it by.
export function KeptBadge() {
	return (
		<span
			className={styles.kept}
			title="Kept. Never removed for going unused."
		>
			<KeepIcon />
			Kept
		</span>
	);
}

const kindWords: Record<RetentionKind, string> = {
	page: "Page",
	sheet: "Sheet",
	board: "Board",
	exploreView: "Saved exploration",
};

const kindIcons: Record<RetentionKind, string> = {
	page: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
	sheet: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18",
	board: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
	exploreView: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
};

function onDay(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	});
}

// Items removed for going unused, newest first, each restorable by its owner
// until it is deleted. Absent when there are none.
export function RecentlyRemoved() {
	const { data, mutate } = useSWR<{ items: BinItem[]; binDays: number }>(
		retentionKey,
	);
	const [busy, setBusy] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const items = data?.items ?? [];
	if (items.length === 0) return null;

	const restore = async (item: BinItem) => {
		setBusy(item.id);
		setFailure(null);
		try {
			const response = await fetch(retentionKey, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "restore",
					kind: item.kind,
					id: item.id,
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setFailure(body?.error ?? `Could not restore ${item.title}.`);
				return;
			}
			await mutate();
			void refresh(listKeys[item.kind]);
		} catch {
			setFailure(
				`Could not restore ${item.title}. Check the connection.`,
			);
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			<div className={page.sectionTitle}>
				Recently removed
				<span className={page.sectionNote}>
					Unused for too long. Restore one to bring it back as it was,
					shares included. Each is deleted {data?.binDays ?? 30} days
					after it was removed.
				</span>
			</div>
			<ul className={styles.removedList}>
				{items.map((item) => (
					<li
						key={`${item.kind}:${item.id}`}
						className={styles.removedItem}
					>
						<span className={styles.removedIcon}>
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.8"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d={kindIcons[item.kind]} />
							</svg>
						</span>
						<span className={styles.removedText}>
							<span className={styles.removedTitle}>
								{item.title}
							</span>
							<span className={styles.removedMeta}>
								{kindWords[item.kind]}, removed{" "}
								{ago(item.removedOn)}, deleted on{" "}
								{onDay(item.purgeOn)}
							</span>
						</span>
						<button
							type="button"
							className={styles.restore}
							disabled={busy !== null}
							onClick={() => void restore(item)}
						>
							{busy === item.id ? "Restoring" : "Restore"}
						</button>
					</li>
				))}
			</ul>
			{failure && (
				<p className={styles.failure} role="alert">
					{failure}
				</p>
			)}
		</>
	);
}
