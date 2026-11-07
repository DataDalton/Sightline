"use client";

import { useEffect, useState } from "react";
import Link from "../components/AppLink";
import { Modal } from "../components/shared/Modal";
import { formatValue, type FormatHint } from "../../lib/format";
import { wouldHaveToBe } from "../../lib/insight/insight";
import frameStyles from "./Visual.module.css";
import styles from "./Behind.module.css";

// A way to see what is behind a visual's figure, all in one place.

interface Behind {
	measure: string;
	sourceTitle: string;
	description: string | null;
	formatHint: FormatHint | null;
	expression: string | null;
	total: unknown;
	computedAt: number;
	lastLoad: string | null;
	filters: {
		field?: string;
		op?: string;
		value?: unknown;
		values?: unknown[];
	}[];
	breakdowns: { field: string; rows: { label: string; value: number }[] }[];
	rows: Record<string, unknown>[] | null;
	updates: { updateId: string; title: string; postedOn: string }[];
	failingRules: { name: string }[];
}

function filterWords(filter: Behind["filters"][number]): string {
	const values = Array.isArray(filter.values)
		? filter.values.join(", ")
		: String(filter.value ?? "");
	if (filter.op === "eq") return `${filter.field} is ${values}`;
	return `${filter.field} ${filter.op} ${values}`.trim();
}

function WouldHaveToBeSection({
	data,
	hint,
}: {
	data: Behind;
	hint: FormatHint;
}) {
	const [target, setTarget] = useState("");
	const [field, setField] = useState(data.breakdowns[0]?.field ?? "");
	const current = Number(data.total);
	const wanted = Number(target);
	const parts =
		data.breakdowns.find((b) => b.field === field)?.rows.slice(0, 8) ?? [];
	const answer =
		target !== "" && Number.isFinite(wanted) && Number.isFinite(current)
			? wouldHaveToBe(current, wanted, parts)
			: null;
	return (
		<section className={styles.section}>
			<h3 className={styles.heading}>What would have to be true</h3>
			<div className={styles.targetRow}>
				<input
					type="number"
					className={styles.select}
					value={target}
					placeholder="A target"
					aria-label="A target"
					onChange={(e) => setTarget(e.target.value)}
				/>
				<select
					className={styles.select}
					value={field}
					aria-label="Split by"
					onChange={(e) => setField(e.target.value)}
				>
					{data.breakdowns.map((b) => (
						<option key={b.field} value={b.field}>
							By {b.field}
						</option>
					))}
				</select>
			</div>
			{answer && (
				<>
					<p>
						That is {formatValue(answer.gap, hint)} from here
						{answer.everyonePercent !== null
							? `, or everything moving ${answer.everyonePercent.toFixed(1)}%`
							: ""}
						. If one alone had to do it:
					</p>
					<table className={styles.table}>
						<tbody>
							{answer.singles.map((single) => (
								<tr key={single.label}>
									<td>{single.label}</td>
									<td className={styles.number}>
										{formatValue(single.current, hint)} to{" "}
										{formatValue(single.needed, hint)}
									</td>
									<td className={styles.number}>
										{single.percent !== null
											? `${single.percent > 0 ? "+" : ""}${single.percent.toFixed(0)}%`
											: ""}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</section>
	);
}

function BehindDialog({
	sourceKey,
	measures,
	filters,
	onClose,
}: {
	sourceKey: string;
	measures: string[];
	filters: unknown[];
	onClose: () => void;
}) {
	const [measure, setMeasure] = useState(measures[0]);
	const [data, setData] = useState<Behind | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	useEffect(() => {
		let current = true;
		setData(null);
		setFailure(null);
		void fetch("/api/behind", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sourceKey, measure, filters }),
		})
			.then(async (response) => {
				const detail = await response.json().catch(() => null);
				if (!current) return;
				if (!response.ok) {
					setFailure(detail?.error ?? "This could not be loaded.");
				} else {
					setData(detail);
				}
			})
			.catch(() => {
				if (current) setFailure("This could not be loaded.");
			});
		return () => {
			current = false;
		};
		// The filters are fixed from when this opened, and a fresh array each render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sourceKey, measure]);

	const hint = data?.formatHint ?? "decimal";

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={`Behind ${measure}`}
			width="720px"
		>
			<div className={styles.body}>
				{measures.length > 1 && (
					<select
						className={styles.select}
						value={measure}
						aria-label="Which figure"
						onChange={(e) => setMeasure(e.target.value)}
					>
						{measures.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
				)}
				{failure && <p className={styles.failure}>{failure}</p>}
				{!data && !failure && (
					<p className={styles.muted}>Working it out.</p>
				)}
				{data && (
					<>
						<p className={styles.total}>
							{formatValue(data.total as never, hint)}
						</p>
						<p className={styles.muted}>
							From {data.sourceTitle}. Worked out{" "}
							{new Date(data.computedAt).toLocaleString()}
							{data.lastLoad
								? `, from data last loaded ${new Date(data.lastLoad).toLocaleString()}`
								: ""}
							.
						</p>

						<section className={styles.section}>
							<h3 className={styles.heading}>What it means</h3>
							<p>
								{data.description ??
									"Nobody has written a definition for this yet."}
							</p>
							{data.expression && (
								<code className={styles.code}>
									{data.expression}
								</code>
							)}
						</section>

						<section className={styles.section}>
							<h3 className={styles.heading}>
								Filters in effect
							</h3>
							{data.filters.length === 0 ? (
								<p className={styles.muted}>
									None. This is everything you can see.
								</p>
							) : (
								<ul className={styles.list}>
									{data.filters.map((filter, index) => (
										<li key={index}>
											{filterWords(filter)}
										</li>
									))}
								</ul>
							)}
						</section>

						{(data.updates.length > 0 ||
							data.failingRules.length > 0) && (
							<section className={styles.section}>
								<h3 className={styles.heading}>
									Worth knowing
								</h3>
								<ul className={styles.list}>
									{data.failingRules.map((rule) => (
										<li key={rule.name}>
											Failing a data rule: {rule.name}
										</li>
									))}
									{data.updates.map((update) => (
										<li key={update.updateId}>
											<Link
												href={`/status?tab=updates&open=${update.updateId}`}
											>
												{update.title}
											</Link>
										</li>
									))}
								</ul>
							</section>
						)}

						<WouldHaveToBeSection data={data} hint={hint} />

						{data.breakdowns.map((breakdown) => (
							<section
								key={breakdown.field}
								className={styles.section}
							>
								<h3 className={styles.heading}>
									By {breakdown.field}
								</h3>
								<table className={styles.table}>
									<tbody>
										{breakdown.rows
											.slice(0, 8)
											.map((row) => (
												<tr key={row.label}>
													<td>{row.label}</td>
													<td
														className={
															styles.number
														}
													>
														{formatValue(
															row.value,
															hint,
														)}
													</td>
												</tr>
											))}
									</tbody>
								</table>
							</section>
						))}

						{data.rows && data.rows.length > 0 && (
							<section className={styles.section}>
								<h3 className={styles.heading}>The rows</h3>
								<div className={styles.rowsWrap}>
									<table className={styles.table}>
										<thead>
											<tr>
												{Object.keys(data.rows[0]).map(
													(name) => (
														<th key={name}>
															{name}
														</th>
													),
												)}
											</tr>
										</thead>
										<tbody>
											{data.rows.map((row, index) => (
												<tr key={index}>
													{Object.keys(row).map(
														(name) => (
															<td key={name}>
																{String(
																	row[name] ??
																		"",
																)}
															</td>
														),
													)}
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</section>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}

export function BehindAction({
	sourceKey,
	measures,
	filters,
}: {
	sourceKey: string | null | undefined;
	measures: string[];
	filters: unknown[];
}) {
	const [open, setOpen] = useState(false);
	if (!sourceKey || measures.length === 0) return null;
	return (
		<>
			<button
				type="button"
				className={frameStyles.frameAction}
				title="What's behind this number"
				aria-label="What's behind this number"
				onClick={() => setOpen(true)}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<circle cx="12" cy="12" r="9" />
					<path d="M12 11v5M12 8h.01" />
				</svg>
			</button>
			{open && (
				<BehindDialog
					sourceKey={sourceKey}
					measures={measures}
					filters={filters}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
