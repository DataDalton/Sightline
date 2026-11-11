"use client";

import { useEffect, useRef, useState } from "react";
import Link from "../components/AppLink";
import { useFreshness } from "../visuals/DataFreshness";
import { lateDetail, useLateSources } from "../visuals/LateDataNotice";
import { usePageQuality } from "../status/QualityNotice";
import {
	usePageChanges,
	whenOf,
	type PageScope,
} from "../updates/UpdateSurfaces";
import type { LiveUpdate } from "../../lib/updates/live";
import styles from "./DataHealth.module.css";

// The state of the data behind a report page, in one chip in its header: how current it is,
// and whether anything about it needs knowing. Changes to the data, failing rules and late
// loads are listed in a panel the chip opens, so none of them sits between a reader and the
// report. The chip is coloured and counted while any of them applies.

interface DataHealthProps extends PageScope {
	freshness: {
		sourceKey: string | null;
		field: string | null;
		label?: string | null;
		dataType?: string | null;
	};
}

type Tone = "danger" | "warning" | "quiet";

function Clock() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</svg>
	);
}

function Cross() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<path d="M18 6 6 18M6 6l12 12" />
		</svg>
	);
}

function toneOfChange(update: LiveUpdate): Tone {
	return update.impact === "breaking" ? "danger" : "warning";
}

export function DataHealth({ freshness, ...scope }: DataHealthProps) {
	const stamp = useFreshness(freshness);
	const late = useLateSources(scope.sourceKeys);
	const quality = usePageQuality(scope.sourceKeys);
	const failing = (quality?.sources ?? []).filter(
		(source) => source.failing.length > 0,
	);
	const { changes, dismiss } = usePageChanges(scope);
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);

	// Closed by a click anywhere else or by Escape, as a menu is.
	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", escape);
		};
	}, [open]);

	const count = changes.length + failing.length + late.length;
	const tone: Tone =
		changes.some((update) => update.impact === "breaking") ||
		failing.length > 0
			? "danger"
			: count > 0
				? "warning"
				: "quiet";

	// With nothing to say about the data and no stamp to show, the header carries nothing.
	if (!stamp && count === 0) return null;

	const now = Date.now();
	const summary =
		count === 0
			? null
			: `${count} ${count === 1 ? "thing" : "things"} to know about this data`;

	return (
		<div className={styles.health} ref={box}>
			<button
				type="button"
				className={`${styles.chip} ${styles[`chip${tone}`]} ${
					changes.length > 0 ? styles.chipNew : ""
				}`}
				onClick={() => setOpen((was) => !was)}
				aria-expanded={open}
				aria-haspopup="dialog"
				title={
					summary ??
					stamp?.explanation ??
					"The state of the data on this page"
				}
			>
				<Clock />
				{stamp ? (
					<>
						<span className={styles.label}>{stamp.label}</span>
						<span className={styles.value}>
							{stamp.value ?? "…"}
						</span>
					</>
				) : (
					<span className={styles.value}>Data</span>
				)}
				{count > 0 && (
					<span
						className={`${styles.count} ${styles[`count${tone}`]}`}
					>
						{count}
					</span>
				)}
			</button>

			{open && (
				<div
					className={styles.panel}
					role="dialog"
					aria-label="About the data on this page"
				>
					<div className={styles.panelHead}>
						<strong>About this data</strong>
						{stamp?.value && (
							<span className={styles.panelStamp}>
								{stamp.label} {stamp.value}
							</span>
						)}
					</div>

					{count === 0 && (
						<p className={styles.allClear}>
							Nothing to know about the data on this page.
						</p>
					)}

					{changes.length > 0 && (
						<section className={styles.section}>
							<h3 className={styles.sectionTitle}>
								Changes to the data
							</h3>
							{changes.map((update) => (
								<div
									key={update.updateId}
									className={styles.row}
								>
									<span
										className={`${styles.dot} ${styles[`dot${toneOfChange(update)}`]}`}
										aria-hidden="true"
									/>
									<Link
										href={`/status?tab=updates&open=${update.updateId}`}
										className={styles.rowText}
									>
										<span className={styles.rowTitle}>
											{update.title}
										</span>
										<span className={styles.rowMeta}>
											{whenOf(update, now)}
										</span>
										{update.whatToDo && (
											<span className={styles.rowWhat}>
												{update.whatToDo}
											</span>
										)}
									</Link>
									<button
										type="button"
										className={styles.dismiss}
										onClick={() =>
											dismiss([update.updateId])
										}
										aria-label={`Dismiss ${update.title}`}
										title="Dismiss"
									>
										<Cross />
									</button>
								</div>
							))}
						</section>
					)}

					{failing.length > 0 && (
						<section className={styles.section}>
							<h3 className={styles.sectionTitle}>
								Failing data rules
							</h3>
							{failing.map((source) => (
								<Link
									key={source.sourceKey}
									href={`/status?tab=quality&source=${encodeURIComponent(source.sourceKey)}`}
									className={styles.row}
								>
									<span
										className={`${styles.dot} ${styles.dotdanger}`}
										aria-hidden="true"
									/>
									<span className={styles.rowText}>
										<span className={styles.rowTitle}>
											{source.sourceTitle}
										</span>
										<span className={styles.rowMeta}>
											{source.failing
												.map((rule) => rule.name)
												.join(", ")}
										</span>
									</span>
								</Link>
							))}
						</section>
					)}

					{late.length > 0 && (
						<section className={styles.section}>
							<h3 className={styles.sectionTitle}>Late data</h3>
							{late.map((source) => (
								<Link
									key={source.sourceKey}
									href="/status"
									className={styles.row}
								>
									<span
										className={`${styles.dot} ${styles.dotwarning}`}
										aria-hidden="true"
									/>
									<span className={styles.rowText}>
										<span className={styles.rowTitle}>
											{source.title}
										</span>
										<span className={styles.rowMeta}>
											{lateDetail(source)}
										</span>
									</span>
								</Link>
							))}
						</section>
					)}

					<div className={styles.panelFoot}>
						<Link href="/status" className={styles.footLink}>
							Data status
						</Link>
						<Link
							href="/status?tab=updates"
							className={styles.footLink}
						>
							Changelog
						</Link>
					</div>
				</div>
			)}
		</div>
	);
}
