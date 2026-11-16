"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { WorkConfig } from "@/lib/work/model";
import { describeFetchError } from "@/lib/swr";
import { Select } from "../components/shared/Select";
import styles from "./WorkExtras.module.css";

// The queue's numbers for engineers. Throughput by week, what is open in each
// column, how long work sits in each column, cycle time, and how the effort
// sizes compare with what the work took.

interface MetricsAnswer {
	days: number;
	throughput: { week: string; done: number }[];
	cycle: {
		domain: string | null;
		work_type: string | null;
		median_days: number | null;
		count: number;
	}[];
	open: {
		status: string;
		count: number;
		blocked: number;
		oldest_days: number | null;
	}[];
	inStatus: { status: string; median_days: number | null }[];
	estimates: {
		effort: string;
		label: string;
		count: number;
		medianDays: number | null;
		estimatedDays: { min: number; max: number | null } | null;
	}[];
}

const rangeOptions = [
	{ value: "30", label: "Last 30 days" },
	{ value: "90", label: "Last 90 days" },
	{ value: "180", label: "Last 180 days" },
	{ value: "365", label: "Last 365 days" },
];

const dayMs = 86400000;

function formatDays(days: number | null | undefined): string {
	if (days === null || days === undefined || !Number.isFinite(days)) {
		return "No data";
	}
	if (days < 1) {
		const hours = Math.round(days * 24);
		return hours === 1 ? "1 hour" : `${hours} hours`;
	}
	const rounded = Math.round(days * 10) / 10;
	return rounded === 1 ? "1 day" : `${rounded} days`;
}

function formatSpan(span: { min: number; max: number | null } | null): string {
	if (!span) return "Not a configured size";
	const min = Math.round(span.min * 10) / 10;
	if (span.max === null) return `${min} days or more`;
	const max = Math.round(span.max * 10) / 10;
	return `${min} to ${max} days`;
}

// Monday of the week holding the given time, as YYYY-MM-DD in UTC. Matches
// the database's date_trunc('week'), which starts weeks on Monday.
function mondayOf(time: number): string {
	const date = new Date(time);
	const offset = (date.getUTCDay() + 6) % 7;
	const monday = new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth(),
			date.getUTCDate() - offset,
		),
	);
	return monday.toISOString().slice(0, 10);
}

// Every week in the range, with weeks that finished nothing shown as zero.
function fillWeeks(
	throughput: MetricsAnswer["throughput"],
	days: number,
): { week: string; done: number }[] {
	const counts = new Map(throughput.map((row) => [row.week, row.done]));
	const now = Date.now();
	const weeks: { week: string; done: number }[] = [];
	let cursor = Date.parse(`${mondayOf(now - days * dayMs)}T00:00:00Z`);
	const last = Date.parse(`${mondayOf(now)}T00:00:00Z`);
	while (cursor <= last) {
		const week = new Date(cursor).toISOString().slice(0, 10);
		weeks.push({ week, done: counts.get(week) ?? 0 });
		cursor += 7 * dayMs;
	}
	return weeks;
}

function shortDate(isoDay: string): string {
	const [year, month, day] = isoDay.split("-").map(Number);
	return new Date(year, month - 1, day).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

function ThroughputChart({
	weeks,
}: {
	weeks: { week: string; done: number }[];
}) {
	const width = 720;
	const height = 160;
	const top = 16;
	const bottom = 22;
	const left = 28;
	const plotHeight = height - top - bottom;
	const plotWidth = width - left;
	const peak = Math.max(1, ...weeks.map((w) => w.done));
	const slot = plotWidth / Math.max(1, weeks.length);
	const barWidth = Math.max(2, slot * 0.7);
	// Label about every sixth week so the dates do not overlap.
	const labelEvery = Math.max(1, Math.ceil(weeks.length / 6));
	const total = weeks.reduce((sum, w) => sum + w.done, 0);

	return (
		<svg
			className={styles.chart}
			viewBox={`0 0 ${width} ${height}`}
			role="img"
			aria-label={`Requests finished per week, ${total} in all`}
		>
			<line
				x1={left}
				x2={width}
				y1={top + plotHeight}
				y2={top + plotHeight}
				className={styles.chartAxis}
			/>
			<line
				x1={left}
				x2={width}
				y1={top}
				y2={top}
				className={styles.chartGrid}
			/>
			<text
				x={left - 6}
				y={top + 4}
				className={styles.chartLabel}
				textAnchor="end"
			>
				{peak}
			</text>
			<text
				x={left - 6}
				y={top + plotHeight}
				className={styles.chartLabel}
				textAnchor="end"
			>
				0
			</text>
			{weeks.map((w, index) => {
				const barHeight = (w.done / peak) * plotHeight;
				const x = left + index * slot + (slot - barWidth) / 2;
				return (
					<g key={w.week}>
						<rect
							x={x}
							y={top + plotHeight - barHeight}
							width={barWidth}
							height={barHeight}
							rx={2}
							className={styles.chartBar}
						>
							<title>{`Week of ${shortDate(w.week)}, ${w.done} finished`}</title>
						</rect>
						{index % labelEvery === 0 && (
							<text
								x={x + barWidth / 2}
								y={height - 6}
								className={styles.chartLabel}
								textAnchor="middle"
							>
								{shortDate(w.week)}
							</text>
						)}
					</g>
				);
			})}
		</svg>
	);
}

export function WorkMetrics({ config }: { config: WorkConfig }) {
	const [days, setDays] = useState("90");
	const { data, error, isLoading } = useSWR<MetricsAnswer>(
		`/api/work/metrics?days=${days}`,
	);

	const columnLabel = useMemo(() => {
		const labels = new Map(config.columns.map((c) => [c.id, c.label]));
		return (id: string) => labels.get(id) ?? id;
	}, [config.columns]);
	const domainLabel = useMemo(() => {
		const labels = new Map(config.domains.map((d) => [d.id, d.label]));
		return (id: string) => labels.get(id) ?? id;
	}, [config.domains]);
	const typeLabel = useMemo(() => {
		const labels = new Map(config.workTypes.map((t) => [t.id, t.label]));
		return (id: string) => labels.get(id) ?? id;
	}, [config.workTypes]);

	const weeks = useMemo(
		() => (data ? fillWeeks(data.throughput, data.days) : []),
		[data],
	);

	// Open work and time in column, in the order the board shows its columns.
	const columnOrder = useMemo(
		() => new Map(config.columns.map((c, index) => [c.id, index])),
		[config.columns],
	);
	const byColumn = <T extends { status: string }>(rows: T[]): T[] =>
		[...rows].sort(
			(a, b) =>
				(columnOrder.get(a.status) ?? Number.MAX_SAFE_INTEGER) -
				(columnOrder.get(b.status) ?? Number.MAX_SAFE_INTEGER),
		);

	const overall = data?.cycle.find(
		(row) => row.domain === null && row.work_type === null,
	);
	const byDomain = data?.cycle.filter((row) => row.domain !== null) ?? [];
	const byType = data?.cycle.filter((row) => row.work_type !== null) ?? [];
	const totalDone = weeks.reduce((sum, w) => sum + w.done, 0);

	return (
		<div className={styles.metrics}>
			<div className={styles.toolbar}>
				<h2 className={styles.heading}>Queue numbers</h2>
				<span className={styles.range}>
					<Select
						value={days}
						options={rangeOptions}
						ariaLabel="Date range"
						onChange={setDays}
					/>
				</span>
			</div>

			{error && (
				<p className={styles.empty}>
					{describeFetchError(error, "page")}
				</p>
			)}
			{!error && isLoading && !data && (
				<p className={styles.empty}>Loading the numbers.</p>
			)}

			{data && (
				<div className={styles.metricGrid}>
					<section className={`${styles.card} ${styles.wide}`}>
						<h3 className={styles.cardTitle}>Finished each week</h3>
						{totalDone === 0 ? (
							<p className={styles.empty}>
								Nothing was finished in this range.
							</p>
						) : (
							<>
								<p className={styles.cardNote}>
									{totalDone} finished in the last {data.days}{" "}
									days.
								</p>
								<ThroughputChart weeks={weeks} />
							</>
						)}
					</section>

					<section className={styles.card}>
						<h3 className={styles.cardTitle}>
							Open work by column
						</h3>
						{data.open.length === 0 ? (
							<p className={styles.empty}>Nothing is open.</p>
						) : (
							<div className={styles.tableWrap}>
								<table className={styles.table}>
									<thead>
										<tr>
											<th>Column</th>
											<th className={styles.number}>
												Open
											</th>
											<th className={styles.number}>
												Blocked
											</th>
											<th className={styles.number}>
												Oldest
											</th>
										</tr>
									</thead>
									<tbody>
										{byColumn(data.open).map((row) => (
											<tr key={row.status}>
												<td>
													{columnLabel(row.status)}
												</td>
												<td className={styles.number}>
													{row.count}
												</td>
												<td className={styles.number}>
													{row.blocked > 0 ? (
														<span
															className={
																styles.blockedCount
															}
														>
															{row.blocked}
														</span>
													) : (
														0
													)}
												</td>
												<td className={styles.number}>
													{formatDays(
														row.oldest_days,
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>

					<section className={styles.card}>
						<h3 className={styles.cardTitle}>
							Typical time in each column
						</h3>
						{data.inStatus.length === 0 ? (
							<p className={styles.empty}>
								No request moved on from a column in this range.
							</p>
						) : (
							<div className={styles.tableWrap}>
								<table className={styles.table}>
									<thead>
										<tr>
											<th>Column</th>
											<th className={styles.number}>
												Median time
											</th>
										</tr>
									</thead>
									<tbody>
										{byColumn(data.inStatus).map((row) => (
											<tr key={row.status}>
												<td>
													{columnLabel(row.status)}
												</td>
												<td className={styles.number}>
													{formatDays(
														row.median_days,
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>

					<section className={styles.card}>
						<h3 className={styles.cardTitle}>Cycle time</h3>
						<p className={styles.cardNote}>
							From starting work to done, the median across
							finished requests.
						</p>
						{!overall || overall.count === 0 ? (
							<p className={styles.empty}>
								No started request was finished in this range.
							</p>
						) : (
							<>
								<p className={styles.bigFigure}>
									{formatDays(overall.median_days)}
									<span className={styles.bigFigureNote}>
										across {overall.count}{" "}
										{overall.count === 1
											? "request"
											: "requests"}
									</span>
								</p>
								<CycleTable
									title="By domain"
									rows={byDomain.map((row) => ({
										key: row.domain as string,
										label: domainLabel(
											row.domain as string,
										),
										medianDays: row.median_days,
										count: row.count,
									}))}
									emptyText="No finished request had a domain."
								/>
								<CycleTable
									title="By work type"
									rows={byType.map((row) => ({
										key: row.work_type as string,
										label: typeLabel(
											row.work_type as string,
										),
										medianDays: row.median_days,
										count: row.count,
									}))}
									emptyText="No finished request had a work type."
								/>
							</>
						)}
					</section>

					<section className={styles.card}>
						<h3 className={styles.cardTitle}>
							Estimates against actual
						</h3>
						<p className={styles.cardNote}>
							Each effort size as working days of eight hours, set
							against the median time finished requests of that
							size took.
						</p>
						{data.estimates.length === 0 ? (
							<p className={styles.empty}>
								No finished request had an effort set.
							</p>
						) : (
							<div className={styles.tableWrap}>
								<table className={styles.table}>
									<thead>
										<tr>
											<th>Effort</th>
											<th>Estimated</th>
											<th className={styles.number}>
												Actual median
											</th>
											<th className={styles.number}>
												Requests
											</th>
										</tr>
									</thead>
									<tbody>
										{sortEstimates(
											data.estimates,
											config,
										).map((row) => {
											const runsLong =
												row.estimatedDays?.max !==
													null &&
												row.estimatedDays?.max !==
													undefined &&
												row.medianDays !== null &&
												row.medianDays >
													row.estimatedDays.max;
											return (
												<tr key={row.effort}>
													<td>{row.label}</td>
													<td>
														{formatSpan(
															row.estimatedDays,
														)}
													</td>
													<td
														className={
															styles.number
														}
													>
														{formatDays(
															row.medianDays,
														)}
														{runsLong && (
															<span
																className={
																	styles.runsLong
																}
															>
																Runs longer than
																estimated
															</span>
														)}
													</td>
													<td
														className={
															styles.number
														}
													>
														{row.count}
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						)}
					</section>
				</div>
			)}
		</div>
	);
}

// Effort sizes in the order the configuration lists them, smallest first.
function sortEstimates(
	rows: MetricsAnswer["estimates"],
	config: WorkConfig,
): MetricsAnswer["estimates"] {
	const order = new Map(config.efforts.map((e, index) => [e.id, index]));
	return [...rows].sort(
		(a, b) =>
			(order.get(a.effort) ?? Number.MAX_SAFE_INTEGER) -
			(order.get(b.effort) ?? Number.MAX_SAFE_INTEGER),
	);
}

function CycleTable({
	title,
	rows,
	emptyText,
}: {
	title: string;
	rows: {
		key: string;
		label: string;
		medianDays: number | null;
		count: number;
	}[];
	emptyText: string;
}) {
	const sorted = [...rows].sort((a, b) => a.label.localeCompare(b.label));
	return (
		<div className={styles.subTable}>
			<h4 className={styles.subTitle}>{title}</h4>
			{sorted.length === 0 ? (
				<p className={styles.empty}>{emptyText}</p>
			) : (
				<div className={styles.tableWrap}>
					<table className={styles.table}>
						<thead>
							<tr>
								<th>Name</th>
								<th className={styles.number}>Median</th>
								<th className={styles.number}>Requests</th>
							</tr>
						</thead>
						<tbody>
							{sorted.map((row) => (
								<tr key={row.key}>
									<td>{row.label}</td>
									<td className={styles.number}>
										{formatDays(row.medianDays)}
									</td>
									<td className={styles.number}>
										{row.count}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
