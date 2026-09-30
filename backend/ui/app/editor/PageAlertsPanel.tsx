"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import useSWR from "swr";
import { describeFetchError } from "../../lib/swr";
import {
	pageAlertsKey,
	send,
	type PageAlertList,
	type PageAlertRecord,
} from "../alerts/pageAlertClient";
import { runsNote } from "../alerts/PageAlerts";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { SkeletonText } from "../components/shared/Skeleton";
import { useNotify } from "../notify/NotifyContext";
import type { SourceMeta } from "../visuals/types";
import alertStyles from "../alerts/PageAlerts.module.css";
import styles from "./Editor.module.css";

// The page's alerts, from the editor rail.
//
// An editor sets up alerts that readers of the page can follow, with the rule
// and the schedule theirs to decide. Each is saved straight away rather than
// with the page's next publish, because followers are told from the alert as it
// stands, and holding one back until an unrelated edit is published would
// leave them hearing from the old rule meanwhile.

const AlertDialog = dynamic(
	() => import("../alerts/AlertDialog").then((m) => m.AlertDialog),
	{ ssr: false },
);

export function PageAlertsPanel({
	pageId,
	pageTitle,
	sources,
	draft,
	onClose,
}: {
	pageId: string;
	pageTitle: string;
	sources: Record<string, SourceMeta>;
	// A page added in this session and not yet published, which cannot hold
	// alerts until it exists.
	draft: boolean;
	onClose: () => void;
}) {
	const { alertsEnabled } = useNotify();
	const { data, error, isLoading, mutate } = useSWR<PageAlertList>(
		draft || !alertsEnabled ? null : pageAlertsKey(pageId),
	);
	const [dialog, setDialog] = useState<{
		editing: PageAlertRecord | null;
	} | null>(null);
	const [deleting, setDeleting] = useState<PageAlertRecord | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const choices = (data?.sourceKeys ?? [])
		.map((key) => sources[key])
		.filter((s): s is SourceMeta => Boolean(s));
	const canChange = Boolean(data?.canEdit && !data.locked);

	const remove = async () => {
		if (!deleting) return;
		setBusy(true);
		setFailure(null);
		const sent = await send(
			`/api/page-alerts/${encodeURIComponent(deleting.id)}/`,
			"DELETE",
		);
		setBusy(false);
		setDeleting(null);
		if (!sent.ok) {
			setFailure(sent.body.error ?? "Could not delete the alert.");
			return;
		}
		void mutate();
	};

	const body = !alertsEnabled ? (
		<p className={styles.hint}>
			Alerts are turned off for this app. An administrator can turn them
			on under Administration, Notifications.
		</p>
	) : draft ? (
		<p className={styles.hint}>
			Publish the page first. Alerts can be added once it exists.
		</p>
	) : error ? (
		<p className={styles.hint}>{describeFetchError(error, "list")}</p>
	) : isLoading && !data ? (
		<SkeletonText lines={3} />
	) : data ? (
		<>
			<p className={styles.hint}>
				Readers follow these from the Alerts button on the page. Each is
				told about the rows they can see, on the schedule you set.
			</p>
			{data.locked && <p className={styles.hint}>{data.locked}</p>}
			{choices.length === 0 && (
				<p className={styles.hint}>
					Nothing on this page reads a dataset you can read, so there
					is nothing to watch yet.
				</p>
			)}
			<button
				type="button"
				className={`${styles.saveButton} ${alertStyles.addButton}`}
				onClick={() => setDialog({ editing: null })}
				disabled={!canChange || choices.length === 0}
			>
				Add alert
			</button>
			{failure && (
				<p className={alertStyles.error} role="alert">
					{failure}
				</p>
			)}
			{data.alerts.length === 0 ? (
				<p className={styles.hint}>This page has no alerts yet.</p>
			) : (
				<ul className={alertStyles.panelList}>
					{data.alerts.map((alert) => {
						const note = runsNote(alert, true);
						return (
							<li
								key={alert.id}
								className={alertStyles.panelItem}
							>
								<span className={alertStyles.name}>
									{alert.name}
								</span>
								<span className={alertStyles.rule}>
									{alert.summary}
								</span>
								<span className={alertStyles.meta}>
									{alert.scheduleText}.{" "}
									{alert.subscribers === 1
										? "1 subscriber"
										: `${alert.subscribers ?? 0} subscribers`}
								</span>
								{note && (
									<span className={alertStyles.hint}>
										{note}
									</span>
								)}
								<span className={alertStyles.panelActions}>
									<button
										type="button"
										className={alertStyles.linkButton}
										onClick={() =>
											setDialog({ editing: alert })
										}
										disabled={!canChange}
									>
										Edit
									</button>
									<button
										type="button"
										className={alertStyles.dangerLink}
										onClick={() => setDeleting(alert)}
										disabled={!canChange}
									>
										Delete
									</button>
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</>
	) : null;

	return (
		<div className={styles.panel}>
			<div className={styles.panelHead}>
				<span className={styles.panelKind}>Alerts</span>
				<span className={styles.panelSubject}>
					{pageTitle.trim() || "Untitled page"}
				</span>
				<button
					type="button"
					className={styles.panelBack}
					onClick={onClose}
					title="Close the panel"
					aria-label="Close the panel"
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M6 6l12 12M18 6L6 18" />
					</svg>
				</button>
			</div>
			<div className={styles.panelBody}>{body}</div>

			{dialog && data && (
				<AlertDialog
					sources={choices}
					page={{ pageId, pageTitle, editing: dialog.editing }}
					prefill={{
						sourceKey: data.pageSourceKey ?? choices[0]?.sourceKey,
					}}
					onClose={() => setDialog(null)}
					onSavedPage={() => {
						setDialog(null);
						void mutate();
					}}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					title="Delete this page alert?"
					body={`${deleting.name} stops checking for everyone who follows it${
						deleting.subscribers
							? `, ${deleting.subscribers === 1 ? "1 person" : `${deleting.subscribers} people`}`
							: ""
					}. Messages it already sent stay in their inboxes.`}
					confirmLabel="Delete"
					busy={busy}
					onConfirm={() => void remove()}
					onCancel={() => setDeleting(null)}
				/>
			)}
		</div>
	);
}
