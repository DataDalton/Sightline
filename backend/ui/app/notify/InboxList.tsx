"use client";

import { useRouter } from "next/navigation";
import type { InboxItem } from "../../lib/notify/store";
import { ago, clock } from "../admin/when";
import { Skeleton } from "../components/shared/Skeleton";
import { BellIcon, KindIcon } from "./icons";
import styles from "./Notify.module.css";

// Inbox entries, newest first. The same list in the header panel and on the
// inbox page. The page adds the controls for each entry.

async function patch(ids: string[], read: boolean) {
	await fetch("/api/notifications", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ids, read }),
	});
}

async function remove(ids: string[]) {
	await fetch("/api/notifications", {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ids }),
	});
}

export function InboxList({
	items,
	loading,
	compact = false,
	onChanged,
	emptyText = "Nothing here yet. Alerts you set and pages shared with you arrive here.",
}: {
	items: InboxItem[] | undefined;
	loading: boolean;
	compact?: boolean;
	onChanged: () => void;
	emptyText?: string;
}) {
	const router = useRouter();

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
		<ul className={`${styles.list} ${compact ? styles.listCompact : ""}`}>
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
								<span
									className={`${styles.itemBody} ${compact ? styles.itemBodyClamp : ""}`}
								>
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

					{!compact && (
						<span className={styles.itemActions}>
							<button
								type="button"
								className={styles.itemAction}
								onClick={async () => {
									await patch([item.id], !item.readOn);
									onChanged();
								}}
								title={
									item.readOn ? "Mark unread" : "Mark read"
								}
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
					)}
				</li>
			))}
		</ul>
	);
}
