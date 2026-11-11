"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "../components/AppLink";
import { Modal } from "../components/shared/Modal";
import { TextPanel } from "../visuals/TextPanel";
import { aboutPage, currentWindow, isUnderway } from "../../lib/updates/model";
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

// What a report page is told about what it reads.
export function PageUpdates({
	sourceKeys,
	reportId,
	categoryId,
	pageId,
}: {
	sourceKeys: string[];
	reportId: string;
	categoryId: string | null;
	pageId: string | null;
}) {
	const { data } = useLiveUpdates();
	const now = Date.now();
	const shown = (data?.updates ?? []).filter(
		(update) =>
			update.delivery.page &&
			aboutPage(update, { sourceKeys, reportId, categoryId, pageId }) &&
			(update.type === "incident"
				? update.incidentState !== "resolved"
				: update.type === "maintenance"
					? isUnderway(update, now)
					: update.impact === "breaking"),
	);
	if (shown.length === 0) return null;
	return (
		<>
			{shown.map((update) => (
				<div
					key={update.updateId}
					className={styles.pageNotice}
					role="status"
				>
					<span>
						<strong>{update.title}</strong>
						{update.type === "maintenance"
							? ". Figures may be behind until this finishes."
							: "."}{" "}
						<Link
							href={`/status?tab=updates&open=${update.updateId}`}
						>
							Details
						</Link>
					</span>
				</div>
			))}
		</>
	);
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
	const now = Date.now();
	const shown = (data?.updates ?? []).filter((update) =>
		update.type === "incident"
			? update.incidentState !== "resolved"
			: update.type === "maintenance" &&
				currentWindow(update, now) !== null,
	);
	if (shown.length === 0) return null;
	return (
		<>
			{shown.map((update) => (
				<div
					key={update.updateId}
					className={styles.pageNotice}
					role="status"
				>
					<span>
						<strong>{update.title}</strong>
						{update.type === "maintenance" &&
						isUnderway(update, now)
							? " is under way, so late data and failing rules on it are expected."
							: "."}{" "}
						<Link
							href={`/status?tab=updates&open=${update.updateId}`}
						>
							Details
						</Link>
					</span>
				</div>
			))}
		</>
	);
}
