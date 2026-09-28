"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import type { InboxItem } from "../../lib/notify/store";
import { BellIcon } from "./icons";
import { InboxList } from "./InboxList";
import { useNotify } from "./NotifyContext";
import styles from "./Notify.module.css";

// The bell in the header, with the unread count on it and the newest entries
// a click away. A phone reaches the inbox from its tab bar instead, so the
// bell is for wider screens.

const panelKey = "/api/notifications?limit=12";

export function CountBadge({ count }: { count: number }) {
	if (count <= 0) return null;
	return (
		<span className={styles.countBadge} aria-hidden="true">
			{count > 99 ? "99+" : count}
		</span>
	);
}

export function InboxBell() {
	const { unread, refresh } = useNotify();
	const [open, setOpen] = useState(false);
	const pathname = usePathname();
	const box = useRef<HTMLDivElement>(null);

	const { data, isLoading } = useSWR<{ items: InboxItem[] }>(
		open ? panelKey : null,
	);

	useEffect(() => setOpen(false), [pathname]);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!box.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const markAll = async () => {
		await fetch("/api/notifications", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids: "all", read: true }),
		});
		refresh();
	};

	const label =
		unread > 0 ? `Inbox, ${unread} unread` : "Inbox, nothing unread";

	return (
		<div className={styles.bellWrap} ref={box}>
			<button
				type="button"
				className={`${styles.bell} ${open ? styles.bellOpen : ""}`}
				onClick={() => setOpen((v) => !v)}
				aria-label={label}
				aria-expanded={open}
				title="Inbox"
			>
				<BellIcon />
				<CountBadge count={unread} />
			</button>

			{open && (
				<div className={styles.panel} role="dialog" aria-label="Inbox">
					<header className={styles.panelHead}>
						<span className={styles.panelTitle}>Inbox</span>
						<span className={styles.panelActions}>
							{unread > 0 && (
								<button
									type="button"
									className={styles.linkButton}
									onClick={markAll}
								>
									Mark all read
								</button>
							)}
							<Link
								href="/inbox/?view=settings"
								className={styles.iconLink}
								aria-label="Notification settings"
								title="Notification settings"
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
									<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
								</svg>
							</Link>
						</span>
					</header>
					<div className={styles.panelBody}>
						<InboxList
							items={data?.items}
							loading={isLoading}
							compact
							onChanged={refresh}
						/>
					</div>
					<footer className={styles.panelFoot}>
						<Link href="/inbox/" className={styles.panelLink}>
							Open inbox
						</Link>
						<Link
							href="/inbox/?view=alerts"
							className={styles.panelLink}
						>
							Alerts
						</Link>
					</footer>
				</div>
			)}
		</div>
	);
}
