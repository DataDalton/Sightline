"use client";

import Link from "next/link";
import useSWR from "swr";
import { usePageTitle } from "../hooks/usePageTitle";
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

export default function CategoryView({ categoryId }: { categoryId: string }) {
	const { data, error, isLoading } = useSWR<CategoryDetail>(
		`/api/category/${encodeURIComponent(categoryId)}`,
	);

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

			{isLoading ? (
				<div className={styles.grid}>
					{Array.from({ length: 4 }, (_, i) => (
						<div key={i} className={styles.skeleton} />
					))}
				</div>
			) : data && data.reports.length === 0 ? (
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
