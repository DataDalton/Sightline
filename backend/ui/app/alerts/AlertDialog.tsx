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
import type { AlertDraft } from "../../lib/assistant/surfaces/alert";
import {
	describeCondition,
	parseCondition,
	type Condition,
	type KnownField,
} from "../../lib/explore/conditions";
import { encodeState } from "../../lib/explore/state";
import { AssistPrompt } from "../assist/AssistPrompt";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import type { SourceMeta } from "../visuals/types";
import styles from "./Alerts.module.css";

// Creating or changing an alert.
//
// The rule is one sentence with a choice at each part, read as "in this
// dataset, tell me when this measure, for the total or for each value of a
// field, crosses this line". Conditions narrow the rows in the same words Explore reads. Below the
// rule are the values as they stand, with the line drawn across them, so the
// threshold is chosen against real figures. When it is checked is one line
// that opens when clicked, since most alerts keep the default.
//
// The assistant can fill all of it in from a description, and the person
// reads it here and saves it themselves.

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

// Groups drawn as bars before the rest are summed up in a line.
const shownGroups = 8;

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

function scheduleText(
	frequency: Frequency,
	hour: number,
	weekday: number,
): string {
	if (frequency === "hourly") return "Checked every hour";
	if (frequency === "weekly") {
		return `Checked every ${weekdays[weekday]} at ${hourLabel(hour)}`;
	}
	if (frequency === "weekdays") {
		return `Checked on weekdays at ${hourLabel(hour)}`;
	}
	return `Checked every day at ${hourLabel(hour)}`;
}

interface Preview {
	readings: { group: string | null; value: number | null }[];
	formatted: string[];
	firings: { group: string | null }[];
}

function Remove({ onClick, label }: { onClick: () => void; label: string }) {
	return (
		<button
			type="button"
			className={styles.chipRemove}
			onClick={onClick}
			aria-label={label}
			title={label}
		>
			<svg
				width="10"
				height="10"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="3"
				strokeLinecap="round"
				aria-hidden="true"
			>
				<path d="M6 6l12 12M18 6L6 18" />
			</svg>
		</button>
	);
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
	const [scheduleOpen, setScheduleOpen] = useState(false);
	const [conditionText, setConditionText] = useState("");
	const [conditionProblem, setConditionProblem] = useState<string | null>(
		null,
	);

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewing, setPreviewing] = useState(false);

	const source = sources.find((s) => s.sourceKey === sourceKey);
	const measureMeta = source?.measures.find((m) => m.name === measure);
	const groupMeta = source?.dimensions.find((d) => d.name === groupBy);

	const timeZone = editing?.definition.schedule.timeZone ?? browserZone();

	const knownFields = useMemo<KnownField[]>(
		() => [
			...(source?.dimensions ?? []).map((d) => ({
				name: d.name,
				kind: "dimension" as const,
			})),
			...(source?.measures ?? []).map((m) => ({
				name: m.name,
				kind: "measure" as const,
			})),
		],
		[source],
	);

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

	// Everything the assistant filled in, in one go. The dataset first, since
	// the rest is only meaningful on it.
	const applyDraft = (raw: unknown) => {
		const draft = raw as AlertDraft;
		setSourceKey(draft.sourceKey);
		setMeasure(draft.measure);
		setGroupBy(draft.groupBy ?? "");
		setRowConditions(draft.conditions);
		setCondition(draft.condition);
		setThreshold(draft.threshold === null ? "" : String(draft.threshold));
		setFrequency(draft.schedule.frequency as Frequency);
		setHour(draft.schedule.hour);
		setWeekday(draft.schedule.weekday);
		setNotifyRecover(draft.notifyRecover);
		if (draft.name) setName(draft.name);
		setError(null);
	};

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

	// A condition typed into the box, read the way Explore's bar reads it.
	const addCondition = () => {
		const typed = conditionText.trim();
		if (!typed) return;
		const parsed = parseCondition(typed, knownFields);
		if (!parsed || parsed.partial) {
			setConditionProblem(
				"Start with a field name, then a comparison and a value, such as Channel = Online.",
			);
			return;
		}
		setRowConditions((held) => [...held, parsed.condition]);
		setConditionText("");
		setConditionProblem(null);
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
	const crossing = condition === "above" || condition === "below";
	const line = Number(threshold.replace(/[,$%\s]/g, ""));
	const hasLine =
		crossing && threshold.trim() !== "" && Number.isFinite(line);
	const meets = (value: number | null) =>
		hasLine &&
		value !== null &&
		(condition === "above" ? value > line : value < line);

	const readings = preview?.readings ?? [];
	const scale = Math.max(
		...readings.slice(0, shownGroups).map((r) => Math.abs(r.value ?? 0)),
		hasLine ? Math.abs(line) : 0,
		1e-9,
	);
	const firingNow = readings.filter((r) => meets(r.value)).length;

	const autoName = measure
		? `${measureMeta?.displayName ?? measure} ${conditionLabel[condition]}${
				needsThreshold(condition) && threshold
					? ` ${threshold}${relative ? "%" : ""}`
					: ""
			}`
		: "Name, or leave it to be named after the rule";

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={editing ? "Edit alert" : "New alert"}
			width="660px"
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
				<input
					className={styles.nameInput}
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={autoName}
					maxLength={120}
					aria-label="Name. Named after the rule if left blank."
					title="Named after the rule if left blank"
				/>

				<AssistPrompt
					kind="alert"
					state={() => ({ definition })}
					onDraft={applyDraft}
					sourceKey={sourceKey || undefined}
					placeholder="Tell me if weekly revenue in Europe falls more than 10%"
					label="Describe the alert"
				/>

				<div className={styles.block}>
					<span className={styles.blockLabel}>Rule</span>
					<div className={styles.sentence}>
						<span className={styles.words}>In</span>
						<Select
							className={`${styles.token} ${sourceKey ? "" : styles.tokenEmpty}`}
							bare
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
							placeholder="choose a dataset"
							searchable
							ariaLabel="Dataset"
						/>
						<span className={styles.words}>tell me when</span>
						<Select
							className={`${styles.token} ${measure ? "" : styles.tokenEmpty}`}
							bare
							options={(source?.measures ?? []).map((m) => ({
								value: m.name,
								label: m.displayName ?? m.name,
							}))}
							value={measure}
							onChange={setMeasure}
							placeholder="a measure"
							disabled={!source}
							searchable
							ariaLabel="Measure"
						/>
						<span className={styles.words}>for</span>
						<Select
							className={styles.token}
							bare
							options={[
								{ value: "", label: "the total" },
								...(source?.dimensions ?? []).map((d) => ({
									value: d.name,
									label: `each ${d.displayName ?? d.name}`,
								})),
							]}
							value={groupBy}
							onChange={setGroupBy}
							disabled={!source}
							searchable
							ariaLabel="Watch the total or each value of a field"
						/>
						{/* The comparison and its value wrap as one, so the number is
						    never left on a line of its own. */}
						<span className={styles.together}>
							<Select
								className={styles.token}
								bare
								options={conditions.map((c) => ({
									value: c,
									label: conditionLabel[c],
								}))}
								value={condition}
								onChange={(v) =>
									setCondition(v as AlertCondition)
								}
								ariaLabel="Condition"
							/>
							{needsThreshold(condition) && (
								<span className={styles.thresholdWrap}>
									<input
										className={styles.threshold}
										inputMode="decimal"
										value={threshold}
										onChange={(e) =>
											setThreshold(e.target.value)
										}
										placeholder={relative ? "10" : "value"}
										aria-label={
											relative ? "Percentage" : "Value"
										}
									/>
									{relative && (
										<span className={styles.unit}>%</span>
									)}
								</span>
							)}
						</span>
					</div>
					<span className={styles.fieldHint}>
						{crossing
							? "You are told once when it crosses, not on every check it stays there."
							: condition === "changes"
								? "Compared with the previous check."
								: "Compared with the previous check, as a percentage of it."}
						{groupBy
							? ` Each ${groupMeta?.displayName ?? groupBy} is checked on its own.`
							: ""}
					</span>
					{crossing && (
						<Toggle
							checked={notifyRecover}
							onChange={setNotifyRecover}
							label="Also tell me when it is back"
						/>
					)}
				</div>

				{source && (
					<div className={styles.block}>
						<span className={styles.blockLabel}>
							Only rows where
						</span>
						<div className={styles.chips}>
							{rowConditions.map((c, i) => (
								<span key={i} className={styles.chip}>
									{i > 0 && (
										<span className={styles.chipJoin}>
											{c.join}
										</span>
									)}
									<span
										className={styles.chipText}
										title={describeCondition(c, true)}
									>
										{describeCondition(c, true)}
									</span>
									<Remove
										label={`Remove ${describeCondition(c)}`}
										onClick={() =>
											setRowConditions((held) =>
												held.filter((_, j) => j !== i),
											)
										}
									/>
								</span>
							))}
							<input
								className={styles.chipInput}
								value={conditionText}
								onChange={(e) => {
									setConditionText(e.target.value);
									setConditionProblem(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										addCondition();
									}
									if (
										e.key === "Backspace" &&
										!conditionText &&
										rowConditions.length > 0
									) {
										setRowConditions((held) =>
											held.slice(0, -1),
										);
									}
								}}
								onBlur={() => {
									if (conditionText.trim()) addCondition();
								}}
								placeholder={
									rowConditions.length
										? "and another, then Enter"
										: "Every row. Type a condition such as Channel = Online"
								}
								aria-label="Add a condition"
							/>
						</div>
						<div className={styles.chipsFoot}>
							<span
								className={
									conditionProblem
										? styles.formError
										: styles.fieldHint
								}
							>
								{conditionProblem ??
									"Or with or, not and brackets, as in Explore."}
							</span>
							<Link
								href={exploreHref}
								className={styles.linkButton}
							>
								See the rows in Explore
							</Link>
						</div>
					</div>
				)}

				{sourceKey && measure && (
					<div className={styles.now} aria-live="polite">
						<div className={styles.nowHead}>
							<span className={styles.blockLabel}>Right now</span>
							{hasLine && preview && readings.length > 0 && (
								<span
									className={`${styles.pill} ${firingNow ? styles.pillHot : ""}`}
								>
									{groupBy
										? `${firingNow} of ${readings.length} would be reported`
										: firingNow
											? "Would be reported now"
											: "Would not be reported now"}
								</span>
							)}
							{relative && preview && (
								<span className={styles.pill}>
									The first check records the value to compare
									with
								</span>
							)}
						</div>

						{previewing && !preview ? (
							<span className={styles.fieldHint}>
								Reading the value
							</span>
						) : previewError ? (
							<span className={styles.formError}>
								{previewError}
							</span>
						) : preview ? (
							readings.length === 0 ? (
								<span className={styles.fieldHint}>
									Nothing matches the conditions.
								</span>
							) : groupBy ? (
								<>
									<ul className={styles.bars}>
										{readings
											.slice(0, shownGroups)
											.map((r, i) => (
												<li
													key={r.group ?? i}
													style={{
														display: "contents",
													}}
												>
													<span
														className={
															styles.barName
														}
														title={r.group ?? ""}
													>
														{r.group ?? "(blank)"}
													</span>
													<span
														className={
															styles.barTrack
														}
													>
														<span
															className={`${styles.barFill} ${
																meets(r.value)
																	? styles.barFillHot
																	: ""
															}`}
															style={{
																width: `${
																	(Math.abs(
																		r.value ??
																			0,
																	) /
																		scale) *
																	100
																}%`,
															}}
														/>
														{hasLine && (
															<span
																className={
																	styles.barLine
																}
																style={{
																	left: `${
																		(Math.abs(
																			line,
																		) /
																			scale) *
																		100
																	}%`,
																}}
																aria-hidden="true"
															/>
														)}
													</span>
													<span
														className={
															styles.barValue
														}
													>
														{preview.formatted[i]}
													</span>
												</li>
											))}
									</ul>
									{readings.length > shownGroups && (
										<span className={styles.more}>
											and {readings.length - shownGroups}{" "}
											more
										</span>
									)}
								</>
							) : (
								<span className={styles.nowBig}>
									{preview.formatted[0]}
								</span>
							)
						) : null}
					</div>
				)}

				<div className={styles.block}>
					<div className={styles.schedule}>
						<span className={styles.scheduleText}>
							{scheduleText(frequency, hour, weekday)},{" "}
							{timeZone.replace(/_/g, " ")}
						</span>
						<button
							type="button"
							className={styles.linkButton}
							onClick={() => setScheduleOpen((v) => !v)}
							aria-expanded={scheduleOpen}
						>
							{scheduleOpen ? "Done" : "Change"}
						</button>
					</div>
					{scheduleOpen && (
						<div className={styles.scheduleRow}>
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
									options={Array.from(
										{ length: 24 },
										(_, h) => ({
											value: String(h),
											label: hourLabel(h),
										}),
									)}
									value={String(hour)}
									onChange={(v) => setHour(Number(v))}
									ariaLabel="Time"
								/>
							)}
						</div>
					)}
				</div>
			</div>
		</Modal>
	);
}
