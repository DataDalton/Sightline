"use client";

import { useState } from "react";
import styles from "./Alerts.module.css";

// How often this alert would have gone off over the past year, before it is saved.

interface Answer {
	available: boolean;
	reason?: string;
	checked?: number;
	fired?: number;
	lastOn?: string | null;
	perMonth?: number;
}

export function AlertBacktest({
	definition,
	ready,
}: {
	definition: unknown;
	ready: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [answer, setAnswer] = useState<Answer | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	return (
		<div className={styles.field}>
			<button
				type="button"
				className={styles.secondary}
				disabled={busy || !ready}
				onClick={async () => {
					setBusy(true);
					setFailure(null);
					setAnswer(null);
					try {
						const response = await fetch("/api/alerts/backtest", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(definition),
						});
						const detail = await response.json().catch(() => null);
						if (!response.ok) {
							setFailure(detail?.error ?? "Could not look back.");
						} else {
							setAnswer(detail);
						}
					} catch {
						setFailure("Could not look back.");
					} finally {
						setBusy(false);
					}
				}}
			>
				{busy ? "Looking back" : "How often would this have fired?"}
			</button>
			{answer && !answer.available && (
				<p className={styles.fieldHint}>{answer.reason}</p>
			)}
			{answer?.available && (
				<p className={styles.fieldHint}>
					Over the past year, reading the figure day by day, it would
					have fired {answer.fired} time
					{answer.fired === 1 ? "" : "s"}
					{answer.fired
						? `, about ${answer.perMonth?.toFixed(1)} a month, last on ${answer.lastOn}`
						: ""}
					.
				</p>
			)}
			{failure && <p className={styles.fieldHint}>{failure}</p>}
		</div>
	);
}
