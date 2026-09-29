"use client";

import { useEffect, useState } from "react";
import type { Breakdown } from "../../lib/explain/drivers";
import { formatCompact, formatDelta, type FormatHint } from "../../lib/format";
import { Modal } from "../components/shared/Modal";
import styles from "./Explain.module.css";

// Why a figure changed, from the figure on a scorecard.
//
// The change is split by each way of cutting the data, and the cuts where one
// part carries most of the change come first: "Europe, down 410K, 70% of the
// drop". Clicking a part looks inside it, so a drop in Europe can be followed
// to the channel or the product within Europe that moved. What is listed is
// where the change sits in the data, not a reason for it.

interface Answer {
	current: number | null;
	previous: number | null;
	change: number;
	additive: boolean;
	breakdowns: Breakdown[];
	skipped: string[];
}

interface Drill {
	field: string;
	value: string;
}

// Splits shown before the rest wait behind a button.
const firstShown = 3;

export function ExplainDialog({
	sourceKey,
	measure,
	hint,
	filters,
	previousFilters,
	against,
	onClose,
}: {
	sourceKey: string;
	measure: string;
	hint: FormatHint;
	filters: unknown[];
	previousFilters: unknown[];
	// The earlier period in words, such as "the period before".
	against: string;
	onClose: () => void;
}) {
	const [drill, setDrill] = useState<Drill[]>([]);
	const [answer, setAnswer] = useState<Answer | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [showAll, setShowAll] = useState(false);

	const drillKey = JSON.stringify(drill);
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		void (async () => {
			try {
				const response = await fetch("/api/explain", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sourceKey,
						measure,
						filters,
						previousFilters,
						drill,
					}),
					signal: controller.signal,
				});
				const body = await response.json();
				if (!response.ok) {
					setError(
						body?.error ?? "The change could not be broken down.",
					);
					setAnswer(null);
				} else {
					setAnswer(body);
					setShowAll(false);
				}
			} catch (e) {
				if ((e as Error).name !== "AbortError") {
					setError("The change could not be broken down.");
				}
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [drillKey]);

	const change = answer?.change ?? 0;
	const relative =
		answer?.previous && answer.previous !== 0
			? (change / Math.abs(answer.previous)) * 100
			: null;
	const direction = change > 0 ? "up" : change < 0 ? "down" : "unchanged";

	const splits = answer?.breakdowns ?? [];
	const shown = showAll ? splits : splits.slice(0, firstShown);
	// Every bar in the dialog on one scale, so a long bar in one split means
	// the same as a long bar in another.
	const scale = Math.max(
		...splits.flatMap((b) => b.members.map((m) => Math.abs(m.change))),
		1e-9,
	);

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={`Why ${measure} changed`}
			width="720px"
		>
			<div className={styles.body}>
				<div className={styles.summary}>
					{answer && (
						<>
							<span className={styles.figure}>
								{formatCompact(answer.current, hint)}
							</span>
							<span
								className={`${styles.change} ${
									change > 0
										? styles.up
										: change < 0
											? styles.down
											: ""
								}`}
							>
								{direction === "unchanged"
									? "no change"
									: `${direction} ${formatDelta(Math.abs(change), hint).replace(/^\+/, "")}${
											relative !== null
												? ` (${relative > 0 ? "+" : ""}${relative.toFixed(1)}%)`
												: ""
										}`}
							</span>
							<span className={styles.against}>
								against {against}, from{" "}
								{formatCompact(answer.previous, hint)}
							</span>
						</>
					)}
				</div>

				{drill.length > 0 && (
					<div className={styles.trail}>
						<button
							type="button"
							className={styles.trailButton}
							onClick={() => setDrill([])}
						>
							Everything
						</button>
						{drill.map((d, i) => (
							<span
								key={`${d.field}:${d.value}`}
								className={styles.trailStep}
							>
								<span aria-hidden="true">›</span>
								<button
									type="button"
									className={styles.trailButton}
									onClick={() =>
										setDrill(drill.slice(0, i + 1))
									}
									aria-current={
										i === drill.length - 1
											? "true"
											: undefined
									}
								>
									{d.field} is {d.value}
								</button>
							</span>
						))}
					</div>
				)}

				{answer && !answer.additive && (
					<p className={styles.note}>
						{measure} is a rate or an average rather than a total,
						so each part below shows its own {measure} changing, and
						the parts do not add up to the whole.
					</p>
				)}

				{loading ? (
					<p className={styles.muted}>
						Comparing the two periods split every way the data
						allows.
					</p>
				) : error ? (
					<p className={styles.error}>{error}</p>
				) : answer && change === 0 && answer.additive ? (
					<p className={styles.muted}>
						{measure} is the same in both periods, so there is no
						change to break down.
					</p>
				) : splits.length === 0 ? (
					<p className={styles.muted}>
						There is nothing left to split this by.
					</p>
				) : (
					<>
						{shown.map((split) => (
							<section
								key={split.dimension}
								className={styles.split}
							>
								<h3 className={styles.splitTitle}>
									By {split.dimension}
								</h3>
								<ul className={styles.rows}>
									{split.members.map((m) => (
										<li key={m.value}>
											<button
												type="button"
												className={styles.row}
												onClick={() =>
													setDrill([
														...drill,
														{
															field: split.dimension,
															value: m.value,
														},
													])
												}
												title={`Look inside ${m.value}`}
											>
												<span className={styles.name}>
													{m.value}
												</span>
												<span
													className={styles.track}
													aria-hidden="true"
												>
													<span
														className={styles.axis}
													/>
													<span
														className={`${styles.bar} ${
															m.change < 0
																? styles.barDown
																: styles.barUp
														}`}
														style={
															m.change < 0
																? {
																		right: "50%",
																		width: `${(Math.abs(m.change) / scale) * 50}%`,
																	}
																: {
																		left: "50%",
																		width: `${(m.change / scale) * 50}%`,
																	}
														}
													/>
												</span>
												<span className={styles.amount}>
													{formatDelta(
														m.change,
														hint,
													)}
													<span
														className={
															styles.detail
														}
													>
														{m.share !== null
															? `${Math.round(m.share * 100)}% of the change`
															: `${formatCompact(m.previous, hint)} to ${formatCompact(m.current, hint)}`}
													</span>
												</span>
											</button>
										</li>
									))}
								</ul>
								{split.othersCount > 0 && (
									<p className={styles.others}>
										{split.othersCount} other{" "}
										{split.othersCount === 1
											? "value"
											: "values"}{" "}
										{answer?.additive
											? `together ${formatDelta(split.othersChange, hint)}`
											: "moved less"}
									</p>
								)}
							</section>
						))}
						{splits.length > firstShown && !showAll && (
							<button
								type="button"
								className={styles.more}
								onClick={() => setShowAll(true)}
							>
								{splits.length - firstShown} more ways to split
								it
							</button>
						)}
					</>
				)}

				<p className={styles.footnote}>
					This shows where in the data the change sits. Click a part
					to look inside it.
					{answer && answer.skipped.length > 0
						? ` Left out, for having too many values to be a way of splitting: ${answer.skipped.join(", ")}.`
						: ""}
				</p>
			</div>
		</Modal>
	);
}
