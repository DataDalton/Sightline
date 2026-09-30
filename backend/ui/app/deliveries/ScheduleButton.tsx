"use client";

import { useState } from "react";
import useSWR from "swr";
import type { DeliveryRecord } from "../../lib/deliveries/store";
import { weekdayNames } from "../../lib/alerts/schedule";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import styles from "./Deliveries.module.css";

// Asks for a page to be sent on a schedule: its headline figures, worked out
// under the reader's own access, arriving in their inbox and by push. The
// same page scheduled again changes when it comes rather than adding a second.

export const deliveriesKey = "/api/deliveries";

const hours = Array.from({ length: 24 }, (_, hour) => ({
	value: String(hour),
	label: `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? "AM" : "PM"}`,
}));

export function ScheduleButton({
	reportSlug,
	pageId,
	pageTitle,
	className,
}: {
	reportSlug: string;
	pageId: string;
	pageTitle: string;
	// The page header's own button style, so this sits among the others.
	className: string;
}) {
	const [open, setOpen] = useState(false);
	const { data, mutate } = useSWR<{
		deliveries: DeliveryRecord[];
		enabled: boolean;
	}>(deliveriesKey);

	if (data && !data.enabled) return null;
	const existing = data?.deliveries.find((d) => d.pageId === pageId);

	return (
		<>
			<button
				type="button"
				className={className}
				onClick={() => setOpen(true)}
				title={
					existing
						? existing.scheduleText
						: "Have this page sent to you"
				}
			>
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<circle cx="12" cy="12" r="10" />
					<path d="M12 6v6l4 2" />
				</svg>
				{existing ? "Scheduled" : "Schedule"}
			</button>
			{open && (
				<ScheduleDialog
					reportSlug={reportSlug}
					pageId={pageId}
					pageTitle={pageTitle}
					existing={existing}
					onClose={() => setOpen(false)}
					onSaved={() => void mutate()}
				/>
			)}
		</>
	);
}

function ScheduleDialog({
	reportSlug,
	pageId,
	pageTitle,
	existing,
	onClose,
	onSaved,
}: {
	reportSlug: string;
	pageId: string;
	pageTitle: string;
	existing: DeliveryRecord | undefined;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [frequency, setFrequency] = useState(
		existing?.schedule.frequency ?? "weekly",
	);
	const [hour, setHour] = useState(String(existing?.schedule.hour ?? 8));
	const [weekday, setWeekday] = useState(
		String(existing?.schedule.weekday ?? 1),
	);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const send = async (method: "POST" | "DELETE") => {
		setBusy(true);
		setFailure(null);
		try {
			const response =
				method === "POST"
					? await fetch(`${deliveriesKey}/`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								reportSlug,
								pageId,
								schedule: {
									frequency,
									hour: Number(hour),
									weekday: Number(weekday),
									timeZone:
										Intl.DateTimeFormat().resolvedOptions()
											.timeZone,
								},
							}),
						})
					: await fetch(`${deliveriesKey}/${existing!.id}/`, {
							method: "DELETE",
						});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as {
					error?: string;
				};
				setFailure(body.error ?? "That did not save. Try again.");
				return;
			}
			onSaved();
			onClose();
		} catch {
			setFailure("The request did not reach the server. Try again.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={`Send ${pageTitle} to me`}
			width="480px"
		>
			<div className={styles.form}>
				<p className={styles.lead}>
					Its headline figures arrive in your inbox, and on your phone
					if you have pushes on, with how each moved since last time.
					They are worked out under your own access.
				</p>

				<label className={styles.field}>
					<span className={styles.label}>How often</span>
					<Select
						value={frequency}
						onChange={(v) => setFrequency(v as typeof frequency)}
						options={[
							{ value: "daily", label: "Every day" },
							{ value: "weekdays", label: "Every weekday" },
							{ value: "weekly", label: "Once a week" },
						]}
					/>
				</label>

				{frequency === "weekly" && (
					<label className={styles.field}>
						<span className={styles.label}>On</span>
						<Select
							value={weekday}
							onChange={setWeekday}
							options={weekdayNames.map((name, i) => ({
								value: String(i),
								label: name,
							}))}
						/>
					</label>
				)}

				<label className={styles.field}>
					<span className={styles.label}>At</span>
					<Select value={hour} onChange={setHour} options={hours} />
					<span className={styles.hint}>
						In your time zone,{" "}
						{Intl.DateTimeFormat().resolvedOptions().timeZone}.
					</span>
				</label>

				{failure && (
					<p className={styles.error} role="alert">
						{failure}
					</p>
				)}

				<div className={styles.actions}>
					{existing && (
						<button
							type="button"
							className={styles.secondary}
							disabled={busy}
							onClick={() => void send("DELETE")}
						>
							Stop sending
						</button>
					)}
					<button
						type="button"
						className={styles.primary}
						disabled={busy}
						onClick={() => void send("POST")}
					>
						{existing ? "Save" : "Schedule it"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
