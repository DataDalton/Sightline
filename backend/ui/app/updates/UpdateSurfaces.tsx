"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "../components/AppLink";
import { Modal } from "../components/shared/Modal";
import { TextPanel } from "../visuals/TextPanel";
import {
	aboutPage,
	currentWindow,
	isUnderway,
	onPagesNow,
} from "../../lib/updates/model";
import type { LiveUpdate, UpdateMarker } from "../../lib/updates/live";
import { liveUpdatesKey, markersKey } from "../../lib/query/requestKey";
import form from "../authoring/Authoring.module.css";
import styles from "./Updates.module.css";

// Updates where they are needed, away from their own page. A banner and pop-up across the
// app, a card on Home, a line on affected pages, the field in the Dictionary, and markers
// on charts at the date something took effect.

// The light answer every page asks for, without the timeline's own parts. See app/api/changes.
// The shell hands it over with each document, so a page asks for it again only on its own
// schedule.
export function useLiveUpdates() {
	return useSWR<{ updates: LiveUpdate[]; quietSources: string[] }>(
		liveUpdatesKey,
		{
			refreshInterval: 60_000,
			dedupingInterval: 10_000,
		},
	);
}

const dismissedKey = "sightline.updates.dismissed";

function readDismissed(): Set<string> {
	try {
		return new Set(
			JSON.parse(
				window.localStorage.getItem(dismissedKey) ?? "[]",
			) as string[],
		);
	} catch {
		return new Set();
	}
}

function postRead(updateId: string, acknowledged = false): void {
	void fetch("/api/changes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: "read", updateId, acknowledged }),
	}).catch(() => {});
}

function countdown(until: number, now: number): string {
	const minutes = Math.max(0, Math.round((until - now) / 60000));
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	return `${Math.round(hours / 24)} days`;
}

// A banner for whatever asks for one, and a pop-up once for whatever asks for that. In
// the shell, so it follows someone around the app until they dismiss it.
export function UpdatesBanner() {
	const { data } = useLiveUpdates();
	const [dismissed, setDismissed] = useState<Set<string>>(new Set());
	const [popupGone, setPopupGone] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		setDismissed(readDismissed());
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, []);

	const dismiss = (updateId: string) => {
		const next = new Set(dismissed).add(updateId);
		setDismissed(next);
		try {
			window.localStorage.setItem(
				dismissedKey,
				JSON.stringify([...next]),
			);
		} catch {
			// Stays dismissed until the next load.
		}
		postRead(updateId);
	};

	const updates = data?.updates ?? [];
	const banners = updates.filter((update) => {
		if (!update.delivery.banner || dismissed.has(update.updateId))
			return false;
		if (update.type === "incident")
			return update.incidentState !== "resolved";
		if (update.type === "maintenance")
			return currentWindow(update, now) !== null;
		return true;
	});
	const popup = popupGone
		? undefined
		: updates.find((update) => update.delivery.popup && !update.read);

	return (
		<>
			{banners.slice(0, 3).map((update) => {
				const window =
					update.type === "maintenance"
						? currentWindow(update, now)
						: null;
				return (
					<div
						key={update.updateId}
						className={`${styles.banner} ${styles[`banner${update.impact}`]}`}
						role="status"
					>
						<span className={styles.bannerText}>
							<strong>{update.title}</strong>
							{window &&
								(window.start > now
									? `. Starts in ${countdown(window.start, now)}.`
									: `. Under way, ends in ${countdown(window.end, now)}.`)}
						</span>
						<Link
							href={`/status?tab=updates&open=${update.updateId}`}
							className={styles.button}
						>
							Details
						</Link>
						<button
							type="button"
							className={styles.button}
							onClick={() => dismiss(update.updateId)}
						>
							Dismiss
						</button>
					</div>
				);
			})}
			{popup && (
				<Modal
					isOpen
					onClose={() => {
						setPopupGone(true);
						postRead(popup.updateId);
					}}
					title={popup.title}
					width="560px"
				>
					<div className={form.form}>
						{popup.body && <TextPanel html={popup.body} />}
						<div className={form.actions}>
							<Link
								href={`/status?tab=updates&open=${popup.updateId}`}
								className={form.secondary}
							>
								Details
							</Link>
							<button
								type="button"
								className={form.primary}
								onClick={() => {
									setPopupGone(true);
									postRead(popup.updateId, popup.requireAck);
								}}
							>
								{popup.requireAck ? "Acknowledge" : "Got it"}
							</button>
						</div>
					</div>
				</Modal>
			)}
		</>
	);
}

// The latest few on Home.
export function UpdatesHomeCard() {
	const { data } = useLiveUpdates();
	const shown = (data?.updates ?? [])
		.filter((update) => update.delivery.home)
		.slice(0, 4);
	if (shown.length === 0) return null;
	return (
		<section className={styles.homeCard}>
			<div className={styles.homeHead}>
				<strong>Updates</strong>
				<Link href="/status?tab=updates" className={styles.link}>
					See them all
				</Link>
			</div>
			{shown.map((update) => (
				<Link
					key={update.updateId}
					href={`/status?tab=updates&open=${update.updateId}`}
					className={styles.fieldUpdate}
				>
					{update.title}
				</Link>
			))}
		</section>
	);
}

function shortDate(at: string | number): string {
	return new Date(at).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

// When the entry applies, in the reader's words.
export function whenOf(update: LiveUpdate, now: number): string {
	if (update.type === "maintenance") {
		const window = currentWindow(update, now);
		if (!window) return "Finished";
		return window.start > now
			? `Starts in ${countdown(window.start, now)}`
			: `Under way, ends in ${countdown(window.end, now)}`;
	}
	if (update.type === "incident") {
		return update.incidentState === "identified"
			? "Cause found, being fixed"
			: "Being looked into";
	}
	if (update.effectiveOn) {
		const at = new Date(update.effectiveOn).getTime();
		return at > now
			? `Takes effect ${shortDate(at)}`
			: `Took effect ${shortDate(at)}`;
	}
	return `Posted ${shortDate(update.postedOn)}`;
}

const impactRank = { info: 0, notable: 1, breaking: 2 } as const;

export function NoticeIcon({ type }: { type: LiveUpdate["type"] }) {
	const paths =
		type === "maintenance" ? (
			<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
		) : type === "incident" ? (
			<>
				<circle cx="12" cy="12" r="10" />
				<path d="M12 8v4M12 16h.01" />
			</>
		) : (
			<>
				<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
				<path d="M12 9v4M12 17h.01" />
			</>
		);
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
			aria-hidden="true"
		>
			{paths}
		</svg>
	);
}

function Chevron({ open }: { open: boolean }) {
	return (
		<svg
			className={open ? styles.chevronOpen : styles.chevron}
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="m6 9 6 6 6-6" />
		</svg>
	);
}

function Arrow() {
	return (
		<svg
			className={styles.noticeArrow}
			width="16"
			height="16"
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

function Cross() {
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
			aria-hidden="true"
		>
			<path d="M18 6 6 18M6 6l12 12" />
		</svg>
	);
}

// When an entry applies and what to do about it, as one line.
function MetaLine({
	update,
	now,
	extra,
}: {
	update: LiveUpdate;
	now: number;
	extra: string | null;
}) {
	return (
		<span className={styles.noticeMeta}>
			{whenOf(update, now)}
			{extra && (
				<>
					<span className={styles.noticeDot} aria-hidden="true">
						·
					</span>
					<span className={styles.noticeWhat}>{extra}</span>
				</>
			)}
		</span>
	);
}

// Entries about what a screen shows, as one line however many there are. One entry is that
// line and opens its details. Several are counted on the line, which opens a list of them.
// Dismissing marks them read for this person, which takes them off every page.
function UpdateNotices({
	updates,
	subject,
	note,
	onDismiss,
}: {
	updates: LiveUpdate[];
	// What the entries are about, as in "2 recent changes to {subject}".
	subject: string;
	// A line of its own under one entry, such as what a maintenance window means here.
	note?: (update: LiveUpdate) => string | null;
	onDismiss: (updateIds: string[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const now = Date.now();
	const worst = updates.reduce<LiveUpdate["impact"]>(
		(held, update) =>
			impactRank[update.impact] > impactRank[held] ? update.impact : held,
		"info",
	);
	const extraOf = (update: LiveUpdate) => note?.(update) ?? update.whatToDo;
	const linkOf = (update: LiveUpdate) =>
		`/status?tab=updates&open=${update.updateId}`;
	const single = updates.length === 1 ? updates[0] : null;
	const newest = updates[0];
	const icon = (
		<span
			className={`${styles.noticeIcon} ${styles[`noticeIcon${worst}`]}`}
		>
			<NoticeIcon type={newest.type} />
		</span>
	);

	return (
		<section
			className={`${styles.notices} ${styles[`notices${worst}`]}`}
			role="status"
		>
			<div className={styles.noticeBar}>
				{single ? (
					<Link
						href={linkOf(single)}
						className={styles.noticeSummary}
					>
						{icon}
						<span className={styles.noticeText}>
							<strong className={styles.noticeTitle}>
								{single.title}
							</strong>
							<MetaLine
								update={single}
								now={now}
								extra={extraOf(single)}
							/>
						</span>
						<Arrow />
					</Link>
				) : (
					<button
						type="button"
						className={styles.noticeSummary}
						onClick={() => setOpen((was) => !was)}
						aria-expanded={open}
					>
						{icon}
						<span className={styles.noticeText}>
							<strong className={styles.noticeTitle}>
								{updates.length} recent changes to {subject}
							</strong>
							<span className={styles.noticeMeta}>
								<span className={styles.noticeWhat}>
									Newest: {newest.title}
								</span>
							</span>
						</span>
						<Chevron open={open} />
					</button>
				)}
				<button
					type="button"
					className={styles.noticeDismiss}
					onClick={() =>
						onDismiss(updates.map((update) => update.updateId))
					}
					aria-label={
						single ? "Dismiss this notice" : "Dismiss these notices"
					}
					title="Dismiss"
				>
					<Cross />
				</button>
			</div>
			{!single && open && (
				<div className={styles.noticeList}>
					{updates.map((update) => (
						<Link
							key={update.updateId}
							href={linkOf(update)}
							className={styles.noticeItem}
						>
							<span
								className={`${styles.noticeMark} ${styles[`noticeMark${update.impact}`]}`}
								aria-hidden="true"
							/>
							<span className={styles.noticeText}>
								<span className={styles.noticeItemTitle}>
									{update.title}
								</span>
								<MetaLine
									update={update}
									now={now}
									extra={extraOf(update)}
								/>
							</span>
							<Arrow />
						</Link>
					))}
					<Link
						href="/status?tab=updates"
						className={styles.noticeAll}
					>
						Open the changelog
					</Link>
				</div>
			)}
		</section>
	);
}

// Marks the entries read for this person and takes them off the screen at once.
function useDismissUpdates() {
	const { mutate } = useLiveUpdates();
	return (updateIds: string[]) => {
		for (const updateId of updateIds) postRead(updateId);
		const gone = new Set(updateIds);
		void mutate(
			(current) =>
				current && {
					...current,
					updates: current.updates.map((update) =>
						gone.has(update.updateId)
							? { ...update, read: true }
							: update,
					),
				},
			{ revalidate: false },
		);
	};
}

export interface PageScope {
	sourceKeys: string[];
	reportId: string;
	categoryId: string | null;
	pageId: string | null;
}

// What a report page is told about what it reads, for a while after it changes, and the
// way to set each aside. Shown in the page's data status rather than above the report. See
// onPagesNow in lib/updates/model and app/r/DataHealth.
export function usePageChanges(scope: PageScope): {
	changes: LiveUpdate[];
	dismiss: (updateIds: string[]) => void;
} {
	const { data } = useLiveUpdates();
	const dismiss = useDismissUpdates();
	const now = Date.now();
	const changes = (data?.updates ?? []).filter(
		(update) =>
			!update.read && onPagesNow(update, now) && aboutPage(update, scope),
	);
	return { changes, dismiss };
}

// The changes naming a field each visual on a page reads, by visual, so a visual a change
// affects can say so in its own header.
const VisualChangesContext = createContext<Map<string, LiveUpdate[]>>(
	new Map(),
);

export function VisualChangesProvider({
	visuals,
	changes,
	children,
}: {
	visuals: { visualId: string; sourceKey: string | null; fields: string[] }[];
	changes: LiveUpdate[];
	children: React.ReactNode;
}) {
	const byVisual = useMemo(() => {
		const found = new Map<string, LiveUpdate[]>();
		for (const visual of visuals) {
			const sourceKey = visual.sourceKey;
			if (!sourceKey || visual.fields.length === 0) continue;
			const wanted = new Set(visual.fields);
			const touching = changes.filter((update) =>
				update.about.some(
					(item) =>
						item.kind === "field" &&
						item.sourceKey === sourceKey &&
						wanted.has(item.id),
				),
			);
			if (touching.length > 0) found.set(visual.visualId, touching);
		}
		return found;
	}, [visuals, changes]);
	return (
		<VisualChangesContext.Provider value={byVisual}>
			{children}
		</VisualChangesContext.Provider>
	);
}

function fieldName(entry: unknown): string | null {
	if (typeof entry === "string") return entry;
	const name = (entry as { name?: unknown } | null)?.name;
	return typeof name === "string" ? name : null;
}

// The changes on a report page, handed to each visual whose fields they name. A visual with
// no source of its own reads the page's.
export function PageVisualChanges({
	scope,
	pageSourceKey,
	visuals,
	children,
}: {
	scope: PageScope;
	pageSourceKey: string | null;
	visuals: {
		visualId: string;
		sourceKey: string | null;
		config: { dimensions?: unknown; measures?: unknown };
	}[];
	children: React.ReactNode;
}) {
	const { changes } = usePageChanges(scope);
	const read = useMemo(
		() =>
			visuals.map((visual) => ({
				visualId: visual.visualId,
				sourceKey: visual.sourceKey ?? pageSourceKey,
				fields: [visual.config.dimensions, visual.config.measures]
					.flatMap((list) => (Array.isArray(list) ? list : []))
					.map(fieldName)
					.filter((name): name is string => name !== null),
			})),
		[visuals, pageSourceKey],
	);
	return (
		<VisualChangesProvider visuals={read} changes={changes}>
			{children}
		</VisualChangesProvider>
	);
}

const noChanges: LiveUpdate[] = [];

export function useVisualChanges(
	visualId: string | null | undefined,
): LiveUpdate[] {
	const byVisual = useContext(VisualChangesContext);
	return (visualId && byVisual.get(visualId)) || noChanges;
}

// Marks at the dates things took effect, by source, read by a chart as it draws.
export const UpdateMarkersContext = createContext<UpdateMarker[]>([]);

export function useUpdateMarkers(sourceKey: string | null | undefined) {
	const markers = useContext(UpdateMarkersContext);
	return useMemo(
		() =>
			sourceKey
				? markers.filter((marker) =>
						marker.sourceKeys.includes(sourceKey),
					)
				: [],
		[markers, sourceKey],
	);
}

// Asked for by the sources the page reads, so only their markers come back.
export function UpdateMarkersProvider({
	sourceKeys,
	children,
}: {
	sourceKeys: string[];
	children: React.ReactNode;
}) {
	const { data } = useSWR<{ markers: UpdateMarker[] }>(
		markersKey(sourceKeys),
		{ refreshInterval: 5 * 60_000, dedupingInterval: 60_000 },
	);
	const markers = data?.markers ?? noMarkers;
	return (
		<UpdateMarkersContext.Provider value={markers}>
			{children}
		</UpdateMarkersContext.Provider>
	);
}

const noMarkers: UpdateMarker[] = [];

// Changes to one field, for its entry in the Dictionary, asked for that field alone.
export function FieldUpdates({
	sourceKey,
	field,
}: {
	sourceKey: string;
	field: string;
}) {
	const { data } = useSWR<{
		updates: { updateId: string; title: string; postedOn: string }[];
	}>(
		`/api/changes?fieldSource=${encodeURIComponent(sourceKey)}&field=${encodeURIComponent(field)}`,
	);
	const shown = data?.updates ?? [];
	if (shown.length === 0) return null;
	return (
		<div>
			<strong>Updates</strong>
			{shown.map((update) => (
				<Link
					key={update.updateId}
					href={`/status?tab=updates&open=${update.updateId}`}
					className={styles.fieldUpdate}
				>
					{new Date(update.postedOn).toLocaleDateString()}:{" "}
					{update.title}
				</Link>
			))}
		</div>
	);
}

// Maintenance and incidents beside freshness and rules on Data status.
export function StatusUpdates() {
	const { data } = useLiveUpdates();
	const dismiss = useDismissUpdates();
	const now = Date.now();
	const shown = (data?.updates ?? []).filter(
		(update) =>
			!update.read &&
			(update.type === "incident"
				? update.incidentState !== "resolved"
				: update.type === "maintenance" &&
					currentWindow(update, now) !== null),
	);
	if (shown.length === 0) return null;
	return (
		<UpdateNotices
			updates={shown}
			subject="these datasets"
			onDismiss={dismiss}
			note={(update) =>
				update.type === "maintenance" && isUnderway(update, now)
					? "Late data and failing rules on it are expected."
					: null
			}
		/>
	);
}
