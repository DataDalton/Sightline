"use client";

import Link from "next/link";
import useSWR from "swr";
import { SkeletonCards } from "./components/shared/Skeleton";
import { useDeferredLoading } from "./hooks/useDeferredLoading";
import { usePageTitle } from "./hooks/usePageTitle";
import { useUser } from "./context/UserContext";
import styles from "./page.module.css";

interface NavCategory {
	categoryId: string;
	name: string;
	icon: string | null;
	reportCount: number;
}

// What a fresh install calls itself, before an administrator has named it.
const fallbackName = "Sightline";
const fallbackDescription = "Reporting and analytics";

export default function Home() {
	// The landing page is the application, so its name stands alone.
	usePageTitle(null);

	const { user } = useUser();
	const { data, isLoading } = useSWR<{
		categories: NavCategory[];
		degraded: boolean;
	}>("/api/navigation");

	// The name and the line under it come from the settings table, so an
	// installation describes itself rather than being described by whoever
	// wrote this file. The subject matter here is whatever categories exist,
	// which is not something source can know.
	const { data: branding } = useSWR<{ name?: string; description?: string }>(
		"/api/info",
	);

	// Navigation answers from cache in single digit milliseconds, so a
	// placeholder shown the moment the request starts would only ever
	// blink. This shows one when the wait is real.
	const showSkeleton = useDeferredLoading(isLoading);

	const categories = data?.categories ?? [];

	// An empty list means one of two unrelated things, and they call for
	// opposite responses. Navigation answers with an empty list when it cannot
	// reach the platform store or resolve the caller, so treating every empty
	// list as an access decision would tell somebody to go ask for a grant they
	// already hold.
	const navigationDegraded = data?.degraded === true;

	// Two different failures reach the same empty list and need opposite
	// answers. An unresolved membership is a permission the reader is missing,
	// most often the right to use the warehouse the probe runs on. Calling that
	// a problem with the app sends them to the wrong person.
	const membershipUnresolved = user?.policy.degraded === true;

	const appName = branding?.name || fallbackName;
	const greeting = user?.name
		? `Welcome back, ${user.name.split(" ")[0]}`
		: appName;

	// Without a forwarded token no query can run at all, because every data
	// read goes through the caller own Unity Catalog session. Saying so is
	// more useful than letting each visual fail on its own.
	const cannotQuery = user !== null && !user.canQueryAsUser;

	return (
		<div className={styles.page}>
			<div className={styles.header}>
				<h1 className={styles.title}>{greeting}</h1>
				<p className={styles.subtitle}>
					{branding?.description || fallbackDescription}
				</p>
			</div>

			{cannotQuery && (
				<div className={styles.notice}>
					<svg
						className={styles.noticeIcon}
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
					>
						<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
						<path d="M12 9v4M12 17h.01" />
					</svg>
					<div>
						<div className={styles.noticeTitle}>
							Data access is not available
						</div>
						<p className={styles.noticeBody}>
							No user token was forwarded to the app, so queries
							cannot run under your identity. Enable user
							authorization with the sql scope on the app to
							restore access.
						</p>
					</div>
				</div>
			)}

			{user?.policy.degraded && (
				<div className={styles.notice}>
					<svg
						className={styles.noticeIcon}
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
					>
						<circle cx="12" cy="12" r="10" />
						<path d="M12 8v4M12 16h.01" />
					</svg>
					<div>
						<div className={styles.noticeTitle}>
							Access could not be verified
						</div>
						<p className={styles.noticeBody}>
							Your group membership could not be resolved, so
							reports are hidden. Please wait a moment or try
							again.
						</p>
					</div>
				</div>
			)}

			{showSkeleton ? (
				<SkeletonCards count={6} />
			) : isLoading ? null : categories.length === 0 ? (
				<div className={styles.empty}>
					<div className={styles.emptyTitle}>
						{membershipUnresolved
							? "Your access could not be checked"
							: navigationDegraded
								? "Reports are unavailable"
								: "Nothing here yet"}
					</div>
					<p className={styles.emptyBody}>
						{membershipUnresolved
							? "Your group membership could not be resolved, so no report can be shown. This is usually a missing permission on the SQL warehouse rather than on the data. Ask an administrator to grant your group CAN USE on it, then try again."
							: navigationDegraded
								? "The app could not load the list of reports. This is a fault in the app rather than in your access. Please wait a moment or try again. An administrator can see the reason under Administration."
								: "No report categories are available to you. Once datasets are registered and you are granted access, they appear here."}
					</p>
				</div>
			) : (
				<div className={styles.grid}>
					{categories.map((category) => (
						<Link
							key={category.categoryId}
							href={`/c/${category.categoryId}`}
							className={styles.card}
						>
							<span className={styles.cardIcon}>
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M3 3v18h18M7 15l4-4 3 3 5-6" />
								</svg>
							</span>
							<span className={styles.cardTitle}>
								{category.name}
							</span>
							<span className={styles.cardMeta}>
								{category.reportCount}{" "}
								{category.reportCount === 1
									? "report"
									: "reports"}
							</span>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
