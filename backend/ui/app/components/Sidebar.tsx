"use client";

import { memo, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { useUser } from "../context/UserContext";
import { useShell } from "../context/ShellContext";
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

const iconPaths: Record<string, string> = {
	home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
	sales: "M3 3v18h18M7 15l4-4 3 3 5-6",
	contracts:
		"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4",
	customers:
		"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87",
	field: "M12 2a8 8 0 0 0-8 8c0 5.5 8 12 8 12s8-6.5 8-12a8 8 0 0 0-8-8zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
	products:
		"M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
	rebates:
		"M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
	asc: "M3 3v18h18M7 16l3-6 4 4 4-8",
	market: "M18 20V10M12 20V4M6 20v-6",
	explore:
		"M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
	admin:
		"M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
	default: "M3 7h7v6H3zM14 7h7v6h-7zM3 16h18v5H3z",
};

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

	if (isLoading) {
		return (
			<div className={styles.subNav}>
				<div className={styles.skeleton} />
				<div className={styles.skeleton} />
			</div>
		);
	}

	const reports = data?.reports ?? [];
	if (reports.length === 0) {
		return <div className={styles.subNav}><span className={styles.subEmpty}>No reports</span></div>;
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

function NavIcon({ name }: { name: string | null }) {
	const path = iconPaths[name ?? "default"] ?? iconPaths.default;
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}

export default memo(function Sidebar() {
	const pathname = usePathname();
	const { user, error: userError, refresh } = useUser();
	const { navOpen } = useShell();

	const { data, isLoading } = useSWR<{ categories: NavCategory[] }>(
		"/api/navigation",
	);
	const categories = data?.categories ?? [];

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
					<Link
						href="/explore"
						className={`${styles.navItem} ${isActive("/explore") ? styles.active : ""}`}
					>
						<NavIcon name="explore" />
						<span className={styles.label}>Explore</span>
					</Link>
				</nav>
			</div>

			<div className={styles.section}>
				<div className={styles.sectionTitle}>Reports</div>
				{isLoading ? (
					<>
						<div className={styles.skeleton} />
						<div className={styles.skeleton} />
						<div className={styles.skeleton} />
					</>
				) : categories.length === 0 ? (
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
											onClick={() => expand(category.categoryId)}
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
													transition: "transform 0.15s ease",
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

			{userError && (
				<div className={styles.footer}>
					<button
						type="button"
						className={styles.retryButton}
						onClick={refresh}
					>
						Connection lost. Retry
					</button>
				</div>
			)}
		</aside>
	);
});
