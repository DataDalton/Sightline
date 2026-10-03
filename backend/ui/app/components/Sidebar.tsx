"use client";

import { memo, useEffect, useState } from "react";
import Link from "./AppLink";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { useUser } from "../context/UserContext";
import { Skeleton } from "./shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { useShell } from "../context/ShellContext";
import { NewReportButton } from "../authoring/NewReport";
import { AccountBlock } from "./AccountBlock";
import { useNotify } from "../notify/NotifyContext";
import { NavIcon } from "./NavIcon";
import styles from "./Sidebar.module.css";

// Navigation comes from the categories the caller can actually open, resolved
// server-side against their policy class. A category the user has no grant for
// never reaches the client, so the sidebar cannot advertise a report that
// would then refuse to load.

interface NavCategory {
	categoryId: string;
	name: string;
	icon: string | null;
	reportCount: number;
}

interface Favourite {
	reportId: string;
	slug: string;
	title: string;
}

// The reports inside a category, fetched only once the category is open. The
// sidebar would otherwise make a request per category on every page load for
// lists most readers never expand.
function CategoryReports({
	categoryId,
	isActive,
}: {
	categoryId: string;
	isActive: (href: string) => boolean;
}) {
	const { data, isLoading } = useSWR<{
		reports: { reportId: string; slug: string; title: string }[];
	}>(`/api/category/${encodeURIComponent(categoryId)}`);

	const showSkeleton = useDeferredLoading(isLoading);

	// Nothing rather than a placeholder for a wait nobody perceives. The
	// category list answers from cache, and two bars appearing and vanishing
	// under the item just clicked reads as a glitch.
	if (isLoading) {
		return showSkeleton ? (
			<div className={styles.subNav}>
				<Skeleton height={30} onChrome />
				<Skeleton height={30} onChrome />
			</div>
		) : null;
	}

	const reports = data?.reports ?? [];
	if (reports.length === 0) {
		return (
			<div className={styles.subNav}>
				<span className={styles.subEmpty}>No reports</span>
			</div>
		);
	}

	return (
		<div className={styles.subNav}>
			{reports.map((report) => {
				const href = `/r/${report.slug}`;
				return (
					<Link
						key={report.reportId}
						href={href}
						className={`${styles.subItem} ${
							isActive(href) ? styles.subItemActive : ""
						}`}
						title={report.title}
					>
						{report.title}
					</Link>
				);
			})}
		</div>
	);
}

export default memo(function Sidebar() {
	const pathname = usePathname();
	const { user } = useUser();
	const { unread } = useNotify();
	const { navOpen } = useShell();

	const { data, isLoading } = useSWR<{
		categories: NavCategory[];
		favourites?: Favourite[];
	}>("/api/navigation");
	const navSkeleton = useDeferredLoading(isLoading);
	const categories = data?.categories ?? [];
	const favourites = data?.favourites ?? [];

	// Which categories are showing their reports. Opening a category from the
	// sidebar expands it as well as navigating, since a reader who clicked it
	// is about to want the list either way.
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const toggle = (categoryId: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(categoryId)) next.delete(categoryId);
			else next.add(categoryId);
			return next;
		});

	const expand = (categoryId: string) =>
		setExpanded((prev) => new Set(prev).add(categoryId));

	// Arriving at a category page directly, by link or by reload, opens it too.
	useEffect(() => {
		const match = /^\/c\/([^/]+)/.exec(pathname ?? "");
		if (match) expand(match[1]);
	}, [pathname]);

	const isActive = (href: string) => {
		if (!pathname) return false;
		if (href === "/") return pathname === "/";
		return pathname === href || pathname.startsWith(`${href}/`);
	};

	return (
		<aside
			className={`${styles.sidebar} ${navOpen ? styles.open : ""}`}
			aria-hidden={false}
		>
			<div className={styles.section}>
				<nav className={styles.nav}>
					<Link
						href="/"
						className={`${styles.navItem} ${isActive("/") ? styles.active : ""}`}
					>
						<NavIcon name="home" />
						<span className={styles.label}>Home</span>
					</Link>
					{/* The inbox and the alerts that feed it are one page, with
					    the unread count beside it. */}
					<Link
						href="/inbox"
						className={`${styles.navItem} ${
							isActive("/inbox") || isActive("/alerts")
								? styles.active
								: ""
						}`}
					>
						<NavIcon name="inbox" />
						<span className={styles.label}>Inbox</span>
						{unread > 0 && (
							<span className={styles.unreadCount}>{unread}</span>
						)}
					</Link>
					<Link
						href="/mine"
						className={`${styles.navItem} ${isActive("/mine") ? styles.active : ""}`}
					>
						<NavIcon name="mine" />
						<span className={styles.label}>My pages</span>
					</Link>
					<Link
						href="/dictionary"
						className={`${styles.navItem} ${
							isActive("/dictionary") ? styles.active : ""
						}`}
					>
						<NavIcon name="dictionary" />
						<span className={styles.label}>Dictionary</span>
					</Link>
					<Link
						href="/explore"
						className={`${styles.navItem} ${
							isActive("/explore") ? styles.active : ""
						}`}
					>
						<NavIcon name="explore" />
						<span className={styles.label}>Explore</span>
					</Link>
					<Link
						href="/sheets"
						className={`${styles.navItem} ${
							isActive("/sheets") ? styles.active : ""
						}`}
					>
						<NavIcon name="sheets" />
						<span className={styles.label}>Sheets</span>
					</Link>
					<Link
						href="/status"
						className={`${styles.navItem} ${
							isActive("/status") ? styles.active : ""
						}`}
					>
						<NavIcon name="status" />
						<span className={styles.label}>Data status</span>
					</Link>
					{/* Absent unless this deployment names a model endpoint.
					    An assistant nobody configured is not a disabled
					    feature, it is one that was never built. */}
					{user?.assistant && (
						<Link
							href="/assist"
							className={`${styles.navItem} ${
								isActive("/assist") ? styles.active : ""
							}`}
						>
							<NavIcon name="assist" />
							<span className={styles.label}>Assistant</span>
						</Link>
					)}
				</nav>
			</div>

			{favourites.length > 0 && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Favourites</div>
					<nav className={styles.nav}>
						{favourites.map((report) => {
							const href = `/r/${report.slug}`;
							return (
								<Link
									key={report.reportId}
									href={href}
									className={`${styles.navItem} ${
										isActive(href) ? styles.active : ""
									}`}
									title={report.title}
								>
									<svg
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="currentColor"
										aria-hidden="true"
									>
										<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />
									</svg>
									<span className={styles.label}>
										{report.title}
									</span>
								</Link>
							);
						})}
					</nav>
				</div>
			)}

			<div className={styles.section}>
				<div className={styles.sectionTitle}>Reports</div>
				{navSkeleton ? (
					<>
						<Skeleton height={30} onChrome />
						<Skeleton height={30} onChrome />
						<Skeleton height={30} onChrome />
					</>
				) : isLoading ? null : categories.length === 0 ? (
					<p className={styles.empty}>
						No reports available yet. Once datasets are registered
						they appear here.
					</p>
				) : (
					<nav className={styles.nav}>
						{categories.map((category) => {
							const href = `/c/${category.categoryId}`;
							const open = expanded.has(category.categoryId);
							return (
								<div key={category.categoryId}>
									<div
										className={`${styles.navItem} ${
											isActive(href) ? styles.active : ""
										}`}
									>
										<Link
											href={href}
											className={styles.navLink}
											onClick={() =>
												expand(category.categoryId)
											}
										>
											<NavIcon name={category.icon} />
											<span className={styles.label}>
												{category.name}
											</span>
										</Link>
										<span className={styles.count}>
											{category.reportCount}
										</span>
										<button
											type="button"
											className={styles.disclosure}
											onClick={(e) => {
												e.preventDefault();
												toggle(category.categoryId);
											}}
											aria-expanded={open}
											aria-label={
												open
													? `Collapse ${category.name}`
													: `Expand ${category.name}`
											}
										>
											<svg
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2.5"
												strokeLinecap="round"
												strokeLinejoin="round"
												style={{
													transform: open
														? "rotate(90deg)"
														: undefined,
													transition:
														"transform 0.15s ease",
												}}
											>
												<path d="M9 18l6-6-6-6" />
											</svg>
										</button>
									</div>

									{open && (
										<CategoryReports
											categoryId={category.categoryId}
											isActive={isActive}
										/>
									)}
								</div>
							);
						})}
					</nav>
				)}

				{user?.capabilities?.includes("report.create") && (
					<NewReportButton className={styles.newReport} />
				)}
			</div>

			{user?.canAdminister && (
				<div className={styles.section}>
					<div className={styles.sectionTitle}>Manage</div>
					<nav className={styles.nav}>
						<Link
							href="/admin"
							className={`${styles.navItem} ${
								isActive("/admin") ? styles.active : ""
							}`}
						>
							<NavIcon name="admin" />
							<span className={styles.label}>Administration</span>
						</Link>
					</nav>
				</div>
			)}

			<AccountBlock />
		</aside>
	);
});
