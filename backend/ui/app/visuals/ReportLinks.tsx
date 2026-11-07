"use client";

import Link from "next/link";
import useSWR from "swr";
import {
	linkAddress,
	pageReceiving,
	type LinkTarget,
	type ReportLink,
} from "../../lib/visuals/reportLinks";
import type { ShareClause } from "../../lib/visuals/shareState";
import { useBoardOrigin } from "../boards/AddToBoard";
import styles from "./Visual.module.css";

// Links to other reports, on a visual and as a visual of their own.

// The reports this reader can reach. Only asked for where a visual has links, so
// a page without any pays nothing.
export function useLinkTargets(wanted: boolean): {
	targets: LinkTarget[];
	loaded: boolean;
} {
	const { data } = useSWR<{ targets: LinkTarget[] }>(
		wanted ? "/api/report-links" : null,
	);
	return { targets: data?.targets ?? [], loaded: data !== undefined };
}

function ArrowIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M5 12h14M13 6l6 6-6 6" />
		</svg>
	);
}

// Shown in a visual's header once something on it is selected. Only for targets
// the reader can open that can also receive what was clicked, so a link never
// lands on a report that ignores the selection.
export function OpenInLinks({
	links,
	selection,
	pageFilters,
}: {
	links: ReportLink[];
	selection: ShareClause[];
	pageFilters: ShareClause[];
}) {
	const { targets } = useLinkTargets(
		links.length > 0 && selection.length > 0,
	);
	if (links.length === 0 || selection.length === 0) return null;

	const fields = selection.map((clause) => clause.field);
	const offered = links.flatMap((link) => {
		const target = targets.find((t) => t.slug === link.slug);
		if (!target) return [];
		const page = pageReceiving(target, fields);
		if (page === null) return [];
		return [
			{
				link,
				href: linkAddress(
					link.slug,
					// The selection last, so it replaces the page's filter on
					// the same field.
					[...pageFilters, ...selection],
					page > 0 ? target.pages[page].title : null,
				),
			},
		];
	});
	if (offered.length === 0) return null;

	return (
		<span className={styles.openIn}>
			{offered.map(({ link, href }) => (
				<Link
					key={link.slug}
					href={href}
					className={styles.openInLink}
					title={`Open ${link.title} filtered to what you selected`}
				>
					{link.label ?? link.title}
					<ArrowIcon />
				</Link>
			))}
		</span>
	);
}

// A row of links between reports, which is how a set of reports reads as one
// application. The report being read is marked rather than linked.
export function NavigationLinks({
	links,
	appearance,
	pageFilters,
}: {
	links: ReportLink[];
	appearance: "buttons" | "tabs";
	// Carried across, so moving between related reports keeps the reader's place.
	// A target ignores any it has no control for.
	pageFilters: ShareClause[];
}) {
	const here = useBoardOrigin()?.slug;
	const { targets, loaded } = useLinkTargets(links.length > 0);
	// Nothing until the answer arrives, so a reader is never shown a link and
	// then has it taken away.
	const shown = links.filter((link) =>
		targets.some((target) => target.slug === link.slug),
	);
	if (!loaded || shown.length === 0) return null;

	return (
		<nav
			className={
				appearance === "tabs" ? styles.navLinksTabs : styles.navLinks
			}
			aria-label="Related reports"
		>
			{shown.map((link) =>
				link.slug === here ? (
					<span
						key={link.slug}
						className={`${styles.navLink} ${styles.navLinkCurrent}`}
						aria-current="page"
					>
						{link.label ?? link.title}
					</span>
				) : (
					<Link
						key={link.slug}
						href={linkAddress(link.slug, pageFilters)}
						className={styles.navLink}
					>
						{link.label ?? link.title}
					</Link>
				),
			)}
		</nav>
	);
}
