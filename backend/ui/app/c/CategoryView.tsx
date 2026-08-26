"use client";

import Link from "next/link";
import useSWR from "swr";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { usePageTitle } from "../hooks/usePageTitle";
import { SkeletonCards } from "../components/shared/Skeleton";
import styles from "./CategoryView.module.css";

interface ReportSummary {
	reportId: string;
	slug: string;
	title: string;
	description: string | null;
	sourceKey: string | null;
	permission: "view" | "edit" | "admin";
}

interface CategoryDetail {
	categoryId: string;
	name: string;
	description: string | null;
	reports: ReportSummary[];
}

// initial is the listing the server resolved while rendering the document. See
// the note in ReportView on why this is handed to the hook rather than provided
// through a nested config.
export default function CategoryView({
	categoryId,
	initial,
}: {
	categoryId: string;
	initial?: CategoryDetail;
}) {
	const { data, error, isLoading } = useSWR<CategoryDetail>(
		`/api/category/${encodeURIComponent(categoryId)}`,
		{ fallbackData: initial },
	);

	// Shown only when the wait is long enough to notice. Most loads answer from
	// cache, where a placeholder would appear and vanish inside two frames.
	// Only a wait with nothing to show yet. See the note in ReportView.
	const showSkeleton = useDeferredLoading(isLoading && !data);

	// Set before the loading and error returns below, because a hook cannot be
	// called conditionally. An unnamed category leaves the application name on
	// its own rather than showing a placeholder in the tab.
	usePageTitle(data?.name ?? null);

	if (error) {
		return (
			<div className={styles.page}>
				<div className={styles.state}>
					This category is not available to you.
				</div>
			</div>
		);
	}

	return (
		<div className={styles.page}>
			<div className={styles.breadcrumb}>
				<Link href="/">Home</Link>
				<span aria-hidden="true">/</span>
				<span>{data?.name ?? "Loading"}</span>
			</div>

			<h1 className={styles.title}>{data?.name ?? " "}</h1>
			{data?.description && (
				<p className={styles.description}>{data.description}</p>
			)}

			{showSkeleton ? (
				<SkeletonCards count={4} />
			) : isLoading && !data ? null : data &&
			  data.reports.length === 0 ? (
				<div className={styles.state}>
					No reports in this category yet.
				</div>
			) : (
				<div className={styles.grid}>
					{data?.reports.map((report) => (
						<Link
							key={report.reportId}
							href={`/r/${report.slug}`}
							className={styles.card}
						>
							<span className={styles.cardTitle}>
								{report.title}
							</span>
							{report.description && (
								<span className={styles.cardDescription}>
									{report.description}
								</span>
							)}
							<span className={styles.cardMeta}>
								{report.sourceKey && (
									<span className={styles.tag}>
										{report.sourceKey}
									</span>
								)}
								{report.permission !== "view" && (
									<span
										className={`${styles.tag} ${styles.tagFixed}`}
									>
										{report.permission}
									</span>
								)}
							</span>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
