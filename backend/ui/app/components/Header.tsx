"use client";

import { memo, useEffect } from "react";
import useSWR from "swr";
import { useUser } from "../context/UserContext";
import { useTheme } from "../context/ThemeContext";
import { useShell } from "../context/ShellContext";
import styles from "./Header.module.css";

// Branding comes from the settings table rather than from a build-time
// variable, so an admin can change the name or the mark without a redeploy and
// every replica has it within a refresh interval.
const fallbackName = "Sightline";

function ThemeIcon({ resolved }: { resolved: "light" | "dark" }) {
	if (resolved === "dark") {
		return (
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			>
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
			</svg>
		);
	}
	return (
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
			<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
		</svg>
	);
}

export default memo(function Header() {
	const { user, loading, error } = useUser();
	const { resolved, preference, setPreference } = useTheme();
	const { navOpen, toggleNav } = useShell();

	const { data: branding, mutate: refreshBranding } = useSWR<{
		name?: string;
		logo?: string | null;
	}>("/api/info");

	// An admin saving a change on this page should see it here, rather than in
	// a minute when the poll comes round or on the next navigation.
	useEffect(() => {
		const onChanged = () => void refreshBranding();
		window.addEventListener("sightline:settings-changed", onChanged);
		return () =>
			window.removeEventListener("sightline:settings-changed", onChanged);
	}, [refreshBranding]);

	const appName = branding?.name || fallbackName;

	// Cycles system to light to dark and back, so a user who wants to follow
	// the OS can get back to it without a separate control.
	const cycleTheme = () => {
		setPreference(
			preference === "system"
				? "light"
				: preference === "light"
					? "dark"
					: "system",
		);
	};

	return (
		<header className={styles.header}>
			<div className={styles.brand}>
				<button
					type="button"
					className={styles.menuButton}
					onClick={toggleNav}
					aria-label={navOpen ? "Close navigation" : "Open navigation"}
					aria-expanded={navOpen}
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
					>
						{navOpen ? (
							<path d="M18 6L6 18M6 6l12 12" />
						) : (
							<path d="M3 6h18M3 12h18M3 18h18" />
						)}
					</svg>
				</button>
				{branding?.logo ? (
					// Put into the document rather than loaded as an image, so
					// a mark drawn in currentColor takes the colour of the text
					// beside it and one file serves both themes. The markup was
					// rebuilt from an allow-list before it was stored; see
					// lib/visuals/svgSanitize.
					<span
						className={styles.logoImage}
						role="img"
						aria-label={appName}
						dangerouslySetInnerHTML={{ __html: branding.logo }}
					/>
				) : (
				<svg
					className={styles.logoMark}
					viewBox="0 0 32 32"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					role="img"
					aria-label={appName}
				>
					<path d="M6 22V13" />
					<path d="M16 22V6" />
					<path d="M26 22v-6" />
					<path d="M4 27h24" />
				</svg>
				)}
				<span className={styles.divider} aria-hidden="true" />
				<span className={styles.appName}>{appName}</span>
			</div>

			<div className={styles.spacer} />

			<div className={styles.actions}>
				<button
					type="button"
					className={styles.iconButton}
					onClick={cycleTheme}
					title={`Theme: ${preference}`}
					aria-label={`Theme: ${preference}. Click to change.`}
				>
					<ThemeIcon resolved={resolved} />
				</button>

				<div className={styles.user}>
					<span className={styles.avatar}>
						{loading ? "" : (user?.initials ?? "?")}
					</span>
					<span className={styles.userName}>
						{loading
							? "Connecting"
							: error
								? "Offline"
								: (user?.name ?? "Unknown")}
					</span>
					{user && !user.authenticated && (
						<span className={styles.badge}>Local</span>
					)}
					{user?.policy.stale && (
						<span
							className={`${styles.badge} ${styles.warning}`}
							title="Group membership could not be refreshed. Showing last known access."
						>
							Stale access
						</span>
					)}
				</div>
			</div>
		</header>
	);
});
