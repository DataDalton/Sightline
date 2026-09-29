"use client";

import useSWR from "swr";
import styles from "./LateData.module.css";

// Said above a page when data it reads has not arrived when it usually does,
// so its figures are read as possibly behind rather than as today's.
//
// Asked of the server for the sources the page reads. Asking is also what
// settles a source that is past due but has not been looked at since, so the
// notice can appear a moment after the page opens rather than with it.

interface LateSource {
	sourceKey: string;
	title: string;
	state: string;
	lastArrival: string | null;
	description: string | null;
}

// Asked again every few minutes, which is as often as a late load is likely
// to land and be noticed.
const refreshMs = 5 * 60 * 1000;

function browserZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

function when(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	return at.toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function LateDataNotice({ sourceKeys }: { sourceKeys: string[] }) {
	const keys = [...new Set(sourceKeys)].sort();
	const { data } = useSWR<{ sources: LateSource[] }>(
		keys.length
			? `/api/query/late/?sources=${encodeURIComponent(keys.join(","))}&tz=${encodeURIComponent(browserZone())}`
			: null,
		{ refreshInterval: refreshMs },
	);

	const late = (data?.sources ?? []).filter((s) => s.state === "late");
	if (late.length === 0) return null;

	return (
		<div className={styles.notice} role="status">
			<svg
				className={styles.icon}
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 7v5l3 2" />
			</svg>
			<div className={styles.text}>
				{late.map((source) => (
					<p key={source.sourceKey}>
						<strong>{source.title}</strong> has not updated
						{source.lastArrival
							? ` since ${when(source.lastArrival)}`
							: ""}
						, so figures from it may be behind.
						{source.description ? ` ${source.description}` : ""}
					</p>
				))}
			</div>
		</div>
	);
}
