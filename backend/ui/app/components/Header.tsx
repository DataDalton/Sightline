"use client";

import { memo, useEffect, useState } from "react";
import useSWR from "swr";
import { useUser } from "../context/UserContext";
import { useShell } from "../context/ShellContext";
import styles from "./Header.module.css";

// Branding comes from the settings table rather than from a build-time
// variable, so an admin can change the name or the mark without a redeploy and
// every replica has it within a refresh interval.
const fallbackName = "Sightline";

export default memo(function Header() {
	const { user } = useUser();
	const { navOpen, toggleNav, openPalette } = useShell();

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

	// Which modifier this keyboard actually uses. Read after mount rather than
	// during render: the server has no platform to report, and deciding during
	// render puts a different string in the document than in the first client
	// render, which React treats as a mismatch.
	const [modifier, setModifier] = useState("Ctrl");
	useEffect(() => {
		if (
			/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
		) {
			setModifier("⌘");
		}
	}, []);

	const appName = branding?.name || fallbackName;

	// Membership that could not be refreshed, and a session with no forwarded
	// token, both change what the app can do. The account block at the foot of
	// the navigation says so in words, but it is inside the drawer on a narrow
	// screen, so the mark stays here at every width.
	const degraded =
		user !== null &&
		(user.policy.stale || user.policy.degraded || !user.canQueryAsUser);

	return (
		<header className={styles.header}>
			<div className={styles.brand}>
				<button
					type="button"
					className={styles.menuButton}
					onClick={toggleNav}
					aria-label={
						navOpen ? "Close navigation" : "Open navigation"
					}
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

			{/* Styled as a field rather than drawn as one. Typing happens in the
			    palette, and an input here would need its value handing over the
			    moment it opened. */}
			<button
				type="button"
				className={styles.search}
				onClick={openPalette}
				aria-label="Search"
			>
				<svg
					className={styles.searchIcon}
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="8" />
					<path d="M21 21l-4.35-4.35" />
				</svg>
				<span className={styles.searchLabel}>Search</span>
				<span className={styles.shortcut} aria-hidden="true">
					{modifier}K
				</span>
			</button>

			{/* The account block lives at the foot of the navigation, which is
			    inside the drawer below this width. The mark comes back here so
			    somebody can still see who they are signed in as, and so a
			    degraded session is not silent. */}
			<div className={styles.compactUser}>
				<span className={styles.avatar}>{user?.initials ?? "?"}</span>
				{degraded && (
					<span
						className={styles.statusDot}
						title="Access could not be fully resolved"
						aria-label="Access could not be fully resolved"
					/>
				)}
			</div>
		</header>
	);
});
