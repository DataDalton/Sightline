"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import type { DeliveryRecord } from "../../lib/deliveries/store";
import { describeFetchError } from "../../lib/swr";
import { deliveriesKey } from "./ScheduleButton";
import styles from "./Deliveries.module.css";

// The pages somebody has asked to be sent, in their inbox beside their alerts.
// Each says when it next comes and whether the last one went, and can be sent
// at once or stopped.

function when(iso: string | null): string {
	if (!iso) return "not yet";
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function ScheduledPages() {
	const { data, error, mutate } = useSWR<{
		deliveries: DeliveryRecord[];
		enabled: boolean;
	}>(deliveriesKey);
	const [busy, setBusy] = useState<string | null>(null);
	// The delivery a send or a stop failed for, and why.
	const [failure, setFailure] = useState<{
		id: string;
		message: string;
	} | null>(null);

	if (error) {
		return (
			<p className={styles.state}>
				{describeFetchError(error, "scheduled pages")}
			</p>
		);
	}
	if (!data) return <p className={styles.state}>Loading</p>;
	if (data.deliveries.length === 0) {
		return (
			<p className={styles.state}>
				Nothing is scheduled. Open a report page and press Schedule to
				have its figures sent to you.
			</p>
		);
	}

	const act = async (id: string, method: "POST" | "DELETE") => {
		setBusy(id);
		setFailure(null);
		const fallback =
			method === "POST"
				? "It could not be sent. Try again."
				: "It could not be stopped. Try again.";
		try {
			const response = await fetch(
				`${deliveriesKey}/${encodeURIComponent(id)}/`,
				{ method },
			);
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as {
					error?: string;
				} | null;
				setFailure({ id, message: body?.error ?? fallback });
			}
			await mutate();
		} catch {
			setFailure({ id, message: fallback });
		} finally {
			setBusy(null);
		}
	};

	return (
		<ul className={styles.list}>
			{data.deliveries.map((d) => (
				<li key={d.id} className={styles.row}>
					<div className={styles.rowMain}>
						<Link
							href={`/r/${encodeURIComponent(d.reportSlug)}/`}
							className={styles.rowTitle}
						>
							{d.pageTitle === d.reportTitle
								? d.reportTitle
								: `${d.reportTitle}: ${d.pageTitle}`}
						</Link>
						<span className={styles.rowMeta}>
							{d.scheduleText}. Next {when(d.nextRunOn)}. Last
							sent {when(d.lastRunOn)}.
						</span>
						{d.lastStatus !== "ok" && d.lastError && (
							<span
								className={
									d.lastStatus === "waiting"
										? styles.rowWaiting
										: styles.rowError
								}
							>
								{d.lastError}
							</span>
						)}
						{failure?.id === d.id && (
							<span className={styles.rowError} role="alert">
								{failure.message}
							</span>
						)}
					</div>
					<div className={styles.rowActions}>
						<button
							type="button"
							className={styles.secondary}
							disabled={busy === d.id}
							onClick={() => void act(d.id, "POST")}
						>
							Send now
						</button>
						<button
							type="button"
							className={styles.secondary}
							disabled={busy === d.id}
							onClick={() => void act(d.id, "DELETE")}
						>
							Stop
						</button>
					</div>
				</li>
			))}
		</ul>
	);
}
