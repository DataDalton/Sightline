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
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { useNotify } from "../notify/NotifyContext";
import type { SourceMeta } from "../visuals/types";
import { AlertDialog, type AlertPrefill } from "./AlertDialog";
import {
	send,
	subscriptionsKey,
	type PageAlertRecord,
	type PromoteTarget,
} from "./pageAlertClient";
import { runsNote, SubscriptionControls } from "./PageAlerts";
import styles from "./Alerts.module.css";

// The reader's alerts: what each one watches, when it last looked and what it
// saw, and what it has said before. Below them, the alerts on report pages
// they follow, which the pages' editors look after.

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
	targets,
}: {
	alert: AlertRecord;
	onEdit: () => void;
	onChanged: () => void;
	// Pages the owner may edit that show this alert's dataset, where it could
	// become a page alert for everyone who reads them.
	targets?: PromoteTarget[];
}) {
	const [promoting, setPromoting] = useState(false);
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
					{targets && targets.length > 0 && (
						<button
							type="button"
							className={styles.linkButton}
							onClick={() => setPromoting(true)}
							title="Put this alert on a report page for its readers to follow"
						>
							Promote to page alert
						</button>
					)}
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

			{promoting && targets && (
				<PromoteDialog
					alert={alert}
					targets={targets}
					onClose={() => setPromoting(false)}
					onDone={() => {
						setPromoting(false);
						onChanged();
					}}
				/>
			)}

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

// Turning a personal alert into one on a page the owner edits. The page alert
// takes the same rule and schedule, the owner follows it, and the personal
// alert goes, so they hear about it once.
function PromoteDialog({
	alert,
	targets,
	onClose,
	onDone,
}: {
	alert: AlertRecord;
	targets: PromoteTarget[];
	onClose: () => void;
	onDone: () => void;
}) {
	const [pageId, setPageId] = useState(targets[0]?.pageId ?? "");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const promote = async () => {
		setBusy(true);
		setFailure(null);
		const sent = await send<{ alert?: PageAlertRecord }>(
			"/api/page-alerts/promote/",
			"POST",
			{ alertId: alert.id, pageId },
		);
		setBusy(false);
		if (!sent.ok) {
			setFailure(sent.body.error ?? "Could not make it a page alert.");
			return;
		}
		onDone();
	};

	return (
		<Modal
			isOpen
			onClose={onClose}
			title="Promote to page alert"
			width="520px"
			footer={
				<>
					{failure && (
						<span className={styles.formError} role="alert">
							{failure}
						</span>
					)}
					<button
						type="button"
						className={styles.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={styles.primary}
						onClick={() => void promote()}
						disabled={busy || !pageId}
					>
						{busy ? "Promoting" : "Promote"}
					</button>
				</>
			}
		>
			<div className={styles.form}>
				<p className={styles.fieldHint}>
					{alert.name} becomes an alert on the page you choose, which
					anyone reading it can follow. You follow it in its place,
					and this personal alert is deleted.
				</p>
				<Select
					options={targets.map((t) => ({
						value: t.pageId,
						label: t.pageTitle,
						group: t.reportTitle,
					}))}
					value={pageId}
					onChange={setPageId}
					searchable={targets.length > 12}
					ariaLabel="Page"
				/>
			</div>
		</Modal>
	);
}

// One page alert the reader follows, labelled with the page it comes from.
function SubscriptionCard({
	alert,
	onChanged,
	onCopy,
}: {
	alert: PageAlertRecord;
	onChanged: () => void;
	onCopy: () => void;
}) {
	const filters = describeConditions(alert.definition.conditions);
	const note = runsNote(alert);
	return (
		<article
			className={`${styles.card} ${alert.muted ? styles.cardOff : ""}`}
		>
			<header className={styles.cardHead}>
				<div className={styles.cardTitleBlock}>
					<span className={styles.fromPage}>
						From {alert.reportTitle}, {alert.pageTitle} page
					</span>
					<h2 className={styles.cardTitle}>{alert.name}</h2>
					<p className={styles.summary}>{alert.summary}</p>
				</div>
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
						{note && (
							<span className={styles.fieldHint}> {note}</span>
						)}
					</dd>
				</div>
			</dl>
			<footer className={styles.cardFoot}>
				<SubscriptionControls
					alert={alert}
					onChanged={onChanged}
					onCopy={onCopy}
				/>
				<Link href={alert.link} className={styles.linkButton}>
					Open the page
				</Link>
			</footer>
		</article>
	);
}

// The alerts view of the inbox: a toolbar with the count and New alert, then
// the alerts themselves, or a short start when there are none.
export function AlertsPanel() {
	const notify = useNotify();
	const { data, error, isLoading, mutate } = useSWR<AlertList>(alertsKey);
	const { data: followed, mutate: refollow } = useSWR<{
		subscriptions: PageAlertRecord[];
	}>(data?.enabled ? subscriptionsKey : null);
	const [copying, setCopying] = useState<PageAlertRecord | null>(null);
	// Where each dataset of the reader's alerts could become a page alert.
	const alertSources = [
		...new Set((data?.alerts ?? []).map((a) => a.definition.sourceKey)),
	]
		.sort()
		.join(",");
	const { data: promotable } = useSWR<{
		targets: Record<string, PromoteTarget[]>;
	}>(
		data?.enabled && alertSources
			? `/api/page-alerts/promote/?sources=${encodeURIComponent(alertSources)}`
			: null,
	);
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
		void refollow();
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
								targets={
									promotable?.targets[
										alert.definition.sourceKey
									]
								}
							/>
						))}
					</div>
				</>
			)}

			{(followed?.subscriptions.length ?? 0) > 0 && (
				<>
					<h2 className={styles.sectionTitle}>
						Page alerts you follow
					</h2>
					<div className={styles.list}>
						{followed?.subscriptions.map((alert) => (
							<SubscriptionCard
								key={alert.id}
								alert={alert}
								onChanged={() => void refollow()}
								onCopy={() => setCopying(alert)}
							/>
						))}
					</div>
				</>
			)}

			{copying && (
				<AlertDialog
					sources={sources}
					copyOf={copying}
					onClose={() => setCopying(null)}
					onSaved={() => {
						setCopying(null);
						changed();
					}}
				/>
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
					onSubscribed={() => {
						setDialog(null);
						changed();
					}}
				/>
			)}
		</>
	);
}
