"use client";

import Link from "../components/AppLink";
import useSWR from "swr";
import { qualityKey } from "../../lib/query/requestKey";
import styles from "./Quality.module.css";

// Said above a report page when data it reads is failing a rule, the same way a late
// load is. No counts, since a rule's name is all anyone needs to read the page warily.
// Also the tile an author can place on a page, which reads the same answer.

interface PageQuality {
	sources: {
		sourceKey: string;
		sourceTitle: string;
		failing: { name: string; severity: string }[];
		score: number | null;
	}[];
}

function usePageQuality(sourceKeys: string[]) {
	return useSWR<PageQuality>(qualityKey(sourceKeys), {
		refreshInterval: 5 * 60 * 1000,
		dedupingInterval: 60_000,
	}).data;
}

export function QualityNotice({ sourceKeys }: { sourceKeys: string[] }) {
	const data = usePageQuality(sourceKeys);
	const failing = (data?.sources ?? []).filter((s) => s.failing.length > 0);
	if (failing.length === 0) return null;
	return (
		<div className={styles.notice} role="status">
			{failing.map((source) => (
				<div key={source.sourceKey} className={styles.noticeRow}>
					<span className={styles.noticeWords}>
						<svg
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
							<path d="M12 9v4M12 17h.01" />
							<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
						</svg>
						<span>
							<strong>{source.sourceTitle}</strong> is failing a
							data rule:{" "}
							{source.failing.map((rule) => rule.name).join(", ")}
						</span>
					</span>
					<Link
						className={styles.noticeLink}
						href={`/status?tab=quality&source=${encodeURIComponent(source.sourceKey)}`}
					>
						See data status
					</Link>
				</div>
			))}
		</div>
	);
}

export function QualityTile({ sourceKey }: { sourceKey: string | null }) {
	const data = usePageQuality(sourceKey ? [sourceKey] : []);
	const source = data?.sources[0];
	if (!source) {
		return (
			<div className={styles.tile}>
				<span className={styles.hint}>
					No data rules on this source yet.
				</span>
			</div>
		);
	}
	return (
		<div className={styles.tile}>
			<div className={styles.tileRow}>
				{source.score !== null && (
					<span
						className={`${styles.score} ${
							source.score >= 90
								? styles.scoreGood
								: source.score >= 60
									? styles.scoreWarn
									: styles.scoreBad
						}`}
					>
						{source.score}
					</span>
				)}
				<span>
					{source.failing.length === 0
						? "All data rules passing."
						: `${source.failing.length} data rule${source.failing.length === 1 ? "" : "s"} failing.`}
				</span>
			</div>
			{source.failing.map((rule) => (
				<span key={rule.name} className={styles.hint}>
					{rule.name}
				</span>
			))}
		</div>
	);
}
