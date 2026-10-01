"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { InboxItem } from "../../lib/notify/store";
import { isRetentionKind } from "../../lib/retention/rules";
import { KeepIcon, markKeep } from "../mine/Retention";
import { ago, clock } from "../admin/when";
import { Skeleton } from "../components/shared/Skeleton";
import { BellIcon, KindIcon } from "./icons";
import styles from "./Notify.module.css";

// Inbox entries, newest first. The same list in the header panel and on the
// inbox page. The page adds the controls for each entry.

// Neither call throws. A failed change is followed by the same reload as a
// successful one, which shows the list as the server holds it, and opening an
// entry still follows its link.
async function send(method: "PATCH" | "DELETE", body: unknown) {
	try {
		await fetch("/api/notifications", {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		// Reported by the reload that follows.
	}
}

const patch = (ids: string[], read: boolean) => send("PATCH", { ids, read });

const remove = (ids: string[]) => send("DELETE", { ids });

// The item a retention warning is about, when the entry is one.
function retentionTarget(
	item: InboxItem,
): { kind: Parameters<typeof markKeep>[0]; id: string } | null {
	const target = item.data?.retention as
		| { kind?: unknown; id?: unknown }
		| undefined;
	return target &&
		isRetentionKind(target.kind) &&
		typeof target.id === "string"
		? { kind: target.kind, id: target.id }
		: null;
}

export function InboxList({
	items,
	loading,
	onChanged,
	emptyText = "Nothing here yet. Alerts you set and pages shared with you arrive here.",
}: {
	items: InboxItem[] | undefined;
	loading: boolean;
	onChanged: () => void;
	emptyText?: string;
}) {
	const router = useRouter();
	// Warnings whose item was marked Keep from here, so the button says so.
	const [kept, setKept] = useState<Set<string>>(new Set());

	if (loading && !items) {
		return (
			<div className={styles.listLoading}>
				<Skeleton height={52} />
				<Skeleton height={52} />
				<Skeleton height={52} />
			</div>
		);
	}

	if (!items || items.length === 0) {
		return (
			<div className={styles.empty}>
				<span className={styles.emptyIcon}>
					<BellIcon size={20} />
				</span>
				<p>{emptyText}</p>
			</div>
		);
	}

	const open = async (item: InboxItem) => {
		if (!item.readOn) {
			await patch([item.id], true);
			onChanged();
		}
		if (item.link) router.push(item.link);
	};

	return (
		<ul className={styles.list}>
			{items.map((item) => (
				<li
					key={item.id}
					className={`${styles.item} ${item.readOn ? "" : styles.itemUnread}`}
				>
					<button
						type="button"
						className={styles.itemMain}
						onClick={() => void open(item)}
					>
						<span
							className={`${styles.itemIcon} ${styles[`kind_${item.kind}`] ?? ""}`}
						>
							<KindIcon kind={item.kind} />
						</span>
						<span className={styles.itemText}>
							<span className={styles.itemTitle}>
								{item.title}
							</span>
							{item.body && (
								<span className={styles.itemBody}>
									{item.body}
								</span>
							)}
							<time
								className={styles.itemTime}
								dateTime={item.createdOn}
								title={clock(item.createdOn)}
							>
								{ago(item.createdOn)}
							</time>
						</span>
						{!item.readOn && (
							<span
								className={styles.unreadDot}
								aria-label="Unread"
							/>
						)}
					</button>

					<span className={styles.itemActions}>
						{(() => {
							const target = retentionTarget(item);
							if (!target) return null;
							const done = kept.has(item.id);
							return (
								<button
									type="button"
									className={styles.itemAction}
									disabled={done}
									onClick={async () => {
										const failed = await markKeep(
											target.kind,
											target.id,
											true,
										);
										if (!failed) {
											setKept((s) =>
												new Set(s).add(item.id),
											);
										}
										if (!item.readOn) {
											await patch([item.id], true);
										}
										onChanged();
									}}
									title={
										done
											? "Kept. It will not be removed."
											: "Keep it, so it is never removed for going unused"
									}
									aria-label={done ? "Kept" : "Keep"}
								>
									<KeepIcon size={16} />
								</button>
							);
						})()}
						<button
							type="button"
							className={styles.itemAction}
							onClick={async () => {
								await patch([item.id], !item.readOn);
								onChanged();
							}}
							title={item.readOn ? "Mark unread" : "Mark read"}
							aria-label={
								item.readOn ? "Mark unread" : "Mark read"
							}
						>
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								{item.readOn ? (
									<circle cx="12" cy="12" r="5" />
								) : (
									<path d="M20 6L9 17l-5-5" />
								)}
							</svg>
						</button>
						<button
							type="button"
							className={styles.itemAction}
							onClick={async () => {
								await remove([item.id]);
								onChanged();
							}}
							title="Delete"
							aria-label="Delete"
						>
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
							</svg>
						</button>
					</span>
				</li>
			))}
		</ul>
	);
}
