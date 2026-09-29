"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { SkeletonTable } from "../components/shared/Skeleton";
import { Toggle } from "../components/shared/Toggle";
import { usePageTitle } from "../hooks/usePageTitle";
import { describeFetchError } from "../../lib/swr";
import styles from "./Status.module.css";

// Whether the data behind each source is current, for everyone who reads it.
//
// Built on the same judgement as the late-data notices, which learns when each
// source's tables usually load from their history and checks whether the
// latest load has arrived. Only sources the reader can read are listed.

type State =
	| "late"
	| "overdue"
	| "on_time"
	| "learning"
	| "irregular"
	| "off"
	| "unwatched";

interface SourceStatus {
	sourceKey: string;
	title: string;
	description: string | null;
	state: State;
	watched: boolean;
	live: boolean;
	lastChanged: string | null;
	expectedBy: string | null;
	checkedOn: string | null;
	pattern: string | null;
	subscribed: boolean;
}

const stateLabels: Record<State, string> = {
	late: "Late",
	overdue: "Checking",
	on_time: "On time",
	learning: "Learning",
	irregular: "Irregular",
	off: "Not judged",
	unwatched: "On a timer",
};

type Group = "late" | "current" | "learning" | "other";

function groupOf(state: State): Group {
	if (state === "late") return "late";
	if (state === "on_time" || state === "overdue") return "current";
	if (state === "learning") return "learning";
	return "other";
}

const groupLabels: Record<Group, string> = {
	late: "Late",
	current: "On time",
	learning: "Learning",
	other: "Not judged",
};

// Late first, since that is what somebody opening this came to find.
const order: Record<State, number> = {
	late: 0,
	overdue: 1,
	on_time: 2,
	learning: 3,
	irregular: 4,
	off: 5,
	unwatched: 6,
};

// Asked again every few minutes, which is as often as a late load is likely
// to land and be noticed.
const refreshMs = 5 * 60 * 1000;

function browserZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

function ago(iso: string | null, now: number): string | null {
	if (!iso) return null;
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return null;
	const minutes = Math.round((now - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	return `${Math.round(hours / 24)} days ago`;
}

function when(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	return at.toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

// What the state means for this source, in a sentence.
function explanation(source: SourceStatus): string {
	switch (source.state) {
		case "late":
			return source.expectedBy
				? `Expected by ${when(source.expectedBy)} and nothing new has arrived.`
				: "Past the time it usually updates and nothing new has arrived.";
		case "overdue":
			return "Past the time it usually updates. A check is on its way.";
		case "on_time":
			return source.expectedBy
				? `Next update expected by ${when(source.expectedBy)}.`
				: "Updating as usual.";
		case "learning":
			return "Too few updates seen yet to know when it usually updates.";
		case "irregular":
			return "Updates at no steady rhythm, so it is never called late.";
		case "off":
			return "Lateness is not judged for this source.";
		case "unwatched":
			return source.live
				? "Live, refreshed on a short timer rather than watched for loads."
				: "Refreshed on a timer, so when it loads is not known.";
	}
}

export default function StatusView() {
	usePageTitle("Data status");

	const { data, error, isLoading, mutate } = useSWR<{
		sources: SourceStatus[];
	}>(`/api/status/?tz=${encodeURIComponent(browserZone())}`, {
		refreshInterval: refreshMs,
	});

	const [term, setTerm] = useState("");
	const [group, setGroup] = useState<Group | null>(null);
	const [saving, setSaving] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const sources = useMemo(
		() =>
			[...(data?.sources ?? [])].sort(
				(a, b) =>
					order[a.state] - order[b.state] ||
					a.title.localeCompare(b.title),
			),
		[data],
	);

	const counts = useMemo(() => {
		const out: Record<Group, number> = {
			late: 0,
			current: 0,
			learning: 0,
			other: 0,
		};
		for (const s of sources) out[groupOf(s.state)]++;
		return out;
	}, [sources]);

	const shown = useMemo(() => {
		const needle = term.trim().toLowerCase();
		return sources.filter(
			(s) =>
				(!group || groupOf(s.state) === group) &&
				(!needle ||
					s.title.toLowerCase().includes(needle) ||
					(s.description ?? "").toLowerCase().includes(needle)),
		);
	}, [sources, term, group]);

	const subscribe = async (source: SourceStatus, subscribed: boolean) => {
		setSaving(source.sourceKey);
		setFailure(null);
		const toggled = (current?: { sources: SourceStatus[] }) => ({
			sources: (current?.sources ?? []).map((s) =>
				s.sourceKey === source.sourceKey ? { ...s, subscribed } : s,
			),
		});
		// Shown at once, and put back if the server says no.
		await mutate(
			async (current) => {
				const response = await fetch("/api/status/", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sourceKey: source.sourceKey,
						subscribed,
					}),
				});
				if (!response.ok) {
					const body = await response.json().catch(() => null);
					throw new Error(
						body?.error ?? "That choice could not be saved.",
					);
				}
				return toggled(current);
			},
			{
				optimisticData: toggled,
				rollbackOnError: true,
				revalidate: false,
			},
		).catch((e: unknown) => {
			setFailure(
				e instanceof Error
					? e.message
					: "That choice could not be saved.",
			);
		});
		setSaving(null);
	};

	const now = Date.now();

	return (
		<div className={styles.page}>
			<header className={styles.header}>
				<h1 className={styles.title}>Data status</h1>
				<p className={styles.subtitle}>
					When each source you can read last updated, and whether its
					latest load arrived when it usually does.
				</p>
			</header>

			{error ? (
				<div className={styles.state}>
					{describeFetchError(error, "data status")}
				</div>
			) : isLoading && !data ? (
				<SkeletonTable rows={6} columns={3} />
			) : (
				<>
					<div className={styles.toolbar}>
						<div
							className={styles.summary}
							role="group"
							aria-label="Show sources that are"
						>
							{(Object.keys(groupLabels) as Group[]).map((g) => (
								<button
									key={g}
									type="button"
									className={`${styles.count} ${styles[`count_${g}`]} ${
										group === g ? styles.countActive : ""
									}`}
									aria-pressed={group === g}
									onClick={() =>
										setGroup(group === g ? null : g)
									}
								>
									<span className={styles.countValue}>
										{counts[g]}
									</span>
									<span className={styles.countLabel}>
										{groupLabels[g]}
									</span>
								</button>
							))}
						</div>
						<input
							className={styles.search}
							type="search"
							placeholder="Find a source"
							value={term}
							onChange={(e) => setTerm(e.target.value)}
							aria-label="Find a source"
						/>
					</div>

					{failure && (
						<p className={styles.failure} role="alert">
							{failure}
						</p>
					)}

					{shown.length === 0 ? (
						<div className={styles.state}>
							{sources.length === 0
								? "There are no sources you can read."
								: "No sources match."}
						</div>
					) : (
						<ul className={styles.list}>
							{shown.map((source) => {
								const updated = ago(source.lastChanged, now);
								const canBeLate =
									source.watched && source.state !== "off";
								const g = groupOf(source.state);
								return (
									<li
										key={source.sourceKey}
										className={`${styles.row} ${styles[`row_${g}`]}`}
									>
										<div className={styles.main}>
											<div className={styles.nameLine}>
												<span className={styles.name}>
													{source.title}
												</span>
												<span
													className={`${styles.pill} ${styles[`pill_${g}`]}`}
												>
													{stateLabels[source.state]}
												</span>
											</div>
											<p className={styles.detail}>
												{explanation(source)}
												{source.pattern &&
												source.state !== "learning"
													? ` ${source.pattern}`
													: ""}
											</p>
										</div>
										<div className={styles.updated}>
											<span
												className={styles.updatedLabel}
											>
												Last updated
											</span>
											<span
												className={styles.updatedValue}
												title={
													source.lastChanged
														? when(
																source.lastChanged,
															)
														: undefined
												}
											>
												{updated ?? "Not seen yet"}
											</span>
										</div>
										<div className={styles.notify}>
											{canBeLate && (
												<Toggle
													checked={source.subscribed}
													onChange={(on) =>
														void subscribe(
															source,
															on,
														)
													}
													disabled={
														saving ===
														source.sourceKey
													}
													label="Tell me when it is late"
												/>
											)}
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</>
			)}
		</div>
	);
}
