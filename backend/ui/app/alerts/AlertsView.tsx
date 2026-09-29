"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { AlertEvent, AlertRecord } from "../../lib/alerts/store";
import { describeConditions } from "../../lib/explore/conditions";
import { describeFetchError } from "../../lib/swr";
import { ago, clock } from "../admin/when";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { SkeletonText } from "../components/shared/Skeleton";
import { Toggle } from "../components/shared/Toggle";
import { useNotify } from "../notify/NotifyContext";
import type { SourceMeta } from "../visuals/types";
import { AlertDialog, type AlertPrefill } from "./AlertDialog";
import styles from "./Alerts.module.css";

// The reader's alerts: what each one watches, when it last looked and what it
// saw, and what it has said before.

export const alertsKey = "/api/alerts";

export interface AlertList {
	alerts: AlertRecord[];
	enabled: boolean;
	limit?: number;
}

function lastReading(alert: AlertRecord): string | null {
	const entries = Object.entries(alert.state ?? {});
	if (entries.length === 0) return null;
	if (!alert.definition.groupBy) return null;
	const crossed = entries.filter(([, s]) => s.met).length;
	return `${entries.length} ${alert.definition.groupBy} values followed${
		crossed ? `, ${crossed} past the threshold` : ""
	}`;
}

function History({ id }: { id: string }) {
	const { data } = useSWR<{ events: AlertEvent[] }>(`${alertsKey}/${id}`);
	if (!data) return <SkeletonText lines={2} />;
	if (data.events.length === 0) {
		return <p className={styles.fieldHint}>It has not fired yet.</p>;
	}
	return (
		<ol className={styles.history}>
			{data.events.map((e) => (
				<li key={e.id}>
					<time dateTime={e.firedOn} className={styles.historyTime}>
						{clock(e.firedOn)}
					</time>
					<span className={styles.historyBody}>
						{e.body || e.title}
					</span>
				</li>
			))}
		</ol>
	);
}

export function AlertCard({
	alert,
	onEdit,
	onChanged,
}: {
	alert: AlertRecord;
	onEdit: () => void;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	// A switch or a delete on its way, so a second click does not send another.
	const [changing, setChanging] = useState(false);
	const [showHistory, setShowHistory] = useState(false);

	const checkNow = async () => {
		setBusy(true);
		setMessage(null);
		try {
			const response = await fetch(`${alertsKey}/${alert.id}/check`, {
				method: "POST",
			});
			const body = await response.json();
			if (!response.ok) setMessage(body?.error ?? "Could not check.");
			else if (body.error) setMessage(body.error);
			else
				setMessage(
					body.fired > 0
						? "It fired. The message is in your inbox."
						: "Checked. Nothing to report.",
				);
			onChanged();
		} finally {
			setBusy(false);
		}
	};

	const setEnabled = async (enabled: boolean) => {
		if (changing) return;
		setChanging(true);
		setMessage(null);
		try {
			const response = await fetch(`${alertsKey}/${alert.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setMessage(
					body?.error ??
						(enabled
							? "Could not turn the alert on."
							: "Could not turn the alert off."),
				);
				return;
			}
			onChanged();
		} catch {
			setMessage(
				enabled
					? "Could not turn the alert on."
					: "Could not turn the alert off.",
			);
		} finally {
			setChanging(false);
		}
	};

	const remove = async () => {
		if (changing) return;
		setChanging(true);
		setMessage(null);
		try {
			const response = await fetch(`${alertsKey}/${alert.id}`, {
				method: "DELETE",
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setMessage(body?.error ?? "Could not delete the alert.");
				return;
			}
			onChanged();
		} catch {
			setMessage("Could not delete the alert.");
		} finally {
			// Closed either way. A failure is reported on the card.
			setConfirming(false);
			setChanging(false);
		}
	};

	const filters = describeConditions(alert.definition.conditions);
	const reading = lastReading(alert);

	return (
		<article
			className={`${styles.card} ${alert.enabled ? "" : styles.cardOff}`}
		>
			<header className={styles.cardHead}>
				<div className={styles.cardTitleBlock}>
					<h2 className={styles.cardTitle}>{alert.name}</h2>
					<p className={styles.summary}>{alert.summary}</p>
				</div>
				<Toggle
					checked={alert.enabled}
					onChange={(on) => void setEnabled(on)}
					disabled={changing}
					ariaLabel={
						alert.enabled
							? "Turn this alert off"
							: "Turn this alert on"
					}
				/>
			</header>

			<dl className={styles.facts}>
				<div>
					<dt>Dataset</dt>
					<dd>{alert.sourceTitle ?? alert.definition.sourceKey}</dd>
				</div>
				{filters && (
					<div>
						<dt>Filters</dt>
						<dd>{filters}</dd>
					</div>
				)}
				<div>
					<dt>Checked</dt>
					<dd>
						{alert.scheduleText}
						{!alert.unattended && (
							<span
								className={styles.badge}
								title="This dataset shows different rows to different people. Opening the app records what you can see, and from then on it also runs on schedule. Until then, or where what you can see cannot be recorded, it is checked while you are using the app."
							>
								while you are signed in
							</span>
						)}
					</dd>
				</div>
				<div>
					<dt>Last check</dt>
					<dd>
						{alert.lastCheckedOn ? (
							<>
								<span title={clock(alert.lastCheckedOn)}>
									{ago(alert.lastCheckedOn)}
								</span>
								{alert.lastStatus === "error" && (
									<span className={styles.statusError}>
										{" "}
										failed: {alert.lastError}
									</span>
								)}
								{reading && (
									<span className={styles.fieldHint}>
										{" "}
										· {reading}
									</span>
								)}
							</>
						) : (
							"Not yet"
						)}
					</dd>
				</div>
			</dl>

			<footer className={styles.cardFoot}>
				<span className={styles.cardActions}>
					<button
						type="button"
						className={styles.secondary}
						onClick={checkNow}
						disabled={busy}
					>
						{busy ? "Checking" : "Check now"}
					</button>
					<button
						type="button"
						className={styles.secondary}
						onClick={onEdit}
					>
						Edit
					</button>
					<button
						type="button"
						className={styles.linkButton}
						onClick={() => setShowHistory((v) => !v)}
						aria-expanded={showHistory}
					>
						{showHistory ? "Hide history" : "History"}
					</button>
				</span>
				<button
					type="button"
					className={styles.dangerLink}
					onClick={() => setConfirming(true)}
				>
					Delete
				</button>
			</footer>

			{message && <p className={styles.message}>{message}</p>}
			{showHistory && <History id={alert.id} />}

			{confirming && (
				<ConfirmDialog
					title="Delete this alert?"
					body={`${alert.name} stops checking, and its history goes with it. Messages it already sent stay in your inbox.`}
					confirmLabel="Delete"
					busy={changing}
					onConfirm={remove}
					onCancel={() => setConfirming(false)}
				/>
			)}
		</article>
	);
}

// The alerts view of the inbox: a toolbar with the count and New alert, then
// the alerts themselves, or a short start when there are none.
export function AlertsPanel() {
	const notify = useNotify();
	const { data, error, isLoading, mutate } = useSWR<AlertList>(alertsKey);
	const { data: authoring } = useSWR<{ sources: SourceMeta[] }>(
		"/api/authoring",
	);
	const sources = [...(authoring?.sources ?? [])].sort((a, b) =>
		a.title.localeCompare(b.title),
	);

	const [dialog, setDialog] = useState<{
		editing: AlertRecord | null;
		prefill?: AlertPrefill;
	} | null>(null);

	const changed = () => {
		void mutate();
		notify.refresh();
	};

	if (error) {
		return (
			<div className={styles.state}>
				{describeFetchError(error, "list")}
			</div>
		);
	}

	if (data?.enabled === false) {
		return (
			<div className={styles.state}>
				Alerts are turned off for this app. An administrator can turn
				them on under Administration, Notifications.
			</div>
		);
	}

	const alerts = data?.alerts ?? [];
	const atLimit = data?.limit !== undefined && alerts.length >= data.limit;
	const on = alerts.filter((a) => a.enabled).length;
	const failing = alerts.filter(
		(a) => a.enabled && a.lastStatus === "error",
	).length;

	return (
		<>
			{notify.pushAvailable &&
				notify.pushOn === false &&
				notify.support !== "unsupported" && (
					<div className={styles.banner}>
						<span>
							Alerts reach your inbox. Turn on notifications to
							get them on this device as well.
						</span>
						<Link
							href="/inbox/?view=settings"
							className={styles.bannerLink}
						>
							Set up
						</Link>
					</div>
				)}

			{isLoading && !data ? (
				<SkeletonText lines={4} />
			) : alerts.length === 0 ? (
				<div className={styles.empty}>
					<span className={styles.emptyIcon} aria-hidden="true">
						<svg
							width="22"
							height="22"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
						</svg>
					</span>
					<div className={styles.emptyText}>
						<h2 className={styles.emptyTitle}>No alerts yet</h2>
						<p className={styles.fieldHint}>
							Pick a measure and a threshold here, or build the
							numbers in Explore first and choose Alert from
							there.
						</p>
					</div>
					<div className={styles.emptyActions}>
						<button
							type="button"
							className={styles.primary}
							onClick={() => setDialog({ editing: null })}
						>
							New alert
						</button>
						<Link href="/explore/" className={styles.secondary}>
							Open Explore
						</Link>
					</div>
				</div>
			) : (
				<>
					<div className={styles.toolbar}>
						<span className={styles.toolbarText}>
							{on === alerts.length
								? `${alerts.length} ${alerts.length === 1 ? "alert" : "alerts"}`
								: `${on} of ${alerts.length} on`}
							{failing > 0 && (
								<span className={styles.statusError}>
									{" "}
									· {failing} could not run
								</span>
							)}
						</span>
						<button
							type="button"
							className={styles.primary}
							onClick={() => setDialog({ editing: null })}
							disabled={atLimit}
							title={
								atLimit
									? `You have ${data?.limit} alerts, the most one person can keep.`
									: undefined
							}
						>
							New alert
						</button>
					</div>
					<div className={styles.list}>
						{alerts.map((alert) => (
							<AlertCard
								key={alert.id}
								alert={alert}
								onEdit={() => setDialog({ editing: alert })}
								onChanged={changed}
							/>
						))}
					</div>
				</>
			)}

			{dialog && (
				<AlertDialog
					sources={sources}
					editing={dialog.editing}
					prefill={dialog.prefill}
					onClose={() => setDialog(null)}
					onSaved={() => {
						setDialog(null);
						changed();
					}}
				/>
			)}
		</>
	);
}
