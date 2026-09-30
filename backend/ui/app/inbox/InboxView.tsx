"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import type { InboxItem } from "../../lib/notify/store";
import { describeFetchError } from "../../lib/swr";
import { AlertsPanel, alertsKey, type AlertList } from "../alerts/AlertsView";
import { ScheduledPages } from "../deliveries/ScheduledPages";
import { usePageTitle } from "../hooks/usePageTitle";
import { InboxList } from "../notify/InboxList";
import { useNotify } from "../notify/NotifyContext";
import { NotificationSettings } from "./NotificationSettings";
import { Conversations, conversationsKey } from "../messages/Conversations";
import styles from "./Inbox.module.css";

// One place for everything the reader is told and everything they asked to be
// told about, laid out the way a mail program is: the views down the side,
// the one chosen beside them.
//
//   Messages   everything, what is unread, what alerts sent, what was shared,
//              and conversations with the people who maintain categories
//   Alerts     what they are watching, and a way to watch something else
//   Settings   which of it also reaches their phone or computer
//
// The view is kept in the address, so a link can open any of them and the
// back button moves between them.

export type InboxViewId =
	| "all"
	| "unread"
	| "alert"
	| "share"
	| "conversations"
	| "alerts"
	| "scheduled"
	| "settings";

const views: InboxViewId[] = [
	"all",
	"unread",
	"alert",
	"share",
	"conversations",
	"alerts",
	"scheduled",
	"settings",
];

const pageSize = 50;

const heading: Record<InboxViewId, { title: string; blurb: string }> = {
	all: {
		title: "Inbox",
		blurb: "Everything you have been told, newest first.",
	},
	unread: { title: "Unread", blurb: "What you have not opened yet." },
	alert: {
		title: "From alerts",
		blurb: "What your alerts found when they checked.",
	},
	share: {
		title: "Shared with you",
		blurb: "Pages and sheets other people have given you.",
	},
	conversations: {
		title: "Conversations",
		blurb: "Questions asked of the people who maintain a category, and their answers. Both sides reply here.",
	},
	alerts: {
		title: "Alerts",
		blurb: "Measures you are watching. Each one checks on its schedule and writes here when something crosses a line or moves.",
	},
	scheduled: {
		title: "Scheduled pages",
		blurb: "Report pages sent to you on a schedule, with their headline figures worked out under your own access.",
	},
	settings: {
		title: "Notification settings",
		blurb: "Which of this also reaches your phone and computer, and the devices that receive it.",
	},
};

const emptyText: Record<"all" | "unread" | "alert" | "share", string> = {
	all: "Nothing here yet. Alerts you set and pages shared with you arrive here.",
	unread: "You are all caught up.",
	alert: "None of your alerts has found anything yet.",
	share: "Nobody has shared anything with you yet.",
};

function keyFor(view: InboxViewId): string | null {
	if (
		view === "alerts" ||
		view === "scheduled" ||
		view === "settings" ||
		view === "conversations"
	) {
		return null;
	}
	const params = new URLSearchParams({ limit: String(pageSize) });
	if (view === "unread") params.set("unread", "1");
	if (view === "alert" || view === "share") params.set("kind", view);
	return `/api/notifications?${params}`;
}

// Read from the address. The older ?tab= spelling is still understood, so a
// link from before the views were joined still lands in the right place.
function viewFrom(params: URLSearchParams | null): InboxViewId | null {
	const asked = params?.get("view") ?? params?.get("tab");
	return views.includes(asked as InboxViewId) ? (asked as InboxViewId) : null;
}

function Icon({ d }: { d: string }) {
	return (
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
			<path d={d} />
		</svg>
	);
}

const icons = {
	all: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
	unread: "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
	alert: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0",
	share: "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13",
	conversations:
		"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
	alerts: "M3 3v18h18M7 14l4-4 3 3 5-6",
	scheduled: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
	settings:
		"M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
};

export default function InboxView({
	initial = "all",
}: {
	initial?: InboxViewId;
}) {
	const search = useSearchParams();
	const { unread, alertsEnabled, refresh } = useNotify();

	const [view, setView] = useState<InboxViewId>(initial);
	// The conversation open in the conversations view, kept in the address
	// beside the view so a notification can link straight to it.
	const [threadId, setThreadId] = useState<string | null>(null);
	useEffect(() => {
		const asked = viewFrom(search);
		if (asked) setView(asked);
		setThreadId(search?.get("thread") ?? null);
	}, [search]);

	usePageTitle(heading[view].title);

	// On a phone the views are a row that scrolls sideways, and the chosen
	// one can start out of sight, so it is brought into view.
	const railRef = useRef<HTMLElement>(null);
	useEffect(() => {
		railRef.current
			?.querySelector('[aria-current="page"]')
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [view]);

	const choose = (next: InboxViewId) => {
		setView(next);
		setThreadId(null);
		const url = new URL(window.location.href);
		url.pathname = "/inbox/";
		url.searchParams.delete("tab");
		url.searchParams.delete("thread");
		if (next === "all") url.searchParams.delete("view");
		else url.searchParams.set("view", next);
		window.history.pushState(null, "", url.toString());
	};

	const openThread = (id: string | null) => {
		setThreadId(id);
		const url = new URL(window.location.href);
		url.pathname = "/inbox/";
		url.searchParams.set("view", "conversations");
		if (id) url.searchParams.set("thread", id);
		else url.searchParams.delete("thread");
		window.history.pushState(null, "", url.toString());
	};

	// The browser's back button moves between views.
	useEffect(() => {
		const onPop = () => {
			const params = new URLSearchParams(window.location.search);
			setThreadId(params.get("thread"));
			setView(
				viewFrom(params) ??
					(window.location.pathname.startsWith("/alerts")
						? "alerts"
						: "all"),
			);
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	const { data: alertList } = useSWR<AlertList>(
		alertsEnabled ? alertsKey : null,
	);
	const alertCount = alertList?.alerts.length ?? 0;

	const { data: conversationList } = useSWR<{ unread: number }>(
		conversationsKey,
	);
	const failing =
		alertList?.alerts.filter((a) => a.enabled && a.lastStatus === "error")
			.length ?? 0;

	const key = keyFor(view);
	const { data, error, isLoading, mutate } = useSWR<{
		items: InboxItem[];
		unread: number;
	}>(key, {
		// Each view is a different list, so one view's entries are not shown
		// under another's heading while it loads.
		keepPreviousData: false,
	});

	// Older entries, fetched a page at a time below the first.
	const [older, setOlder] = useState<InboxItem[]>([]);
	const [exhausted, setExhausted] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [moreFailed, setMoreFailed] = useState(false);
	// The view a page of older entries belongs to. A page that lands after the
	// view changed is dropped rather than appended to the wrong list.
	const keyRef = useRef(key);
	keyRef.current = key;
	useEffect(() => {
		setOlder([]);
		setExhausted(false);
		setMoreFailed(false);
	}, [key]);

	const items = data ? [...data.items, ...older] : undefined;

	const loadMore = async () => {
		const last = items?.[items.length - 1];
		if (!key || !last) return;
		const requested = key;
		setLoadingMore(true);
		setMoreFailed(false);
		try {
			const response = await fetch(
				`${key}&before=${encodeURIComponent(last.createdOn)}`,
			);
			if (!response.ok) throw new Error("Older entries did not load");
			const next = (await response.json()) as { items?: InboxItem[] };
			if (!Array.isArray(next.items)) {
				throw new Error("Older entries did not load");
			}
			if (keyRef.current !== requested) return;
			const page = next.items;
			setOlder((o) => [...o, ...page]);
			if (page.length < pageSize) setExhausted(true);
		} catch {
			if (keyRef.current === requested) setMoreFailed(true);
		} finally {
			setLoadingMore(false);
		}
	};

	const changed = () => {
		setOlder([]);
		setExhausted(false);
		setMoreFailed(false);
		void mutate();
		refresh();
	};

	const act = async (method: "PATCH" | "DELETE", body: unknown) => {
		try {
			await fetch("/api/notifications", {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch {
			// The reload below shows the list as the server holds it.
		}
		changed();
	};

	const item = (
		id: InboxViewId,
		label: string,
		count?: number,
		tone?: "brand" | "warn",
	) => (
		<button
			key={id}
			type="button"
			className={`${styles.railItem} ${view === id ? styles.railOn : ""}`}
			aria-current={view === id ? "page" : undefined}
			onClick={() => choose(id)}
		>
			<Icon d={icons[id]} />
			<span className={styles.railLabel}>{label}</span>
			{count !== undefined && count > 0 && (
				<span
					className={`${styles.railCount} ${
						tone === "brand"
							? styles.railCountBrand
							: tone === "warn"
								? styles.railCountWarn
								: ""
					}`}
				>
					{count > 99 ? "99+" : count}
				</span>
			)}
		</button>
	);

	const messageView =
		view === "all" ||
		view === "unread" ||
		view === "alert" ||
		view === "share";

	return (
		<div className={styles.hub}>
			<nav className={styles.rail} aria-label="Inbox" ref={railRef}>
				<div className={styles.railGroup}>
					<span className={styles.railHeading}>Messages</span>
					{item("all", "All")}
					{item("unread", "Unread", unread, "brand")}
					{alertsEnabled && item("alert", "From alerts")}
					{item("share", "Shared with you")}
					{item(
						"conversations",
						"Conversations",
						conversationList?.unread,
						"brand",
					)}
				</div>
				{alertsEnabled && (
					<div className={styles.railGroup}>
						<span className={styles.railHeading}>Alerts</span>
						{item(
							"alerts",
							"Your alerts",
							failing > 0 ? failing : alertCount,
							failing > 0 ? "warn" : undefined,
						)}
						{item("scheduled", "Scheduled pages")}
					</div>
				)}
				<div className={styles.railGroup}>
					<span className={styles.railHeading}>Settings</span>
					{item("settings", "Notifications")}
				</div>
			</nav>

			<div className={styles.main}>
				<header className={styles.header}>
					<div>
						<h1 className={styles.title}>{heading[view].title}</h1>
						<p className={styles.subtitle}>{heading[view].blurb}</p>
					</div>
					{messageView && (items?.length ?? 0) > 0 && (
						<span className={styles.bulk}>
							{unread > 0 && (
								<button
									type="button"
									className={styles.bulkButton}
									onClick={() =>
										act("PATCH", { ids: "all", read: true })
									}
								>
									Mark all read
								</button>
							)}
							<button
								type="button"
								className={styles.bulkButton}
								onClick={() => act("DELETE", { ids: "read" })}
							>
								Clear read
							</button>
						</span>
					)}
				</header>

				{view === "conversations" ? (
					<Conversations threadId={threadId} onOpen={openThread} />
				) : view === "alerts" ? (
					<AlertsPanel />
				) : view === "scheduled" ? (
					<ScheduledPages />
				) : view === "settings" ? (
					<NotificationSettings />
				) : error ? (
					<div className={styles.state}>
						{describeFetchError(error, "inbox")}
					</div>
				) : (
					<div className={styles.listFrame}>
						<InboxList
							items={items}
							loading={isLoading}
							onChanged={changed}
							emptyText={emptyText[view]}
						/>
						{items && items.length >= pageSize && !exhausted && (
							<button
								type="button"
								className={styles.more}
								onClick={loadMore}
								disabled={loadingMore}
							>
								{loadingMore
									? "Loading"
									: moreFailed
										? "Could not load older entries. Try again"
										: "Show older"}
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
