"use client";

import Link from "next/link";
import useSWR from "swr";
import { Skeleton } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import styles from "./Admin.module.css";

// Pages people built for themselves.
//
// An administrator can open and edit any of these, which is only useful if they
// can find one. Being able to reach a page you cannot list is not the same as
// being able to answer for what the platform holds.
//
// Every read of somebody's page through that route is written to the activity
// log, so the access is on record rather than merely possible.

interface PersonalPage {
	reportId: string;
	slug: string;
	title: string;
	sourceKey: string | null;
	ownerEmail: string;
	modifiedOn: string;
	sharedWith: number;
}

function when(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const days = Math.floor(ms / 86400000);
	if (days < 1) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

export default function PersonalPagesPane() {
	const { data, isLoading } = useSWR<{ pages: PersonalPage[] }>(
		"/api/personal?scope=all",
	);
	const showSkeleton = useDeferredLoading(isLoading);

	const pages = data?.pages ?? [];

	return (
		<div className={styles.tableWrap}>
			<table className={styles.table}>
				<thead>
					<tr>
						<th>Page</th>
						<th>Built by</th>
						<th>Reads</th>
						<th className={styles.numeric}>Shared with</th>
						<th>Changed</th>
					</tr>
				</thead>
				<tbody>
					{pages.map((page) => (
						<tr key={page.reportId}>
							<td>
								<Link
									href={`/r/${page.slug}`}
									className={styles.linkButton}
								>
									{page.title}
								</Link>
							</td>
							<td>{page.ownerEmail}</td>
							<td>
								{page.sourceKey ? (
									<span className={styles.mono}>
										{page.sourceKey}
									</span>
								) : (
									"-"
								)}
							</td>
							<td className={styles.numeric}>
								{page.sharedWith === 0
									? "nobody"
									: page.sharedWith}
							</td>
							<td>{when(page.modifiedOn)}</td>
						</tr>
					))}
					{!isLoading && pages.length === 0 && (
						<tr>
							<td colSpan={5}>
								Nobody has built a page of their own yet.
							</td>
						</tr>
					)}
					{showSkeleton &&
						Array.from({ length: 4 }, (_, row) => (
							<tr key={`loading-${row}`}>
								{Array.from({ length: 5 }, (_, col) => (
									<td key={col}>
										<Skeleton height={12} />
									</td>
								))}
							</tr>
						))}
				</tbody>
			</table>
		</div>
	);
}
