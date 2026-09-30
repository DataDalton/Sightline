"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import useSWR from "swr";
import {
	describeMute,
	muteChoices,
	muteLabel,
	mutedForever,
	type MuteChoice,
} from "../../lib/alerts/mute";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { useNotify } from "../notify/NotifyContext";
import type { SourceMeta } from "../visuals/types";
import {
	changeSubscription,
	pageAlertsKey,
	send,
	type PageAlertList,
	type PageAlertRecord,
} from "./pageAlertClient";
import styles from "./PageAlerts.module.css";

// Page alerts as a reader meets them, with a bell in the page header listing the
// alerts the page's editors set up, and the controls to follow each one, mute
// it for a while, or take a copy to change. The rule and its schedule belong
// to the editors. A reader only decides whether they hear about it.

// Loaded when a copy is asked for, since few readers ever do.
const AlertDialog = dynamic(
	() => import("./AlertDialog").then((m) => m.AlertDialog),
	{ ssr: false },
);

export function BellIcon({ size = 13 }: { size?: number }) {
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
			<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
		</svg>
	);
}

// What a subscriber's mute amounts to, as the value the menu shows.
function muteValue(alert: PageAlertRecord): MuteChoice | "until" {
	if (!alert.muted) return "off";
	return alert.mutedUntil === mutedForever ? "forever" : "until";
}

// How the dataset behind an alert is read, when that affects who hears from
// it. Worded for a follower, or for the editor who looks after the alert.
export function runsNote(
	alert: PageAlertRecord,
	forEditor = false,
): string | null {
	if (alert.runs === "perAccess") {
		return forEditor
			? "Checked against the rows each follower can see, once they have opened the app since following it."
			: "Checked against the rows you can see, from the next time you open the app.";
	}
	if (alert.runs === "signedIn") {
		return forEditor
			? "This dataset shows each person different rows, so it is checked for each follower while they are using the app, against the rows they can see."
			: "Checked while you are using the app, against the rows you can see, and not while you are away.";
	}
	return null;
}

// Following, muting and copying one page alert. Used in the page's list and
// in the inbox.
export function SubscriptionControls({
	alert,
	onChanged,
	onCopy,
}: {
	alert: PageAlertRecord;
	onChanged: (alert: PageAlertRecord) => void;
	onCopy: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const change = async (next: {
		subscribed?: boolean;
		mute?: MuteChoice;
	}) => {
		if (busy) return;
		setBusy(true);
		setFailure(null);
		const sent = await changeSubscription(alert.id, next);
		setBusy(false);
		if (!sent.ok) {
			setFailure(sent.body.error ?? "That did not save. Try again.");
			return;
		}
		// Leaving returns the alert as the caller now sees it, which is not
		// followed.
		onChanged(
			sent.body.alert ?? {
				...alert,
				subscribed: false,
				muted: false,
				mutedUntil: null,
			},
		);
	};

	const current = muteValue(alert);
	const until = describeMute(alert.mutedUntil);
	const options = [
		...(current === "until"
			? [{ value: "until", label: `Muted until ${until ?? "later"}` }]
			: []),
		...muteChoices.map((choice) => ({
			value: choice,
			label: muteLabel[choice],
		})),
	];

	return (
		<>
			<div className={styles.controls}>
				<Toggle
					checked={alert.subscribed}
					onChange={(on) => void change({ subscribed: on })}
					disabled={busy}
					label={alert.subscribed ? "Subscribed" : "Subscribe"}
				/>
				{alert.subscribed && (
					<Select
						className={styles.mute}
						options={options}
						value={current}
						onChange={(v) => {
							if (v !== "until")
								void change({ mute: v as MuteChoice });
						}}
						disabled={busy}
						ariaLabel={`Mute ${alert.name}`}
					/>
				)}
				<button
					type="button"
					className={styles.linkButton}
					onClick={onCopy}
					title="A personal alert of your own, starting from this one, that you can change"
				>
					Make my own copy
				</button>
			</div>
			{failure && (
				<span className={styles.error} role="alert">
					{failure}
				</span>
			)}
		</>
	);
}

export function PageAlertItem({
	alert,
	onChanged,
	onCopy,
	children,
}: {
	alert: PageAlertRecord;
	onChanged: (alert: PageAlertRecord) => void;
	onCopy: () => void;
	children?: React.ReactNode;
}) {
	const note = runsNote(alert);
	return (
		<li className={styles.item}>
			<div className={styles.itemText}>
				<span className={styles.name}>{alert.name}</span>
				<span className={styles.rule}>{alert.summary}</span>
				<span className={styles.meta}>
					{alert.scheduleText}
					{alert.sourceTitle ? `, in ${alert.sourceTitle}` : ""}
				</span>
				{note && <span className={styles.hint}>{note}</span>}
			</div>
			{children}
			<SubscriptionControls
				alert={alert}
				onChanged={onChanged}
				onCopy={onCopy}
			/>
		</li>
	);
}

// The bell in a report page's header, with how many alerts the page has.
// Nothing is drawn for a page without any, or while alerts are turned off.
export function PageAlertsButton({
	pageId,
	pageTitle,
	sources,
	className,
}: {
	pageId: string;
	pageTitle: string;
	sources: SourceMeta[];
	className: string;
}) {
	const { alertsEnabled } = useNotify();
	const [open, setOpen] = useState(false);
	const { data, mutate } = useSWR<PageAlertList>(
		alertsEnabled ? pageAlertsKey(pageId) : null,
		// The button stays mounted from one page to the next, so another
		// page's alerts are not shown or written back under this page's key.
		{ keepPreviousData: false },
	);
	const count = data?.alerts.length ?? 0;
	if (!alertsEnabled || count === 0) return null;
	const following = data?.alerts.filter((a) => a.subscribed).length ?? 0;

	return (
		<>
			<button
				type="button"
				className={className}
				onClick={() => setOpen(true)}
				aria-haspopup="dialog"
				title={
					following > 0
						? `You follow ${following} of this page's alerts`
						: "Alerts on this page you can follow"
				}
			>
				<BellIcon />
				Alerts
				<span
					className={styles.count}
					aria-label={`${count} ${count === 1 ? "alert" : "alerts"}`}
				>
					{count}
				</span>
			</button>
			{open && data && (
				<PageAlertsDialog
					pageId={pageId}
					pageTitle={pageTitle}
					list={data}
					sources={sources}
					onChange={(update) =>
						void mutate(
							(current) => (current ? update(current) : current),
							{ revalidate: false },
						)
					}
					onRefresh={() => void mutate()}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

function PageAlertsDialog({
	pageId,
	pageTitle,
	list,
	sources,
	onChange,
	onRefresh,
	onClose,
}: {
	pageId: string;
	pageTitle: string;
	list: PageAlertList;
	sources: SourceMeta[];
	// Applied to the list as it stands when a change lands, so two changes
	// finishing close together both keep their result.
	onChange: (update: (list: PageAlertList) => PageAlertList) => void;
	// Reads the list again, after a copy that may have left an alert.
	onRefresh: () => void;
	onClose: () => void;
}) {
	const notify = useNotify();
	const [copying, setCopying] = useState<PageAlertRecord | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const missing = list.alerts.filter((a) => !a.subscribed).length;

	const replace = (alert: PageAlertRecord) =>
		onChange((current) => ({
			...current,
			alerts: current.alerts.map((a) => (a.id === alert.id ? alert : a)),
		}));

	const subscribeAll = async () => {
		setBusy(true);
		setFailure(null);
		const sent = await send<PageAlertList>(
			"/api/page-alerts/subscribe-all/",
			"POST",
			{ pageId },
		);
		setBusy(false);
		if (!sent.ok || !Array.isArray(sent.body.alerts)) {
			setFailure(sent.body.error ?? "That did not save. Try again.");
			return;
		}
		const next = sent.body;
		onChange(() => next);
	};

	return (
		<>
			<Modal
				isOpen={copying === null}
				onClose={onClose}
				title={`Alerts on ${pageTitle}`}
				width="560px"
				footer={
					<>
						{failure && (
							<span className={styles.error} role="alert">
								{failure}
							</span>
						)}
						<button
							type="button"
							className={styles.secondary}
							onClick={onClose}
						>
							Close
						</button>
						<button
							type="button"
							className={styles.primary}
							onClick={() => void subscribeAll()}
							disabled={busy || missing === 0}
						>
							{missing === 0
								? "Following all"
								: busy
									? "Subscribing"
									: "Subscribe to all"}
						</button>
					</>
				}
			>
				<p className={styles.hint}>
					Set up by the people who look after this report. Follow the
					ones you want in your inbox, each worked out from the rows
					you can see.
					{copied && " Your copy is under Inbox, Alerts."}
				</p>
				<ul className={styles.list}>
					{list.alerts.map((alert) => (
						<PageAlertItem
							key={alert.id}
							alert={alert}
							onChanged={replace}
							onCopy={() => setCopying(alert)}
						/>
					))}
				</ul>
			</Modal>
			{copying && (
				<AlertDialog
					sources={sources}
					copyOf={copying}
					onClose={() => setCopying(null)}
					onSaved={() => {
						setCopying(null);
						setCopied(true);
						onRefresh();
						notify.refresh();
					}}
				/>
			)}
		</>
	);
}
