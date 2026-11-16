"use client";

import { useMemo, useState } from "react";
import type { WorkConfig } from "@/lib/work/model";
import type { WorkSummary } from "@/lib/work/store";
import styles from "./WorkExtras.module.css";

// Requests on a month grid by target date, weeks starting on Monday. Requests
// without a target are listed under the grid.

const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const priorityClass: Record<string, string | undefined> = {
	urgent: styles.chipUrgent,
	high: styles.chipHigh,
	medium: styles.chipMedium,
	low: styles.chipLow,
};

// A local date as YYYY-MM-DD, so a cell's key matches a stored target date.
function dayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

// Every day shown for a month, from the Monday on or before the first through
// the Sunday on or after the last, so the grid is whole weeks.
function monthDays(year: number, month: number): Date[] {
	const first = new Date(year, month, 1);
	const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
	const last = new Date(year, month + 1, 0);
	const end = new Date(year, month + 1, (7 - last.getDay()) % 7);
	const days: Date[] = [];
	for (
		let cursor = start;
		cursor <= end;
		cursor = new Date(
			cursor.getFullYear(),
			cursor.getMonth(),
			cursor.getDate() + 1,
		)
	) {
		days.push(cursor);
	}
	return days;
}

function BlockedIcon() {
	return (
		<svg
			className={styles.chipIcon}
			width="11"
			height="11"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			aria-hidden="true"
		>
			<circle cx="8" cy="8" r="6" />
			<path d="M3.8 12.2l8.4-8.4" />
		</svg>
	);
}

function Chevron({ direction }: { direction: "left" | "right" }) {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={direction === "left" ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"} />
		</svg>
	);
}

function ItemChip({
	item,
	priorityLabel,
	onOpen,
}: {
	item: WorkSummary;
	priorityLabel: string | null;
	onOpen: (key: string) => void;
}) {
	const tone =
		(item.priority && priorityClass[item.priority]) || styles.chipNone;
	const described = [
		item.key,
		item.title,
		priorityLabel ? `${priorityLabel} priority` : null,
		item.blocked ? "Blocked" : null,
	]
		.filter(Boolean)
		.join(", ");
	return (
		<button
			type="button"
			className={`${styles.chip} ${tone} ${item.blocked ? styles.chipBlocked : ""}`}
			onClick={() => onOpen(item.key)}
			title={
				item.blocked && item.blockedReason
					? `${described}. ${item.blockedReason}`
					: described
			}
			aria-label={described}
		>
			{item.blocked && <BlockedIcon />}
			<span className={styles.chipKey}>{item.key}</span>
			<span className={styles.chipTitle}>{item.title}</span>
		</button>
	);
}

export function WorkCalendar({
	items,
	config,
	onOpen,
}: {
	items: WorkSummary[];
	config: WorkConfig;
	onOpen: (key: string) => void;
}) {
	const today = new Date();
	const [shown, setShown] = useState({
		year: today.getFullYear(),
		month: today.getMonth(),
	});

	const priorityLabels = useMemo(
		() => new Map(config.priorities.map((p) => [p.id, p.label])),
		[config.priorities],
	);
	const priorityRank = useMemo(
		() => new Map(config.priorities.map((p, index) => [p.id, index])),
		[config.priorities],
	);

	// Items grouped by target day, most pressing priority first within a day.
	const { byDay, undated } = useMemo(() => {
		const rank = (item: WorkSummary) =>
			item.priority !== null
				? (priorityRank.get(item.priority) ?? Number.MAX_SAFE_INTEGER)
				: Number.MAX_SAFE_INTEGER;
		const sorted = [...items].sort(
			(a, b) => rank(a) - rank(b) || a.number - b.number,
		);
		const grouped = new Map<string, WorkSummary[]>();
		const noTarget: WorkSummary[] = [];
		for (const item of sorted) {
			if (!item.target) {
				noTarget.push(item);
				continue;
			}
			const key = item.target.slice(0, 10);
			const list = grouped.get(key);
			if (list) list.push(item);
			else grouped.set(key, [item]);
		}
		return { byDay: grouped, undated: noTarget };
	}, [items, priorityRank]);

	const days = useMemo(
		() => monthDays(shown.year, shown.month),
		[shown.year, shown.month],
	);
	const todayKey = dayKey(today);
	const monthTitle = new Date(shown.year, shown.month, 1).toLocaleDateString(
		undefined,
		{ month: "long", year: "numeric" },
	);
	const inMonth = days.filter(
		(day) => day.getMonth() === shown.month && byDay.has(dayKey(day)),
	).length;

	const move = (step: number) =>
		setShown(({ year, month }) => {
			const next = new Date(year, month + step, 1);
			return { year: next.getFullYear(), month: next.getMonth() };
		});

	const priorityLabel = (item: WorkSummary) =>
		item.priority
			? (priorityLabels.get(item.priority) ?? item.priority)
			: null;

	return (
		<div className={styles.calendar}>
			<div className={styles.toolbar}>
				<h2 className={styles.heading} aria-live="polite">
					{monthTitle}
				</h2>
				<div className={styles.calendarNav}>
					<button
						type="button"
						className={styles.iconButton}
						onClick={() => move(-1)}
						aria-label="Previous month"
					>
						<Chevron direction="left" />
					</button>
					<button
						type="button"
						className={styles.button}
						onClick={() =>
							setShown({
								year: today.getFullYear(),
								month: today.getMonth(),
							})
						}
					>
						Today
					</button>
					<button
						type="button"
						className={styles.iconButton}
						onClick={() => move(1)}
						aria-label="Next month"
					>
						<Chevron direction="right" />
					</button>
				</div>
			</div>

			<div className={styles.legend} aria-hidden="true">
				{config.priorities.map((p) => (
					<span key={p.id} className={styles.legendItem}>
						<span
							className={`${styles.legendSwatch} ${priorityClass[p.id] ?? styles.chipNone}`}
						/>
						{p.label}
					</span>
				))}
				<span className={styles.legendItem}>
					<BlockedIcon />
					Blocked
				</span>
			</div>

			<div className={styles.monthGrid}>
				{weekdayNames.map((name) => (
					<div key={name} className={styles.weekday}>
						{name}
					</div>
				))}
				{days.map((day) => {
					const key = dayKey(day);
					const dayItems = byDay.get(key) ?? [];
					const outside = day.getMonth() !== shown.month;
					const classes = [
						styles.dayCell,
						outside ? styles.dayOutside : "",
						key === todayKey ? styles.dayToday : "",
						dayItems.length === 0 ? styles.dayEmpty : "",
					]
						.filter(Boolean)
						.join(" ");
					return (
						<div key={key} className={classes}>
							<span className={styles.dayNumber}>
								<span className={styles.dayWeekday}>
									{day.toLocaleDateString(undefined, {
										weekday: "short",
									})}{" "}
								</span>
								{day.getDate()}
							</span>
							<div className={styles.dayItems}>
								{dayItems.map((item) => (
									<ItemChip
										key={item.id}
										item={item}
										priorityLabel={priorityLabel(item)}
										onOpen={onOpen}
									/>
								))}
							</div>
						</div>
					);
				})}
			</div>
			{inMonth === 0 && (
				<p className={styles.empty}>Nothing is due this month.</p>
			)}

			<section className={styles.undated}>
				<h3 className={styles.cardTitle}>No target yet</h3>
				{undated.length === 0 ? (
					<p className={styles.empty}>
						Every request here has a target date.
					</p>
				) : (
					<div className={styles.undatedList}>
						{undated.map((item) => (
							<ItemChip
								key={item.id}
								item={item}
								priorityLabel={priorityLabel(item)}
								onOpen={onOpen}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
