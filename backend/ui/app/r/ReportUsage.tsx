"use client";

import { useState } from "react";
import useSWR from "swr";
import type { ReportUsage as Usage } from "../../lib/platform/reportUsage";
import { visualByType } from "../../lib/visuals/catalog";
import { Modal } from "../components/shared/Modal";
import { describeFetchError } from "../../lib/swr";
import styles from "./ReportUsage.module.css";

// How a report is read, for the people who maintain it: how often it is
// opened and by whom, which pages are read, and which visuals anyone does
// anything with. What nobody uses is marked, since that is what to look at
// before rearranging or retiring something.

const windows = [7, 30, 90] as const;

function when(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

function plural(n: number, one: string, many: string): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function ReportUsage({
	slug,
	title,
	onClose,
}: {
	slug: string;
	title: string;
	onClose: () => void;
}) {
	const [days, setDays] = useState<(typeof windows)[number]>(30);
	const { data, error } = useSWR<Usage>(
		`/api/report/${encodeURIComponent(slug)}/readership/?days=${days}`,
	);

	const peak = Math.max(1, ...(data?.byDay.map((d) => d.opens) ?? [1]));

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={`How ${title} is read`}
			width="820px"
		>
			<div className={styles.wrap}>
				<div
					className={styles.windows}
					role="group"
					aria-label="Period"
				>
					{windows.map((w) => (
						<button
							key={w}
							type="button"
							className={`${styles.window} ${w === days ? styles.windowOn : ""}`}
							aria-pressed={w === days}
							onClick={() => setDays(w)}
						>
							Last {w} days
						</button>
					))}
				</div>

				{error ? (
					<p className={styles.state}>
						{describeFetchError(error, "usage")}
					</p>
				) : !data ? (
					<p className={styles.state}>Loading</p>
				) : (
					<>
						<div className={styles.figures}>
							<div className={styles.figure}>
								<span className={styles.figureValue}>
									{data.opens.toLocaleString()}
								</span>
								<span className={styles.figureLabel}>
									Opens
								</span>
							</div>
							<div className={styles.figure}>
								<span className={styles.figureValue}>
									{data.readers.toLocaleString()}
								</span>
								<span className={styles.figureLabel}>
									People
								</span>
							</div>
						</div>

						{data.byDay.length > 0 && (
							<div
								className={styles.bars}
								role="img"
								aria-label={`Opens each day over the last ${data.days} days`}
							>
								{data.byDay.map((d) => (
									<span
										key={d.day}
										className={styles.bar}
										style={{
											// A quiet day draws nothing, and a busy one at
											// least a sliver, so it is never lost.
											height:
												d.opens === 0
													? 0
													: `${Math.max(6, (d.opens / peak) * 100)}%`,
										}}
										title={`${d.day}: ${plural(d.opens, "open", "opens")} by ${plural(d.readers, "person", "people")}`}
									/>
								))}
							</div>
						)}

						<section className={styles.section}>
							<h3 className={styles.heading}>Who reads it</h3>
							{data.people.length === 0 ? (
								<p className={styles.empty}>
									Nobody has opened it in this period.
								</p>
							) : (
								<ul className={styles.list}>
									{data.people.map((p) => (
										<li
											key={p.email}
											className={styles.row}
										>
											<span className={styles.name}>
												{p.name}
											</span>
											<span className={styles.meta}>
												{plural(
													p.opens,
													"open",
													"opens",
												)}
												, last {when(p.lastOn)}
											</span>
										</li>
									))}
								</ul>
							)}
						</section>

						<section className={styles.section}>
							<h3 className={styles.heading}>Pages</h3>
							<ul className={styles.list}>
								{data.pages.map((p) => (
									<li key={p.pageId} className={styles.row}>
										<span className={styles.name}>
											{p.title}
										</span>
										{p.opens === 0 ? (
											<span className={styles.unused}>
												Not opened
											</span>
										) : (
											<span className={styles.meta}>
												{plural(
													p.opens,
													"view",
													"views",
												)}{" "}
												by{" "}
												{plural(
													p.readers,
													"person",
													"people",
												)}
											</span>
										)}
									</li>
								))}
							</ul>
						</section>

						<section className={styles.section}>
							<h3 className={styles.heading}>Visuals</h3>
							<p className={styles.hint}>
								Counts expanding a visual, showing its figures,
								opening its notes and clicking into it. Being on
								screen is not counted.
							</p>
							<ul className={styles.list}>
								{data.visuals.map((v) => (
									<li key={v.visualId} className={styles.row}>
										<span className={styles.name}>
											{v.title ??
												visualByType[v.visualType]
													?.label ??
												v.visualType}
											<span className={styles.where}>
												{v.pageTitle}
											</span>
										</span>
										{v.actions === 0 ? (
											<span className={styles.unused}>
												Not used
											</span>
										) : (
											<span className={styles.meta}>
												{plural(
													v.actions,
													"use",
													"uses",
												)}{" "}
												by{" "}
												{plural(
													v.readers,
													"person",
													"people",
												)}
											</span>
										)}
									</li>
								))}
							</ul>
						</section>
					</>
				)}
			</div>
		</Modal>
	);
}
