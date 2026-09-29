"use client";

import {
	describePattern,
	type LatenessSetting,
} from "../../lib/freshness/arrivals";
import type { LatenessDetail } from "../../lib/freshness/lateness";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import styles from "./Admin.module.css";

// Whether readers are warned when a source's data has not arrived when it
// usually does, in a source's edit dialog.
//
// Learned by default from when its tables have loaded, which needs nothing
// set. Turned off for a source loaded now and then by hand, or set by hand for
// one whose schedule is known better than a month of history shows.

function browserZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

function when(iso: string | null): string {
	if (!iso) return "";
	const at = new Date(iso);
	return at.toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

// Where the source stands, in a sentence.
function standing(detail: LatenessDetail): string {
	switch (detail.state) {
		case "late":
			return `Late. The next load was expected by ${when(detail.expectedBy)}, and the last landed ${when(detail.lastArrival)}.`;
		case "on_time":
			return `On time. The next load is expected by ${when(detail.expectedBy)}.`;
		case "overdue":
			return `Past when the next load was expected. It is looked at the next time somebody opens a page built on it, which settles whether it is late.`;
		case "off":
			return "Readers are not warned.";
		case "unwatched":
			return "Its tables cannot be checked for changes, so whether it is late cannot be judged.";
		default:
			return "";
	}
}

export function LateSetting({
	value,
	onChange,
	detail,
}: {
	value: LatenessSetting;
	onChange: (next: LatenessSetting) => void;
	detail: LatenessDetail | null;
}) {
	const custom = value.mode === "custom" ? value : null;
	const hours = custom?.everyHours ?? 24;
	const inDays = hours >= 24 && hours % 24 === 0;

	const setCustom = (
		patch: Partial<{ everyHours: number; weekdaysOnly: boolean }>,
	) =>
		onChange({
			mode: "custom",
			everyHours: patch.everyHours ?? hours,
			weekdaysOnly: patch.weekdaysOnly ?? custom?.weekdaysOnly ?? true,
		});

	return (
		<div className={styles.field}>
			<span className={styles.fieldLabel}>
				Warn readers when data is late
			</span>
			<Select
				value={value.mode}
				onChange={(mode) =>
					mode === "custom"
						? setCustom({})
						: onChange({ mode: mode as "auto" | "off" })
				}
				ariaLabel="Warn readers when data is late"
				options={[
					{ value: "auto", label: "Learn when it usually arrives" },
					{ value: "custom", label: "Expect it on a set schedule" },
					{ value: "off", label: "Never" },
				]}
			/>

			{custom && (
				<>
					<span className={styles.numberBox}>
						<span className={styles.fieldHint}>At least every</span>
						<input
							type="number"
							min={1}
							className={styles.numberInput}
							value={inDays ? hours / 24 : hours}
							onChange={(e) => {
								const n = Number(e.target.value);
								if (!Number.isFinite(n) || n <= 0) return;
								setCustom({ everyHours: inDays ? n * 24 : n });
							}}
							aria-label="How many"
						/>
						<Select
							value={inDays ? "days" : "hours"}
							onChange={(unit) =>
								setCustom({
									everyHours:
										unit === "days"
											? Math.max(1, Math.round(hours)) *
												24
											: Math.max(
													1,
													Math.round(hours / 24),
												),
								})
							}
							ariaLabel="Unit"
							options={[
								{ value: "hours", label: "hours" },
								{ value: "days", label: "days" },
							]}
						/>
					</span>
					<Toggle
						checked={custom.weekdaysOnly}
						onChange={(weekdaysOnly) => setCustom({ weekdaysOnly })}
						label="Only count weekdays"
					/>
				</>
			)}

			<span className={styles.fieldHint}>
				{value.mode === "auto"
					? "Learned from when its tables have loaded over the last six weeks, counting only the days of the week loads happen on, so a weekend is not a late load. Readers see a notice on its pages, and the people who look after it are told."
					: value.mode === "custom"
						? "Late once this long has passed since the last load without another."
						: "For data loaded now and then by hand, where a gap means nothing."}
			</span>

			{detail && value.mode === detail.setting.mode && (
				<span className={styles.fieldHint}>
					{detail.pattern && value.mode !== "off"
						? `${describePattern(detail.pattern, browserZone())} `
						: ""}
					{standing(detail)}
				</span>
			)}
		</div>
	);
}
