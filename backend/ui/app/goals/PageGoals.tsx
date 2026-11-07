"use client";

import { useState } from "react";
import useSWR from "swr";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { Sparkline } from "../visuals/Sparkline";
import { formatCompact, type FormatHint } from "../../lib/format";
import form from "../authoring/Authoring.module.css";
import styles from "./Goals.module.css";

// Goals on the report, on the pages showing their measure. Read here and looked after in the
// editor. See GoalsPanel. The figures are the reader's own, so progress can differ between people.

export interface Goal {
	goalId: string;
	title: string;
	sourceKey: string;
	measure: string;
	filter: { field: string; value: string } | null;
	formatHint: FormatHint;
	target: number;
	createdBy: string;
	dueOn: string | null;
	onAnyPage: boolean;
	// Absent on a goal listed in the editor without its figure being read.
	current?: number | null;
	history?: { day: string; value: number }[];
	status?: {
		percent: number;
		expectedPercent: number | null;
		state: "done" | "onTrack" | "behind" | "late";
	} | null;
}

interface MeasureChoice {
	sourceKey: string;
	sourceTitle: string;
	measure: string;
	fields: string[];
}

interface GoalsAnswer {
	goals: Goal[];
	all: Goal[];
	measures: MeasureChoice[];
	canManage: boolean;
}

const stateWords = {
	done: "Reached",
	onTrack: "On track",
	behind: "Behind",
	late: "Past due",
};

const goalsAddress = (pageId: string) =>
	`/api/goals?pageId=${encodeURIComponent(pageId)}`;

export function useGoals(pageId: string | null) {
	return useSWR<GoalsAnswer>(pageId ? goalsAddress(pageId) : null, {
		dedupingInterval: 5000,
	});
}

export async function postGoal(body: Record<string, unknown>) {
	const response = await fetch("/api/goals", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const detail = await response.json().catch(() => null);
	if (!response.ok) throw new Error(detail?.error ?? "That did not work.");
	return detail;
}

const choiceKey = (choice: { sourceKey: string; measure: string }) =>
	`${choice.sourceKey}|${choice.measure}`;

export function GoalDialog({
	pageId,
	measures,
	start,
	onSaved,
	onClose,
}: {
	pageId: string;
	measures: MeasureChoice[];
	start: Goal | null;
	onSaved: () => void;
	onClose: () => void;
}) {
	const [title, setTitle] = useState(start?.title ?? "");
	const [chosen, setChosen] = useState(
		start ? choiceKey(start) : measures[0] ? choiceKey(measures[0]) : "",
	);
	const [target, setTarget] = useState(start ? String(start.target) : "");
	const [dueOn, setDueOn] = useState((start?.dueOn ?? "").slice(0, 10));
	const [filterField, setFilterField] = useState(start?.filter?.field ?? "");
	const [filterValue, setFilterValue] = useState(start?.filter?.value ?? "");
	const [failure, setFailure] = useState<string | null>(null);
	const choice = measures.find((held) => choiceKey(held) === chosen);
	const needsSource = new Set(measures.map((m) => m.sourceKey)).size > 1;

	const { data: values } = useSWR<{ values: string[] }>(
		choice && filterField
			? ["/api/query/values", choice.sourceKey, filterField]
			: null,
		async () => {
			const response = await fetch("/api/query/values", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sourceKey: choice?.sourceKey,
					field: filterField,
					limit: 200,
				}),
			});
			return response.ok ? response.json() : { values: [] };
		},
	);

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={start ? "Change this goal" : "Set a goal"}
			width="560px"
		>
			<div className={form.form}>
				<label className={form.field}>
					<span className={form.label}>Name</span>
					<input
						className={form.input}
						value={title}
						autoFocus
						placeholder="Reach this quarter's revenue"
						onChange={(e) => setTitle(e.target.value)}
					/>
				</label>
				<label className={form.field}>
					<span className={form.label}>Measure</span>
					<Select
						value={chosen}
						searchable={measures.length > 12}
						onChange={(next) => {
							setChosen(next);
							setFilterField("");
							setFilterValue("");
						}}
						options={measures.map((held) => ({
							value: choiceKey(held),
							label: needsSource
								? `${held.measure}, ${held.sourceTitle}`
								: held.measure,
						}))}
					/>
				</label>
				<div className={form.row}>
					<label className={form.field}>
						<span className={form.label}>Target</span>
						<input
							type="number"
							className={form.input}
							value={target}
							onChange={(e) => setTarget(e.target.value)}
						/>
					</label>
					<label className={form.field}>
						<span className={form.label}>Due</span>
						<input
							type="date"
							className={form.input}
							value={dueOn}
							onChange={(e) => setDueOn(e.target.value)}
						/>
					</label>
				</div>
				<div className={form.row}>
					<label className={form.field}>
						<span className={form.label}>Only for</span>
						<Select
							value={filterField}
							searchable={(choice?.fields.length ?? 0) > 12}
							onChange={(next) => {
								setFilterField(next);
								setFilterValue("");
							}}
							options={[
								{ value: "", label: "Everything" },
								...(choice?.fields ?? []).map((field) => ({
									value: field,
									label: field,
								})),
							]}
						/>
					</label>
					{filterField && (
						<label className={form.field}>
							<span className={form.label}>Value</span>
							<Select
								value={filterValue}
								placeholder="Choose one"
								searchable
								onChange={setFilterValue}
								options={(values?.values ?? []).map(
									(value) => ({
										value,
										label: value,
									}),
								)}
							/>
						</label>
					)}
				</div>
				{failure && <div className={form.failure}>{failure}</div>}
				<div className={form.actions}>
					<button
						type="button"
						className={form.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={form.primary}
						disabled={
							!title.trim() ||
							!choice ||
							target === "" ||
							Boolean(filterField && !filterValue)
						}
						onClick={async () => {
							setFailure(null);
							try {
								await postGoal({
									action: "save",
									pageId,
									goalId: start?.goalId,
									title,
									sourceKey: choice?.sourceKey,
									measure: choice?.measure,
									target: Number(target),
									dueOn: dueOn || null,
									filter: filterField
										? {
												field: filterField,
												value: filterValue,
											}
										: null,
								});
								onSaved();
							} catch (error) {
								setFailure(
									error instanceof Error
										? error.message
										: "That did not save.",
								);
							}
						}}
					>
						Save
					</button>
				</div>
			</div>
		</Modal>
	);
}

// The goals on this page's measures, above its visuals.
export function PageGoals({ pageId }: { pageId: string | null }) {
	const { data } = useGoals(pageId);
	const goals = data?.goals ?? [];
	if (goals.length === 0) return null;

	return (
		<section className={styles.strip} aria-label="Goals on this page">
			{goals.map((goal) => (
				<div key={goal.goalId} className={styles.goal}>
					<div className={styles.goalHead}>
						<strong className={styles.goalTitle}>
							{goal.title}
						</strong>
						{goal.status && (
							<span
								className={`${styles.state} ${styles[`state${goal.status.state}`]}`}
							>
								{stateWords[goal.status.state]}
							</span>
						)}
					</div>
					<p className={styles.figures}>
						<strong>
							{formatCompact(goal.current, goal.formatHint)}
						</strong>{" "}
						of {formatCompact(goal.target, goal.formatHint)}
					</p>
					{goal.status && (
						<div className={styles.bar} aria-hidden="true">
							<div
								className={styles.fill}
								style={{
									width: `${Math.max(0, Math.min(goal.status.percent, 100))}%`,
								}}
							/>
							{goal.status.expectedPercent !== null && (
								<div
									className={styles.expected}
									title="Where a steady line says it should be by now"
									style={{
										left: `${Math.min(goal.status.expectedPercent, 100)}%`,
									}}
								/>
							)}
						</div>
					)}
					<div className={styles.goalFoot}>
						<span className={styles.muted}>
							{goal.measure}
							{goal.filter ? `, ${goal.filter.value}` : ""}
							{goal.dueOn
								? `, due ${new Date(goal.dueOn).toLocaleDateString()}`
								: ""}
							. Set by {goal.createdBy}.
						</span>
						{(goal.history?.length ?? 0) > 1 && (
							<Sparkline
								values={(goal.history ?? []).map(
									(point) => point.value,
								)}
								label={`${goal.title} over time`}
							/>
						)}
					</div>
				</div>
			))}
		</section>
	);
}
