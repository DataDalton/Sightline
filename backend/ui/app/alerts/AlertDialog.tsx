"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
	conditionLabel,
	isRelative,
	needsThreshold,
	type AlertCondition,
	type AlertDefinition,
} from "../../lib/alerts/rule";
import type { Frequency } from "../../lib/alerts/schedule";
import type { AlertRecord } from "../../lib/alerts/store";
import {
	describeConditions,
	type Condition,
} from "../../lib/explore/conditions";
import { encodeState } from "../../lib/explore/state";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import type { SourceMeta } from "../visuals/types";
import styles from "./Alerts.module.css";

// Creating or changing an alert.
//
// The conditions are Explore's, and are changed in Explore, where they can be
// typed and seen narrowing the table. Here is everything else: what to
// measure, what counts as news, and when to look.

export interface AlertPrefill {
	sourceKey?: string;
	measure?: string;
	groupBy?: string | null;
	conditions?: Condition[];
}

const conditions: AlertCondition[] = [
	"above",
	"below",
	"rises_by",
	"falls_by",
	"changes_by",
	"changes",
];

const frequencyLabel: Record<Frequency, string> = {
	hourly: "Every hour",
	daily: "Every day",
	weekdays: "Weekdays",
	weekly: "Once a week",
};

const weekdays = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

function hourLabel(hour: number): string {
	const suffix = hour < 12 ? "AM" : "PM";
	return `${hour % 12 === 0 ? 12 : hour % 12}:00 ${suffix}`;
}

function browserZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

interface Preview {
	readings: { group: string | null; value: number | null }[];
	formatted: string[];
	firings: { group: string | null }[];
}

export function AlertDialog({
	sources,
	editing,
	prefill,
	onClose,
	onSaved,
}: {
	sources: SourceMeta[];
	editing?: AlertRecord | null;
	prefill?: AlertPrefill;
	onClose: () => void;
	onSaved: (alert: AlertRecord) => void;
}) {
	const start: Partial<AlertDefinition> = editing?.definition ?? {
		sourceKey: prefill?.sourceKey ?? "",
		measure: prefill?.measure ?? "",
		groupBy: prefill?.groupBy ?? null,
		conditions: prefill?.conditions ?? [],
	};

	const [name, setName] = useState(editing?.name ?? "");
	const [sourceKey, setSourceKey] = useState(start.sourceKey ?? "");
	const [measure, setMeasure] = useState(start.measure ?? "");
	const [groupBy, setGroupBy] = useState<string>(start.groupBy ?? "");
	const [rowConditions, setRowConditions] = useState<Condition[]>(
		start.conditions ?? [],
	);
	const [condition, setCondition] = useState<AlertCondition>(
		start.condition ?? "above",
	);
	const [threshold, setThreshold] = useState(
		start.threshold === null || start.threshold === undefined
			? ""
			: String(start.threshold),
	);
	const [frequency, setFrequency] = useState<Frequency>(
		start.schedule?.frequency ?? "daily",
	);
	const [hour, setHour] = useState(start.schedule?.hour ?? 8);
	const [weekday, setWeekday] = useState(start.schedule?.weekday ?? 1);
	const [notifyRecover, setNotifyRecover] = useState(
		start.notifyRecover ?? false,
	);

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewing, setPreviewing] = useState(false);

	const source = sources.find((s) => s.sourceKey === sourceKey);
	const measureMeta = source?.measures.find((m) => m.name === measure);

	const timeZone = editing?.definition.schedule.timeZone ?? browserZone();

	const definition = useMemo(
		() => ({
			name,
			sourceKey,
			measure,
			groupBy: groupBy || null,
			conditions: rowConditions,
			condition,
			threshold: needsThreshold(condition) ? threshold : null,
			schedule: { frequency, hour, weekday, timeZone },
			notifyRecover:
				(condition === "above" || condition === "below") &&
				notifyRecover,
		}),
		[
			name,
			sourceKey,
			measure,
			groupBy,
			rowConditions,
			condition,
			threshold,
			frequency,
			hour,
			weekday,
			timeZone,
			notifyRecover,
		],
	);

	// The value now, read under the reader's own access, so a threshold is
	// chosen against the real figure. Read again when what is measured
	// changes, not when the threshold does.
	const watchedKey = JSON.stringify([
		sourceKey,
		measure,
		groupBy,
		rowConditions,
	]);
	useEffect(() => {
		if (!sourceKey || !measure) {
			setPreview(null);
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			setPreviewing(true);
			setPreviewError(null);
			try {
				const response = await fetch("/api/alerts/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						...definition,
						condition: "changes",
						threshold: null,
					}),
					signal: controller.signal,
				});
				const body = await response.json();
				if (!response.ok) {
					setPreview(null);
					setPreviewError(body?.error ?? "Could not read the value.");
				} else {
					setPreview(body);
				}
			} catch (e) {
				if ((e as Error).name !== "AbortError") {
					setPreviewError("Could not read the value.");
				}
			} finally {
				setPreviewing(false);
			}
		}, 450);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
		// Keyed on what is measured alone, so typing a threshold or a name
		// does not read the warehouse again.
	}, [watchedKey]);

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const response = await fetch(
				editing ? `/api/alerts/${editing.id}` : "/api/alerts",
				{
					method: editing ? "PUT" : "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(definition),
				},
			);
			const body = await response.json();
			if (!response.ok) {
				setError(body?.error ?? "Could not save the alert.");
				return;
			}
			onSaved(body.alert);
		} finally {
			setSaving(false);
		}
	};

	const exploreHref = sourceKey
		? `/explore/?q=${encodeState({
				sourceKey,
				columns: [
					...(groupBy ? [groupBy] : []),
					...(measure ? [measure] : []),
				],
				conditions: rowConditions,
			})}${editing ? `&alert=${editing.id}` : ""}`
		: "/explore/";

	const relative = isRelative(condition);
	const numericMeasures = source?.measures ?? [];

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={editing ? "Edit alert" : "New alert"}
			width="620px"
			footer={
				<>
					{error && <span className={styles.formError}>{error}</span>}
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
						onClick={save}
						disabled={saving || !sourceKey || !measure}
					>
						{saving ? "Saving" : editing ? "Save" : "Create alert"}
					</button>
				</>
			}
		>
			<div className={styles.form}>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Name</span>
					<input
						className={styles.input}
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={
							measure
								? `${measure} ${conditionLabel[condition]}${threshold ? ` ${threshold}` : ""}`
								: "Named after what it watches if left blank"
						}
						maxLength={120}
					/>
				</label>

				<div className={styles.fieldRow}>
					<div className={styles.field}>
						<span className={styles.fieldLabel}>Dataset</span>
						<Select
							options={sources.map((s) => ({
								value: s.sourceKey,
								label: s.title,
							}))}
							value={sourceKey}
							onChange={(key) => {
								setSourceKey(key);
								setMeasure("");
								setGroupBy("");
								setRowConditions([]);
							}}
							placeholder="Choose a dataset"
							searchable
							ariaLabel="Dataset"
						/>
					</div>
					<div className={styles.field}>
						<span className={styles.fieldLabel}>Measure</span>
						<Select
							options={numericMeasures.map((m) => ({
								value: m.name,
								label: m.displayName ?? m.name,
							}))}
							value={measure}
							onChange={setMeasure}
							placeholder={
								source
									? "Choose a measure"
									: "Choose a dataset first"
							}
							disabled={!source}
							searchable
							ariaLabel="Measure"
						/>
					</div>
				</div>

				<div className={styles.field}>
					<span className={styles.fieldLabel}>Watch</span>
					<Select
						options={[
							{ value: "", label: "The total" },
							...(source?.dimensions ?? []).map((d) => ({
								value: d.name,
								label: `Each ${d.displayName ?? d.name}`,
							})),
						]}
						value={groupBy}
						onChange={setGroupBy}
						disabled={!source}
						searchable
						ariaLabel="Watch the total or each value of a field"
					/>
					<span className={styles.fieldHint}>
						{groupBy
							? `Each ${groupBy} is checked on its own, and the alert says which ones crossed.`
							: "One figure for everything the filters below include."}
					</span>
				</div>

				<div className={styles.field}>
					<span className={styles.fieldLabel}>Filters</span>
					<div className={styles.filters}>
						<span
							className={
								rowConditions.length
									? styles.filterText
									: styles.fieldHint
							}
						>
							{rowConditions.length
								? describeConditions(rowConditions)
								: "None. Every row is included."}
						</span>
						<span className={styles.filterActions}>
							{rowConditions.length > 0 && (
								<button
									type="button"
									className={styles.linkButton}
									onClick={() => setRowConditions([])}
								>
									Clear
								</button>
							)}
							{sourceKey && (
								<Link
									href={exploreHref}
									className={styles.linkButton}
								>
									{rowConditions.length
										? "Change in Explore"
										: "Add in Explore"}
								</Link>
							)}
						</span>
					</div>
				</div>

				<div className={styles.field}>
					<span className={styles.fieldLabel}>Tell me when it</span>
					<div className={styles.conditionRow}>
						<Select
							options={conditions.map((c) => ({
								value: c,
								label: conditionLabel[c],
							}))}
							value={condition}
							onChange={(v) => setCondition(v as AlertCondition)}
							ariaLabel="Condition"
						/>
						{needsThreshold(condition) && (
							<span className={styles.thresholdWrap}>
								<input
									className={`${styles.input} ${styles.threshold}`}
									inputMode="decimal"
									value={threshold}
									onChange={(e) =>
										setThreshold(e.target.value)
									}
									placeholder={relative ? "10" : "Value"}
									aria-label={
										relative ? "Percentage" : "Value"
									}
								/>
								{relative && (
									<span className={styles.unit}>%</span>
								)}
							</span>
						)}
					</div>
					<span className={styles.fieldHint}>
						{condition === "above" || condition === "below"
							? "You are told once when it crosses, not on every check it stays there."
							: condition === "changes"
								? "Compared with the previous check."
								: "Compared with the previous check, as a percentage of it."}
					</span>
					{(condition === "above" || condition === "below") && (
						<label className={styles.check}>
							<input
								type="checkbox"
								checked={notifyRecover}
								onChange={(e) =>
									setNotifyRecover(e.target.checked)
								}
							/>
							Also tell me when it is back
						</label>
					)}
				</div>

				<div className={styles.field}>
					<span className={styles.fieldLabel}>Check</span>
					<div className={styles.conditionRow}>
						<Select
							options={(
								Object.keys(frequencyLabel) as Frequency[]
							).map((f) => ({
								value: f,
								label: frequencyLabel[f],
							}))}
							value={frequency}
							onChange={(v) => setFrequency(v as Frequency)}
							ariaLabel="How often"
						/>
						{frequency === "weekly" && (
							<Select
								options={weekdays.map((d, i) => ({
									value: String(i),
									label: d,
								}))}
								value={String(weekday)}
								onChange={(v) => setWeekday(Number(v))}
								ariaLabel="Day"
							/>
						)}
						{frequency !== "hourly" && (
							<Select
								options={Array.from({ length: 24 }, (_, h) => ({
									value: String(h),
									label: hourLabel(h),
								}))}
								value={String(hour)}
								onChange={(v) => setHour(Number(v))}
								ariaLabel="Time"
							/>
						)}
					</div>
					<span className={styles.fieldHint}>
						Times are {timeZone.replace(/_/g, " ")}.
					</span>
				</div>

				{sourceKey && measure && (
					<div className={styles.preview} aria-live="polite">
						<span className={styles.previewLabel}>Right now</span>
						{previewing && !preview ? (
							<span className={styles.fieldHint}>
								Reading the value
							</span>
						) : previewError ? (
							<span className={styles.formError}>
								{previewError}
							</span>
						) : preview ? (
							preview.readings.length === 0 ? (
								<span className={styles.fieldHint}>
									Nothing matches the filters.
								</span>
							) : groupBy ? (
								<ul className={styles.previewList}>
									{preview.readings
										.slice(0, 6)
										.map((r, i) => (
											<li key={r.group ?? i}>
												<span>{r.group}</span>
												<span
													className={
														styles.previewValue
													}
												>
													{preview.formatted[i]}
												</span>
											</li>
										))}
									{preview.readings.length > 6 && (
										<li className={styles.fieldHint}>
											and {preview.readings.length - 6}{" "}
											more
										</li>
									)}
								</ul>
							) : (
								<span className={styles.previewBig}>
									{preview.formatted[0]}
									{measureMeta?.displayName || measure ? (
										<span className={styles.fieldHint}>
											{" "}
											{measureMeta?.displayName ??
												measure}
										</span>
									) : null}
								</span>
							)
						) : null}
					</div>
				)}
			</div>
		</Modal>
	);
}
