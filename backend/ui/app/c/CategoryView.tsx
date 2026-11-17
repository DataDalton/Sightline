"use client";

import Link from "../components/AppLink";
import useSWR from "swr";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { usePageTitle } from "../hooks/usePageTitle";
import { useUser } from "../context/UserContext";
import { Skeleton, SkeletonCards } from "../components/shared/Skeleton";
import { EmptyState, emptyIcons } from "../components/shared/EmptyState";
import { LoadError } from "../components/shared/ErrorState";
import {
	CategoryContacts,
	type CategoryContact,
} from "../components/CategoryContacts";
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
	// Who holds this category's editor role.
	contacts?: CategoryContact[];
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
	const { data, error, isLoading, mutate } = useSWR<CategoryDetail>(
		`/api/category/${encodeURIComponent(categoryId)}`,
		{ fallbackData: initial },
	);
	const { user } = useUser();

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
				<LoadError
					error={error}
					subject="category"
					onRetry={() => void mutate()}
				/>
			</div>
		);
	}

	return (
		<div className={styles.page}>
			<div className={styles.breadcrumb}>
				<Link href="/">Home</Link>
				<span aria-hidden="true">/</span>
				{data ? (
					<span>{data.name}</span>
				) : (
					<Skeleton width={120} height={12} />
				)}
			</div>

			<h1 className={styles.title}>{data?.name ?? " "}</h1>
			{data?.description && (
				<p className={styles.description}>{data.description}</p>
			)}
			{data && (
				<div className={styles.contacts}>
					<CategoryContacts
						contacts={data.contacts}
						context={{
							categoryId: data.categoryId,
							about: data.name,
						}}
						variant="panel"
					/>
				</div>
			)}

			{showSkeleton ? (
				<SkeletonCards count={4} />
			) : isLoading && !data ? null : data &&
			  data.reports.length === 0 ? (
				// An empty list means one of three unrelated things and they
				// need different answers. The home page already distinguishes
				// them; this said the same sentence to all three, so the same
				// reader got a diagnosis on one screen and a shrug on the next.
				<EmptyState
					icon={
						user?.policy.degraded || (user && !user.canQueryAsUser)
							? emptyIcons.lock
							: emptyIcons.folder
					}
					title={
						user?.policy.degraded
							? "Your access could not be checked"
							: user && !user.canQueryAsUser
								? "Reports cannot be opened"
								: "No reports here yet"
					}
				>
					{user?.policy.degraded
						? "Your group membership could not be resolved, so nothing here can be shown. This is usually a missing permission on the SQL warehouse rather than on the data. Please wait a moment or try again."
						: user && !user.canQueryAsUser
							? "No user token was forwarded to the app, so nothing here can be opened. Enable user authorization with the sql scope on the app."
							: "This category has no reports yet, or none that you can open."}
				</EmptyState>
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
