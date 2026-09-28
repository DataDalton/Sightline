"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAssistant } from "../assist/AssistantContext";
import { useShell } from "../context/ShellContext";
import { useUser } from "../context/UserContext";
import { CountBadge } from "../notify/InboxBell";
import { BellIcon } from "../notify/icons";
import { useNotify } from "../notify/NotifyContext";
import styles from "./MobileTabBar.module.css";

// The foot of the screen on a phone.
//
// The places somebody goes most, within reach of a thumb, the way every app on
// the same phone is laid out. Everything else stays in the menu, which is the
// same navigation the sidebar shows on a wider screen.

function Icon({ d }: { d: string }) {
	return (
		<svg
			width="22"
			height="22"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.9"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={d} />
		</svg>
	);
}

const paths = {
	home: "M3 10l9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z",
	explore: "M3 3h18v4H3zM3 10h18M3 15h18M3 20h18M9 10v10M15 10v10",
	search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
	ask: "M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z",
	menu: "M3 6h18M3 12h18M3 18h18",
};

export function MobileTabBar() {
	const pathname = usePathname() ?? "/";
	const { user } = useUser();
	const { navOpen, toggleNav, closeNav, openPalette } = useShell();
	const { panelOpen, setPanelOpen } = useAssistant();
	const { unread } = useNotify();

	if (!user) return null;

	const at = (prefix: string) =>
		!navOpen &&
		!panelOpen &&
		(prefix === "/" ? pathname === "/" : pathname.startsWith(prefix));

	const tab = (active: boolean) =>
		`${styles.tab} ${active ? styles.active : ""}`;

	return (
		<nav className={styles.bar} aria-label="Main">
			<Link href="/" className={tab(at("/"))} onClick={closeNav}>
				<Icon d={paths.home} />
				<span>Home</span>
			</Link>
			<Link
				href="/explore/"
				className={tab(at("/explore"))}
				onClick={closeNav}
			>
				<Icon d={paths.explore} />
				<span>Explore</span>
			</Link>
			{user.assistant ? (
				<button
					type="button"
					className={tab(panelOpen || pathname.startsWith("/assist"))}
					onClick={() => {
						closeNav();
						// The full page is already the assistant, and the
						// panel does not open over it.
						if (!pathname.startsWith("/assist")) {
							setPanelOpen(!panelOpen);
						}
					}}
					aria-pressed={panelOpen}
				>
					<Icon d={paths.ask} />
					<span>Ask</span>
				</button>
			) : (
				<button
					type="button"
					className={styles.tab}
					onClick={() => {
						closeNav();
						openPalette();
					}}
				>
					<Icon d={paths.search} />
					<span>Search</span>
				</button>
			)}
			<Link
				href="/inbox/"
				className={tab(at("/inbox") || at("/alerts"))}
				onClick={() => {
					closeNav();
					setPanelOpen(false);
				}}
				aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
			>
				<span className={styles.iconWrap}>
					<BellIcon size={22} />
					<CountBadge count={unread} />
				</span>
				<span>Inbox</span>
			</Link>
			<button
				type="button"
				className={tab(navOpen)}
				onClick={() => {
					setPanelOpen(false);
					toggleNav();
				}}
				aria-expanded={navOpen}
			>
				<Icon d={paths.menu} />
				<span>Menu</span>
			</button>
		</nav>
	);
}
