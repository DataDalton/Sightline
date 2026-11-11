"use client";

import useSWR from "swr";
import { qualityKey } from "../../lib/query/requestKey";
import styles from "./Quality.module.css";

// Which datasets a report page reads are failing a rule, told in the page's data status the
// way a late load is. No counts, since a rule's name is all anyone needs to read the page
// warily. Also the tile an author can place on a page, which reads the same answer. See
// app/r/DataHealth.

export interface PageQuality {
	sources: {
		sourceKey: string;
		sourceTitle: string;
		failing: { name: string; severity: string }[];
		score: number | null;
	}[];
}

export function usePageQuality(sourceKeys: string[]) {
	return useSWR<PageQuality>(qualityKey(sourceKeys), {
		refreshInterval: 5 * 60 * 1000,
		dedupingInterval: 60_000,
	}).data;
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
