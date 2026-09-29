"use client";

import type { FreshnessDetail } from "../../lib/freshness/marks";
import { checkIntervals } from "../../lib/freshness/history";
import { Select } from "../components/shared/Select";
import styles from "./Admin.module.css";

// How often a source is looked at for new data, in a source's edit dialog.
//
// One choice rather than a mode and a number. A look reads the tables'
// history, not their data, and answers are kept until a look finds a change,
// so the interval is how soon new data can show, not how often anything is
// queried. See lib/freshness.

export type Unit = "minutes" | "hours" | "days";

export const unitSeconds: Record<Unit, number> = {
	minutes: 60,
	hours: 3600,
	days: 86400,
};

function ago(iso: string | null): string {
	if (!iso) return "not yet";
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hr ago`;
	return `${Math.round(hours / 24)} days ago`;
}

export function CheckSetting({
	choice,
	onChoice,
	customAmount,
	onCustomAmount,
	customUnit,
	onCustomUnit,
	freshness,
}: {
	choice: string;
	onChoice: (value: string) => void;
	customAmount: string;
	onCustomAmount: (value: string) => void;
	customUnit: Unit;
	onCustomUnit: (value: Unit) => void;
	freshness: FreshnessDetail | null;
}) {
	return (
		<label className={styles.field}>
			<span className={styles.fieldLabel}>Check for new data</span>
			<Select
				value={choice}
				onChange={onChoice}
				options={[
					{ value: "live", label: "Live" },
					...checkIntervals.map((c) => ({
						value: String(c.seconds),
						label: c.label,
					})),
					{ value: "custom", label: "Custom" },
					{ value: "default", label: "Platform default" },
				]}
			/>
			{choice === "custom" && (
				<span className={styles.numberBox}>
					<input
						type="number"
						min={1}
						className={styles.numberInput}
						value={customAmount}
						onChange={(e) => onCustomAmount(e.target.value)}
						aria-label="How many"
					/>
					<Select
						value={customUnit}
						onChange={(v) => onCustomUnit(v as Unit)}
						options={[
							{ value: "minutes", label: "minutes" },
							{ value: "hours", label: "hours" },
							{ value: "days", label: "days" },
						]}
					/>
				</span>
			)}
			<span className={styles.fieldHint}>
				{choice === "live"
					? "Open pages update themselves when the data changes. Set the interval under Platform, Caching."
					: choice === "default"
						? "Uses the platform setting under Platform, Caching."
						: "New data can take up to this long to show. Answers are kept until a change is found, so nothing is queried again when the data has not changed."}
			</span>
			{freshness && (
				<span className={styles.fieldHint}>
					{freshness.mode === "checked"
						? `Watched for changes. Last checked ${ago(freshness.checkedOn)}, data last changed ${ago(freshness.changedOn)}.`
						: (freshness.note ??
							"Refreshed on a timer, since its tables cannot be checked.")}
				</span>
			)}
		</label>
	);
}
