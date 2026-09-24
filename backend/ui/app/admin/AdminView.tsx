"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { describeFetchError } from "../../lib/swr";
import { formatCompact } from "../../lib/format";
import {
	Skeleton,
	SkeletonTable,
	SkeletonText,
} from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { usePageTitle } from "../hooks/usePageTitle";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { ErrorBoundary } from "../components/shared/ErrorBoundary";
import { AccessSettings } from "./AccessSettings";
import { AccessReviewPane } from "./AccessReviewPane";
import { ActivityPane } from "./ActivityPane";
import { AddSourceButton } from "./AddSource";
import { EditSourceDialog } from "./EditSourceDialog";
import { SyncFreshness } from "./SyncFreshness";
import CategoriesPane from "./CategoriesPane";
import PersonalPagesPane from "./PersonalPagesPane";
import RolesPane from "./RolesPane";
import { AdminRail } from "./AdminRail";
import { DailyActivity } from "./DailyActivity";
import { ago, clock } from "./when";
import { groupOf, paneDetail, paneFrom, type PaneId } from "./nav";
import styles from "./Admin.module.css";

// Administration: adoption, cost, failures, and who can reach what.
//
// One rail lists every destination under a group heading and one pane answers
// at a time. The groups exist because the audiences differ: Activity is for
// whoever owns the reporting estate, Access and Audit for whoever answers an
// access review, Content for whoever curates what people open, and Platform for
// whoever gets paged.

interface Summary {
	activeUsers: number;
	pageViews: number;
	queries: number;
	exports: number;
	errors: number;
	cacheHitRate: number;
	medianQueryMs: number;
	p95QueryMs: number;
}

interface UsageResponse {
	days: number;
	summary: Summary;
	reports: {
		reportId: string;
		title: string;
		categoryId: string | null;
		views: number;
		distinctUsers: number;
		avgDurationMs: number;
		lastViewed: string | null;
	}[];
	users: {
		userEmail: string;
		events: number;
		reports: number;
		exports: number;
		lastSeen: string;
	}[];
	slow: {
		sourceKey: string | null;
		queries: number;
		avgQueryMs: number;
		maxQueryMs: number;
		cacheHitRate: number;
	}[];
	daily: { day: string; events: number; users: number }[];
}

interface SecurityResponse {
	editorGroups: string[];
	adminGroups: string[];
	policyGroups: { name: string; scope: string; origin: string }[];
	filterDiscovery: {
		at: number | null;
		unreadableSources: string[];
		failureReason: string | null;
	};
	filteredSources: number;
	exports: {
		logId: string;
		recordId: string;
		action: string;
		changedBy: string;
		changedOn: string;
		detail: string | null;
		notes: string | null;
	}[];
}

interface PlatformResponse {
	runtime: Record<string, unknown>;
	replica: Record<string, unknown>;
	settings: Record<string, unknown>;
	lastSync?: {
		runId: string;
		startedBy: string;
		startedOn: string;
		finishedOn: string | null;
		total: number;
		completed: number;
		error: string | null;
		// Neither finished nor heard from recently, so nothing is running and
		// the button should offer to start one.
		abandoned?: boolean;
	} | null;
	sources: {
		sourceKey: string;
		title: string;
		kind: string;
		object: string;
		hasRowFilter: boolean;
		cacheTtlSeconds: number;
		dimensions: number;
		measures: number;
	}[];
}

// An instant in a table cell. The elapsed time is what gets scanned down the
// column, and the clock reading is one hover away rather than widening every
// row that carries one.
function When({ iso }: { iso: string | null }) {
	if (!iso) return <>-</>;
	return <span title={clock(iso)}>{ago(iso)}</span>;
}

export default function AdminView() {
	usePageTitle("Administration");

	// Null while the router has not settled, which is a state the hook admits
	// and every read below would otherwise throw on.
	const params = useSearchParams() ?? new URLSearchParams();
	const pane = paneFrom(params.get("pane"));
	const detail = paneDetail(pane);
	const feed = detail.feed;
	const days = windowFrom(params.get("days"));

	// The open pane and the window live in the address, so a pane can be linked,
	// bookmarked and reached with the back button. Held in component state they
	// could be none of those, and every save that reloaded the page dropped the
	// reader back on the first pane of the first group.
	//
	// Written through the history API rather than the router: the page is
	// already mounted and a route transition would remount it to change a
	// string. Next reads these back through useSearchParams either way.
	const go = (patch: Record<string, string>) => {
		const next = new URLSearchParams(params.toString());
		for (const [name, value] of Object.entries(patch))
			next.set(name, value);
		window.history.pushState(null, "", `?${next.toString()}`);
	};

	// One request for whichever pane is open. Panes marked "own" fetch for
	// themselves and panes marked "settings" read the settings endpoint through
	// ConfigurationSection, so the shell asks for nothing on their behalf.
	const key =
		feed === "usage"
			? `/api/admin?days=${days}`
			: feed === "security"
				? "/api/admin?section=security"
				: feed === "platform"
					? "/api/admin?section=platform"
					: null;

	const { data, error, isLoading, mutate } = useSWR(key);
	// Both admin sections answer from cache, so a placeholder shown on every
	// pane change would blink rather than inform.
	const showSkeleton = useDeferredLoading(isLoading);

	const waiting = Boolean(key) && (isLoading || !data);

	const body = () => {
		if (error) {
			return (
				<div className={styles.state}>
					{describeFetchError(error, "pane")}
				</div>
			);
		}

		switch (pane) {
			case "roles":
				return <RolesPane show="roles" />;
			case "assignments":
				return <RolesPane show="assignments" />;
			case "grants":
				return <AccessGrants />;
			case "review":
				return <AccessReview />;
			case "baseline":
				return <AccessSettings />;
			case "changes":
				return <ActivityPane />;
			case "categories":
				return <CategoriesPane />;
			case "personal":
				return <PersonalPagesPane />;
			case "branding":
			case "warehouse":
			case "caching":
				return <ConfigurationSection group={pane} />;
		}

		if (waiting) {
			return showSkeleton ? (
				<>
					<SkeletonText lines={2} />
					<SkeletonTable rows={5} columns={4} />
				</>
			) : null;
		}

		if (feed === "usage") {
			return (
				<UsageSection
					data={data as UsageResponse}
					pane={pane}
					days={days}
				/>
			);
		}
		if (feed === "security") {
			return (
				<SecuritySection data={data as SecurityResponse} pane={pane} />
			);
		}
		return (
			<PlatformSection
				data={data as PlatformResponse}
				pane={pane}
				onRefresh={() => void mutate()}
			/>
		);
	};

	return (
		<div className={styles.page}>
			<AdminRail active={pane} onSelect={(id) => go({ pane: id })} />

			<div className={styles.main}>
				<header className={styles.paneHeader}>
					<div className={styles.paneHeading}>
						{/* The group the open pane sits in. The rail shows it too,
						    and on a narrow screen where the rail has collapsed to a
						    strip this is the only thing that does. */}
						<p className={styles.paneGroup}>{groupOf(pane)}</p>
						<h1 className={styles.paneTitle}>{detail.label}</h1>
						<p className={styles.paneBlurb}>{detail.blurb}</p>
					</div>

					{/* Beside the heading of the pane it filters rather than above
					    the whole page, where it read as applying to panes that do
					    not have a window at all. */}
					{feed === "usage" && (
						<div className={styles.controls}>
							{usageWindows.map((d) => (
								<button
									key={d}
									type="button"
									className={`${styles.rangeButton} ${
										days === d ? styles.rangeActive : ""
									}`}
									aria-pressed={days === d}
									onClick={() => go({ days: String(d) })}
								>
									{d === 1 ? "24 hours" : `${d} days`}
								</button>
							))}
						</div>
					)}
				</header>

				{/* Every pane reads a different endpoint, and any of them can
				    answer with an error object where the pane expects a list.
				    Reading a property off that throws during render, which without
				    this takes the whole administration page including the rail that
				    would let somebody open a pane that works. Keyed on the pane, so
				    switching away and back retries. */}
				<ErrorBoundary label={detail.label} resetKey={pane}>
					{body()}
				</ErrorBoundary>
			</div>
		</div>
	);
}

// The windows the activity panes can be read over.
const usageWindows = [1, 7, 30, 90] as const;

function windowFrom(value: string | null): number {
	const asked = Number(value);
	return usageWindows.includes(asked as (typeof usageWindows)[number])
		? asked
		: 7;
}

// The access review needs a report to ask about, and the grants pane already
// assembles that list for its own scope picker. Reading the same key shares
// that answer rather than asking for it a second time.
function AccessReview() {
	const { data } = useSWR<Partial<AccessResponse>>("/api/admin/access");
	return <AccessReviewPane reports={data?.reports ?? []} />;
}

// Where the overview tiles change colour. The hint under each value is built
// from the same numbers the tone is, so the line being shown and the line being
// applied cannot drift apart.
//
// Below the warn mark on cache hits, most interactions still reach the
// warehouse, which is the cost driver worth watching.
const cacheHitGood = 70;
const cacheHitWarn = 40;
const slowQueryMs = 5000;
const verySlowQueryMs = 10000;

function UsageSection({
	data,
	pane,
	days,
}: {
	data: UsageResponse;
	pane: PaneId;
	days: number;
}) {
	const { summary, daily } = data;
	// Which row an admin has opened. A drawer rather than a separate page: the
	// question is always why that row looks like that, so the row it came from
	// should stay on screen behind it.
	const [drill, setDrill] = useState<Drill | null>(null);

	return (
		<>
			{pane === "overview" && (
				<>
					<div className={styles.tiles}>
						<Tile
							label="Active users"
							value={summary.activeUsers.toLocaleString()}
							hint="Signed in and did something"
						/>
						<Tile
							label="Page views"
							value={formatCompact(summary.pageViews, "integer")}
							hint="One per report page opened"
						/>
						<Tile
							label="Queries"
							value={formatCompact(summary.queries, "integer")}
							hint="Includes answers served from cache"
						/>
						<Tile
							label="Exports"
							value={summary.exports.toLocaleString()}
							hint="Downloads of underlying rows"
						/>
						<Tile
							label="Errors"
							value={summary.errors.toLocaleString()}
							tone={summary.errors > 0 ? "bad" : "good"}
							hint={
								summary.errors > 0
									? "Each one is a query somebody watched fail"
									: "No query failed in this window"
							}
						/>
						<Tile
							label="Cache hit rate"
							value={`${summary.cacheHitRate.toFixed(1)}%`}
							tone={
								summary.cacheHitRate >= cacheHitGood
									? "good"
									: summary.cacheHitRate >= cacheHitWarn
										? "warn"
										: "bad"
							}
							hint={`Answered without the warehouse. Healthy from ${cacheHitGood}%`}
						/>
						<Tile
							label="Median query"
							value={`${summary.medianQueryMs}ms`}
							hint="Half of queries finished faster"
						/>
						<Tile
							label="p95 query"
							value={`${summary.p95QueryMs}ms`}
							tone={
								summary.p95QueryMs > verySlowQueryMs
									? "bad"
									: summary.p95QueryMs > slowQueryMs
										? "warn"
										: "good"
							}
							hint={`One in twenty was slower. Slow past ${slowQueryMs / 1000}s`}
						/>
					</div>

					<DailyActivity daily={daily} />
				</>
			)}

			{pane === "reports" && (
				<>
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>Report</th>
									<th>Category</th>
									<th className={styles.numeric}>Views</th>
									<th className={styles.numeric}>Users</th>
									<th className={styles.numeric}>Avg load</th>
									<th>Last viewed</th>
								</tr>
							</thead>
							<tbody>
								{data.reports.map((r) => (
									<tr
										key={r.reportId}
										className={styles.rowClickable}
										onClick={() =>
											setDrill({
												kind: "report",
												id: r.reportId,
												label: r.title,
											})
										}
										title="See who viewed this and when"
									>
										<td>{r.title}</td>
										<td>{r.categoryId ?? "-"}</td>
										<td className={styles.numeric}>
											{r.views.toLocaleString()}
										</td>
										<td className={styles.numeric}>
											{r.distinctUsers}
										</td>
										<td className={styles.numeric}>
											{r.avgDurationMs}ms
										</td>
										<td>
											<When iso={r.lastViewed} />
										</td>
									</tr>
								))}
								{data.reports.length === 0 && (
									<tr>
										<td colSpan={6}>
											No activity in this window
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</>
			)}

			{pane === "people" && (
				<>
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>User</th>
									<th className={styles.numeric}>Events</th>
									<th className={styles.numeric}>Reports</th>
									<th className={styles.numeric}>Exports</th>
									<th>Last seen</th>
								</tr>
							</thead>
							<tbody>
								{data.users.map((u) => (
									<tr
										key={u.userEmail}
										className={styles.rowClickable}
										onClick={() =>
											setDrill({
												kind: "user",
												id: u.userEmail,
												label: u.userEmail,
											})
										}
										title="See everything this person has done"
									>
										<td>{u.userEmail}</td>
										<td className={styles.numeric}>
											{u.events.toLocaleString()}
										</td>
										<td className={styles.numeric}>
											{u.reports}
										</td>
										<td className={styles.numeric}>
											{u.exports}
										</td>
										<td>
											<When iso={u.lastSeen} />
										</td>
									</tr>
								))}
								{data.users.length === 0 && (
									<tr>
										<td colSpan={5}>
											No activity in this window
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</>
			)}

			{pane === "performance" && (
				<>
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>Source</th>
									<th className={styles.numeric}>Queries</th>
									<th className={styles.numeric}>Avg</th>
									<th className={styles.numeric}>Max</th>
									<th className={styles.numeric}>
										Cache hit
									</th>
								</tr>
							</thead>
							<tbody>
								{data.slow.map((s) => (
									<tr key={s.sourceKey ?? "unknown"}>
										<td className={styles.mono}>
											{s.sourceKey ?? "-"}
										</td>
										<td className={styles.numeric}>
											{s.queries.toLocaleString()}
										</td>
										<td className={styles.numeric}>
											{s.avgQueryMs}ms
										</td>
										<td className={styles.numeric}>
											{s.maxQueryMs}ms
										</td>
										<td className={styles.numeric}>
											{s.cacheHitRate.toFixed(0)}%
										</td>
									</tr>
								))}
								{data.slow.length === 0 && (
									<tr>
										<td colSpan={5}>
											No queries in this window
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</>
			)}

			{drill && (
				<DrillDrawer
					drill={drill}
					days={days}
					onClose={() => setDrill(null)}
					onOpenUser={(userEmail) =>
						setDrill({
							kind: "user",
							id: userEmail,
							label: userEmail,
						})
					}
				/>
			)}
		</>
	);
}

// --- Drill-in --------------------------------------------------------------

interface Drill {
	kind: "report" | "user";
	id: string;
	label: string;
}

interface ViewerRow {
	userEmail: string;
	views: number;
	exports: number;
	errors: number;
	firstViewed: string;
	lastViewed: string;
	avgDurationMs: number;
}

interface ActivityRow {
	occurredOn: string;
	eventType: string;
	reportId: string | null;
	reportTitle: string | null;
	reportSlug: string | null;
	sourceKey: string | null;
	durationMs: number | null;
	queryMs: number | null;
	rowCount: number | null;
	cacheHit: boolean | null;
	errorMessage: string | null;
}

// Who viewed a report, or what one person did.
//
// A report drill shows people rather than events, because the question about a
// report is who is relying on it. A user drill shows events rather than
// counts, because the question about a person is what they actually did.
function DrillDrawer({
	drill,
	days,
	onClose,
	onOpenUser,
}: {
	drill: Drill;
	days: number;
	onClose: () => void;
	onOpenUser: (userEmail: string) => void;
}) {
	const query =
		drill.kind === "report"
			? `/api/admin?section=report&reportId=${encodeURIComponent(drill.id)}&days=${days}`
			: `/api/admin?section=user&userEmail=${encodeURIComponent(drill.id)}&days=${days}`;

	const { data, isLoading } = useSWR<{
		viewers?: ViewerRow[];
		activity?: ActivityRow[];
	}>(query);
	const showSkeleton = useDeferredLoading(isLoading);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className={styles.drawerScrim} onClick={onClose}>
			<aside
				className={styles.drawer}
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-label={
					drill.kind === "report"
						? `Viewers of ${drill.label}`
						: `Activity for ${drill.label}`
				}
			>
				<div className={styles.drawerHeader}>
					<div>
						<div className={styles.drawerKind}>
							{drill.kind === "report" ? "Report" : "User"}
						</div>
						<h2 className={styles.drawerTitle}>{drill.label}</h2>
						<p className={styles.sectionNote}>
							{drill.kind === "report"
								? `Everyone who opened it in the last ${days} days, most frequent first.`
								: `Everything recorded for them in the last ${days} days, newest first.`}
						</p>
					</div>
					<button
						type="button"
						className={styles.drawerClose}
						onClick={onClose}
						aria-label="Close"
					>
						×
					</button>
				</div>

				{showSkeleton && <SkeletonTable rows={5} columns={4} />}

				{!isLoading && drill.kind === "report" && (
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>User</th>
									<th className={styles.numeric}>Views</th>
									<th className={styles.numeric}>Exports</th>
									<th className={styles.numeric}>Errors</th>
									<th className={styles.numeric}>Avg load</th>
									<th>First</th>
									<th>Last</th>
								</tr>
							</thead>
							<tbody>
								{(data?.viewers ?? []).map((v) => (
									<tr
										key={v.userEmail}
										className={styles.rowClickable}
										onClick={() => onOpenUser(v.userEmail)}
										title="See everything this person has done"
									>
										<td>{v.userEmail}</td>
										<td className={styles.numeric}>
											{v.views.toLocaleString()}
										</td>
										<td className={styles.numeric}>
											{v.exports}
										</td>
										<td className={styles.numeric}>
											{v.errors}
										</td>
										<td className={styles.numeric}>
											{v.avgDurationMs}ms
										</td>
										<td>
											<When iso={v.firstViewed} />
										</td>
										<td>
											<When iso={v.lastViewed} />
										</td>
									</tr>
								))}
								{(data?.viewers ?? []).length === 0 && (
									<tr>
										<td colSpan={7}>
											Nobody has opened this in the window
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				)}

				{!isLoading && drill.kind === "user" && (
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>When</th>
									<th>Did what</th>
									<th>Report</th>
									<th>Source</th>
									<th className={styles.numeric}>Waited</th>
									<th className={styles.numeric}>Rows</th>
									<th>Result</th>
								</tr>
							</thead>
							<tbody>
								{(data?.activity ?? []).map((event, i) => (
									<tr key={`${event.occurredOn}-${i}`}>
										<td title={event.occurredOn}>
											<When iso={event.occurredOn} />
										</td>
										<td>
											<span
												className={`${styles.eventChip} ${
													event.eventType === "error"
														? styles.eventError
														: ""
												}`}
											>
												{eventLabels[event.eventType] ??
													event.eventType}
											</span>
										</td>
										<td>{event.reportTitle ?? "-"}</td>
										<td className={styles.mono}>
											{event.sourceKey ?? "-"}
										</td>
										<td className={styles.numeric}>
											{event.durationMs === null
												? "-"
												: `${event.durationMs}ms`}
										</td>
										<td className={styles.numeric}>
											{event.rowCount === null
												? "-"
												: formatCompact(
														event.rowCount,
														"integer",
													)}
										</td>
										<td>
											{event.errorMessage
												? event.errorMessage
												: event.cacheHit === null
													? "-"
													: event.cacheHit
														? "Cached"
														: "Warehouse"}
										</td>
									</tr>
								))}
								{(data?.activity ?? []).length === 0 && (
									<tr>
										<td colSpan={7}>
											Nothing recorded in the window
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				)}
			</aside>
		</div>
	);
}

const eventLabels: Record<string, string> = {
	page_view: "Opened a page",
	query: "Ran a query",
	export: "Exported",
	edit: "Edited",
	error: "Hit an error",
};

// --- Configuration ---------------------------------------------------------

interface ConfigValues {
	appName: string;
	appDescription: string;
	appLogo: string;
	appLogoAdaptive: boolean;
	warehouseId: string;
	resultTtlSeconds: number;
	resultMaxEntries: number;
	resultMaxBytes: number;
	staleWhileRevalidate: boolean;
	refreshIntervalSeconds: number;
	groupCacheTtlSeconds: number;
	policyGraceSeconds: number;
	telemetryEnabled: boolean;
	editorGroups: string[];
	adminGroups: string[];
	accessModel: "catalog" | "grants";
}

// What an admin can change without a redeploy.
//
// These live in a table rather than in the environment, so changing one is an
// operational act: an admin edits it and every replica has it within a refresh
// interval.
//
// What is deliberately absent is the connection to that table. It has to be
// known before anything in it can be read, so it belongs to the deployment.
// Offering it as a form field would be offering to lock the platform out of
// the database that holds the form.
// Groups of settings, and what each one is for.
//
// A settings page that lists everything at once is read as a wall and skimmed,
// which is how a cache budget gets changed by somebody looking for the app
// name. Splitting by what an administrator came to do means each pane is short
// enough to read, and the one they want is a click rather than a scroll.

// One field. The hint is a line, not a paragraph: an explanation long enough
// to need reading twice is documentation, and it belongs where documentation
// goes rather than under an input somebody is trying to fill in.
function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<label className={styles.field}>
			<span className={styles.fieldLabel}>{label}</span>
			{children}
			{hint && <span className={styles.fieldHint}>{hint}</span>}
		</label>
	);
}

// A named set of settings that govern one thing.
//
// The pane was a flat run of inputs in an auto-fitting grid, so how many sat on
// a row depended on the window rather than on what they had to do with each
// other, and finding the one you came for meant reading every label.
function SettingGroup({
	title,
	blurb,
	children,
}: {
	title: string;
	blurb: string;
	children: ReactNode;
}) {
	return (
		<section className={styles.settingGroup}>
			<div className={styles.settingGroupHead}>
				<h3 className={styles.settingGroupTitle}>{title}</h3>
				<p className={styles.settingGroupBlurb}>{blurb}</p>
			</div>
			{children}
		</section>
	);
}

// A number with the unit it is in.
//
// The unit sits inside the field rather than beside it, so a column of these
// lines up on the input edge instead of on whatever the longest unit happened
// to be.
function NumberSetting({
	label,
	hint,
	unit,
	value,
	onChange,
}: {
	label: string;
	hint: string;
	unit: string;
	value: number;
	onChange: (value: number) => void;
}) {
	return (
		<label className={styles.numberSetting}>
			<span className={styles.fieldLabel}>{label}</span>
			<span className={styles.numberBox}>
				<input
					type="number"
					className={styles.numberInput}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
				/>
				<span className={styles.numberUnit}>{unit}</span>
			</span>
			<span className={styles.fieldHint}>{hint}</span>
		</label>
	);
}

// An on or off setting, laid out as a row rather than as a field.
//
// A switch in a column of number inputs reads as a field somebody forgot to
// fill in. Given the full width with the control on the right, it reads as what
// it is, and there is room for the sentence saying what turning it off costs.
function SwitchSetting({
	label,
	hint,
	checked,
	onChange,
}: {
	label: string;
	hint: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<div className={styles.switchSetting}>
			<div className={styles.switchText}>
				<span className={styles.fieldLabel}>{label}</span>
				<span className={styles.fieldHint}>{hint}</span>
			</div>
			<Toggle checked={checked} onChange={onChange} />
		</div>
	);
}

// The three settings panes. Each is a rail destination, so this renders the one
// it is handed rather than choosing between them, and the save bar spans all
// three because a draft can hold edits from any of them.
function ConfigurationSection({ group }: { group: PaneId }) {
	const { data, isLoading, mutate } = useSWR<{
		settings: ConfigValues;
		maxLogoBytes: number;
	}>("/api/admin/settings");

	const showSkeleton = useDeferredLoading(isLoading);

	const [draft, setDraft] = useState<ConfigValues | null>(null);
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const values = draft ?? data?.settings ?? null;
	const dirty = draft !== null;

	const set = (patch: Partial<ConfigValues>) => {
		if (!values) return;
		setSaved(false);
		setDraft({ ...values, ...patch });
	};

	const onLogoFile = (file: File | undefined) => {
		if (!file) return;
		setFailure(null);

		if (!/\.svg$/i.test(file.name)) {
			setFailure(
				"Marks are SVG. A raster image cannot stay sharp at every size or take its colour from the theme.",
			);
			return;
		}

		// Read as text, not as a data URI: the mark goes into the page so it
		// can follow the theme, and the server rebuilds it from an allow-list
		// before storing it.
		const reader = new FileReader();
		reader.onload = () => set({ appLogo: String(reader.result ?? "") });
		reader.onerror = () => setFailure("That file could not be read.");
		reader.readAsText(file);
	};

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		setFailure(null);
		try {
			const response = await fetch("/api/admin/settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(draft),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? "Could not save");
				return;
			}
			setDraft(null);
			setSaved(true);
			await mutate();
			// The header reads the same settings, so it is told rather than
			// left showing the old name until the next navigation.
			window.dispatchEvent(new Event("sightline:settings-changed"));
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "Could not save",
			);
		} finally {
			setSaving(false);
		}
	};

	if (isLoading || !values) {
		return showSkeleton ? <SkeletonText lines={6} /> : null;
	}

	const logoKb = Math.round(new Blob([values.appLogo ?? ""]).size / 1024);
	const limitKb = Math.round((data?.maxLogoBytes ?? 0) / 1024);

	return (
		<div className={styles.settings}>
			<div className={styles.settingsFields}>
				{group === "branding" && (
					<>
						<div className={styles.fieldRow}>
							<Field label="Name">
								<input
									className={styles.input}
									value={values.appName}
									onChange={(e) =>
										set({ appName: e.target.value })
									}
								/>
							</Field>
							<Field
								label="Description"
								hint="Shown on the home page."
							>
								<input
									className={styles.input}
									value={values.appDescription}
									onChange={(e) =>
										set({ appDescription: e.target.value })
									}
								/>
							</Field>
						</div>

						{/* The header as it will render, in both themes. Not a
						    swatch of the mark on its own: the question is
						    whether it reads next to the name at the size it
						    will be seen. The bar is dark in both themes, which
						    is why neither preview is on white. */}
						<div className={styles.brandPreviews}>
							{(["light", "dark"] as const).map((theme) => (
								<div
									key={theme}
									className={styles.brandPreviewWrap}
								>
									<span className={styles.brandPreviewLabel}>
										{theme} theme
									</span>
									<div
										className={`${styles.brandPreview} ${
											theme === "dark"
												? styles.brandPreviewDark
												: ""
										}`}
									>
										{values.appLogo ? (
											<span
												className={
													styles.brandPreviewMark
												}
												dangerouslySetInnerHTML={{
													__html: values.appLogo,
												}}
											/>
										) : (
											<svg
												className={
													styles.brandPreviewMark
												}
												viewBox="0 0 32 32"
												fill="none"
												stroke="var(--brand)"
												strokeWidth="2.5"
												strokeLinecap="round"
												aria-hidden="true"
											>
												<path d="M6 22V13" />
												<path d="M16 22V6" />
												<path d="M26 22v-6" />
												<path d="M4 27h24" />
											</svg>
										)}
										<span
											className={styles.brandPreviewRule}
											aria-hidden="true"
										/>
										<span
											className={styles.brandPreviewName}
										>
											{values.appName || "Untitled"}
										</span>
									</div>
								</div>
							))}
						</div>

						<div className={styles.fieldRow}>
							<Field
								label="Mark"
								hint={`SVG only, under ${limitKb}KB.${
									values.appLogo
										? ` Currently ${logoKb}KB.`
										: ""
								}`}
							>
								<input
									type="file"
									className={styles.input}
									accept=".svg,image/svg+xml"
									onChange={(e) =>
										onLogoFile(e.target.files?.[0])
									}
								/>
							</Field>

							<Field
								label="Colour"
								hint="A mark drawn in fixed brand colours should keep them."
							>
								<div className={styles.choiceRow}>
									{(
										[
											[true, "Follow the theme"],
											[false, "Keep its own colours"],
										] as [boolean, string][]
									).map(([value, label]) => (
										<button
											key={label}
											type="button"
											className={`${styles.choice} ${
												values.appLogoAdaptive === value
													? styles.choiceActive
													: ""
											}`}
											onClick={() =>
												set({ appLogoAdaptive: value })
											}
											aria-pressed={
												values.appLogoAdaptive === value
											}
										>
											{label}
										</button>
									))}
								</div>
							</Field>
						</div>

						{values.appLogo && (
							<button
								type="button"
								className={styles.linkButton}
								onClick={() => set({ appLogo: "" })}
							>
								Remove the mark
							</button>
						)}
					</>
				)}

				{group === "warehouse" && (
					<>
						<div className={styles.fieldRow}>
							<Field
								label="SQL warehouse id"
								hint="Blank uses whatever the deployment declares."
							>
								<input
									className={`${styles.input} ${styles.mono}`}
									placeholder="From the deployment"
									value={values.warehouseId}
									onChange={(e) =>
										set({ warehouseId: e.target.value })
									}
								/>
							</Field>
						</div>

						<details className={styles.paneDetails}>
							<summary>
								Why the database connection is not on this page
							</summary>
							<p>
								The platform keeps its own records in Postgres:
								reports, pages, visuals, saved views, access
								policy, and the values on this form. The two
								fields above are stored there too, which is why
								they can be edited here.
							</p>
							<p>
								The connection to that database cannot be,
								because it is what makes reading any of this
								possible. By the time this form has values in
								it, the platform is already connected. Storing
								the connection in the database it connects to
								would mean needing the answer before you could
								ask the question.
							</p>
							<p>
								It would also be a way to lock the platform out
								of itself. Save a wrong host and the next start
								cannot reach the database, and the only form
								that could correct it lives inside that
								database.
							</p>
							<p>
								So the connection is declared where the
								deployment is declared: app.yaml for a
								Databricks App, or .env when running locally.
								The warehouse and catalogue above are different
								because they are read after the platform has
								connected, so a wrong value stops reports
								returning data and leaves this page working.
							</p>
						</details>
					</>
				)}

				{group === "caching" && (
					<>
						{/* Grouped by what each number governs rather than laid out as
						    one grid of inputs. Eight controls with no grouping meant
						    reading every label to find the one you came for, and the
						    two switches sat in a numeric layout looking like fields
						    somebody had forgotten to fill in. */}
						<SettingGroup
							title="Query results"
							blurb="How long an answer is reused, and how much is kept to reuse."
						>
							<div className={styles.settingGrid}>
								<NumberSetting
									label="Reuse an answer for"
									hint="Longer is cheaper and staler."
									unit="seconds"
									value={values.resultTtlSeconds}
									onChange={(v) =>
										set({ resultTtlSeconds: v })
									}
								/>
								<NumberSetting
									label="Memory for results"
									hint="The real bound. Results differ in size by orders of magnitude."
									unit="MB"
									value={values.resultMaxBytes}
									onChange={(v) => set({ resultMaxBytes: v })}
								/>
								<NumberSetting
									label="Most results kept"
									hint="A ceiling on count, usually reached after the memory limit."
									unit="entries"
									value={values.resultMaxEntries}
									onChange={(v) =>
										set({ resultMaxEntries: v })
									}
								/>
							</div>

							<SwitchSetting
								label="Serve while refreshing"
								hint="An expired answer goes out immediately and refreshes behind the request, so a cold cache costs one slow page rather than many."
								checked={values.staleWhileRevalidate}
								onChange={(v) =>
									set({ staleWhileRevalidate: v })
								}
							/>
						</SettingGroup>

						<SettingGroup
							title="Access"
							blurb="How long a resolved membership is trusted. Both bound how long a withdrawn grant keeps working."
						>
							<div className={styles.settingGrid}>
								<NumberSetting
									label="Membership cache"
									hint="How long a resolved membership and the access it confers are reused. Bounds how long a grant withdrawn here keeps working."
									unit="seconds"
									value={values.groupCacheTtlSeconds}
									onChange={(v) =>
										set({ groupCacheTtlSeconds: v })
									}
								/>
								<NumberSetting
									label="Grace when unavailable"
									hint="How long a stored membership is still served while the lookup itself is failing."
									unit="seconds"
									value={values.policyGraceSeconds}
									onChange={(v) =>
										set({ policyGraceSeconds: v })
									}
								/>
							</div>
						</SettingGroup>

						<SettingGroup
							title="Background work"
							blurb="What the app does on a timer rather than on a request."
						>
							<div className={styles.settingGrid}>
								<NumberSetting
									label="Source refresh"
									hint="How often each replica rereads what is stored about every source. Registering or editing one applies immediately, so this is only for changes another replica made."
									unit="seconds"
									value={values.refreshIntervalSeconds}
									onChange={(v) =>
										set({ refreshIntervalSeconds: v })
									}
								/>
							</div>

							<SwitchSetting
								label="Record usage"
								hint="Turning this off empties the Usage tab and the export audit from that point on."
								checked={values.telemetryEnabled}
								onChange={(v) => set({ telemetryEnabled: v })}
							/>
						</SettingGroup>
					</>
				)}
			</div>

			{/* The bar appears only when there is something to save, so the page
			    is not permanently carrying a disabled button. */}
			{(dirty || failure || saved) && (
				<div className={styles.saveBar}>
					{failure ? (
						<span className={styles.saveError}>{failure}</span>
					) : (
						<span className={styles.saveNote}>
							{saved
								? "Saved. Other replicas pick it up within a minute."
								: "Unsaved changes"}
						</span>
					)}

					{dirty && (
						<>
							<button
								type="button"
								className={styles.linkButton}
								onClick={() => {
									setDraft(null);
									setFailure(null);
								}}
							>
								Discard
							</button>
							<button
								type="button"
								className={styles.saveButton}
								onClick={save}
								disabled={saving}
							>
								{saving ? "Saving" : "Save changes"}
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}

function SecuritySection({
	data,
	pane,
}: {
	data: SecurityResponse;
	pane: PaneId;
}) {
	const incomplete = data.exports.filter(
		(e) => e.action === "requested",
	).length;

	const unreadable = data.filterDiscovery.unreadableSources;
	const fromFilters = data.policyGroups.filter(
		(g) => g.origin === "row-filter",
	).length;

	// Whether a stored answer can reach somebody it was not computed for. It
	// can whenever a source is filtered and the groups its filter branches on
	// are not being probed.
	const partitioned =
		data.filteredSources === 0 ||
		(unreadable.length === 0 && fromFilters > 0);

	return (
		<>
			{pane === "partitioning" && (
				<>
					<p
						className={`${styles.paneNote} ${
							partitioned ? styles.paneNoteOk : styles.paneNoteBad
						}`}
					>
						{partitioned
							? `Answers are partitioned. ${fromFilters} group${
									fromFilters === 1 ? "" : "s"
								} found in row filters, across ${
									data.filteredSources
								} filtered source${data.filteredSources === 1 ? "" : "s"}.`
							: `Answers are not partitioned. ${data.filteredSources} source${
									data.filteredSources === 1 ? " is" : "s are"
								} row filtered, and ${
									unreadable.length > 0
										? `the filters on ${unreadable.length} of them could not be read`
										: "no group was found in any filter"
								}, so two readers entitled to different rows resolve to the same class and one may be served an answer computed for the other.`}
					</p>

					{data.filterDiscovery.failureReason && (
						<p className={styles.paneNote}>
							First failure: {data.filterDiscovery.failureReason}
						</p>
					)}

					{unreadable.length > 0 && (
						<details className={styles.details}>
							<summary>
								{unreadable.length} source
								{unreadable.length === 1 ? "" : "s"} the
								catalogue walk could not read
							</summary>
							<div className={styles.mono}>
								{unreadable.join(", ")}
							</div>
						</details>
					)}

					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>Group</th>
									<th>Directory</th>
									<th>Why it is probed</th>
								</tr>
							</thead>
							<tbody>
								{data.policyGroups.map((g) => (
									<tr key={`${g.scope}:${g.name}`}>
										<td>{g.name}</td>
										<td>
											<span className={styles.badge}>
												{g.scope}
											</span>
										</td>
										<td>
											{groupOrigins[g.origin] ?? g.origin}
										</td>
									</tr>
								))}
								{data.policyGroups.length === 0 && (
									<tr>
										<td colSpan={3}>
											Nothing is being probed
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</>
			)}

			{pane === "exports" && (
				<>
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>When</th>
									<th>User</th>
									<th>Action</th>
									<th>Detail</th>
								</tr>
							</thead>
							<tbody>
								{data.exports.map((e) => (
									<tr key={e.logId}>
										<td>
											<When iso={e.changedOn} />
										</td>
										<td>{e.changedBy}</td>
										<td>
											<span
												className={`${styles.badge} ${
													e.action === "failed"
														? styles.badgeFail
														: e.action ===
															  "completed"
															? styles.badgeOk
															: ""
												}`}
											>
												{e.action}
											</span>
										</td>
										<td
											className={styles.mono}
											title={e.detail ?? ""}
										>
											{e.notes ?? e.detail ?? "-"}
										</td>
									</tr>
								))}
								{data.exports.length === 0 && (
									<tr>
										<td colSpan={4}>No exports recorded</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>

					<p className={styles.paneNote}>
						Every export writes a request before the query runs and
						a completion after it, so a request with no completion
						is an export that failed or was interrupted.
						{incomplete > 0
							? ` ${incomplete} in this window ${
									incomplete === 1 ? "has" : "have"
								} no completion yet.`
							: ""}
					</p>
				</>
			)}
		</>
	);
}

interface AccessGrantRow {
	policy_id: string;
	subject_type: string;
	subject_id: string;
	resource_type: string;
	resource_id: string;
	permission: string;
	granted_by: string | null;
	granted_on: string;
	resource_name: string | null;
}

interface AccessResponse {
	grants: AccessGrantRow[];
	categories: { id: string; name: string }[];
	reports: { id: string; name: string }[];
}

function AccessGrants() {
	const { data, isLoading, mutate } =
		useSWR<AccessResponse>("/api/admin/access");

	const showSkeleton = useDeferredLoading(isLoading);

	const [subjectType, setSubjectType] = useState<"group" | "user">("group");
	const [subjectId, setSubjectId] = useState("");
	const [resourceType, setResourceType] = useState<"category" | "report">(
		"category",
	);
	const [resourceId, setResourceId] = useState("");
	const [permission, setPermission] = useState<"view" | "edit" | "admin">(
		"view",
	);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const choices =
		resourceType === "category"
			? (data?.categories ?? [])
			: (data?.reports ?? []);

	const pickResourceType = (next: "category" | "report") => {
		setResourceType(next);
		// The previous id belongs to the other kind of thing, and sending it
		// would be rejected as a resource that does not exist.
		setResourceId("");
	};

	const grant = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/admin/access", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					subjectType,
					subjectId,
					resourceType,
					resourceId,
					permission,
				}),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? "Could not grant access");
				return;
			}
			setSubjectId("");
			setResourceId("");
			await mutate();
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not grant access",
			);
		} finally {
			setBusy(false);
		}
	};

	const revoke = async (policyId: string) => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch(
				`/api/admin/access?policyId=${encodeURIComponent(policyId)}`,
				{ method: "DELETE" },
			);
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? "Could not revoke");
				return;
			}
			await mutate();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "Could not revoke",
			);
		} finally {
			setBusy(false);
		}
	};

	const grants = data?.grants ?? [];
	const ready = subjectId.trim() !== "" && resourceId !== "";

	return (
		<>
			<div className={styles.fieldRow}>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Subject</span>
					<Select
						value={subjectType}
						onChange={(v) => setSubjectType(v as "group" | "user")}
						options={[
							{ value: "group", label: "Group" },
							{ value: "user", label: "User" },
						]}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>
						{subjectType === "group" ? "Group name" : "Email"}
					</span>
					<input
						className={styles.input}
						value={subjectId}
						placeholder={
							subjectType === "group"
								? "Exact account group name"
								: "person@example.com"
						}
						onChange={(e) => setSubjectId(e.target.value)}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Applies to</span>
					<Select
						value={resourceType}
						onChange={(v) =>
							pickResourceType(v as "category" | "report")
						}
						options={[
							{ value: "category", label: "Category" },
							{ value: "report", label: "Report" },
						]}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>
						{resourceType === "category" ? "Category" : "Report"}
					</span>
					<Select
						value={resourceId}
						onChange={setResourceId}
						placeholder="Choose one"
						searchable={choices.length > 12}
						options={choices.map((c) => ({
							value: c.id,
							label: c.name,
						}))}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Permission</span>
					<Select
						value={permission}
						onChange={(v) =>
							setPermission(v as "view" | "edit" | "admin")
						}
						options={[
							{ value: "view", label: "View" },
							{ value: "edit", label: "Edit" },
							{ value: "admin", label: "Admin" },
						]}
					/>
				</label>
				<div className={styles.rowActions}>
					<button
						type="button"
						className={styles.saveButton}
						disabled={busy || !ready}
						onClick={grant}
					>
						{busy ? "Working" : "Grant"}
					</button>
				</div>
			</div>

			{failure && <div className={styles.saveError}>{failure}</div>}

			<div className={styles.tableWrap}>
				<table className={styles.table}>
					<thead>
						<tr>
							<th>Subject</th>
							<th>Type</th>
							<th>Resource</th>
							<th>Permission</th>
							<th>Granted by</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{grants.map((g) => (
							<tr key={g.policy_id}>
								<td>{g.subject_id}</td>
								<td>
									<span className={styles.badge}>
										{g.subject_type}
									</span>
								</td>
								<td>
									{g.resource_name ?? (
										<span className={styles.mono}>
											{g.resource_type}:{g.resource_id}
										</span>
									)}
								</td>
								<td>
									<span
										className={`${styles.badge} ${
											g.permission === "admin"
												? styles.badgeAdmin
												: ""
										}`}
									>
										{g.permission}
									</span>
								</td>
								<td>{g.granted_by ?? "-"}</td>
								<td>
									<button
										type="button"
										className={styles.linkButton}
										disabled={busy}
										onClick={() => revoke(g.policy_id)}
									>
										Revoke
									</button>
								</td>
							</tr>
						))}
						{!isLoading && grants.length === 0 && (
							<tr>
								<td colSpan={6}>
									No exceptions. Reachability comes from Unity
									Catalog alone.
								</td>
							</tr>
						)}
						{showSkeleton &&
							Array.from({ length: 4 }, (_, row) => (
								<tr key={`loading-${row}`}>
									{Array.from({ length: 6 }, (_, col) => (
										<td key={col}>
											<Skeleton height={12} />
										</td>
									))}
								</tr>
							))}
					</tbody>
				</table>
			</div>
		</>
	);
}

// Why a group is probed, in words rather than in the enum.
const groupOrigins: Record<string, string> = {
	"row-filter": "found in a row filter",
	"access-rule": "named in an access rule",
	editor: "editor group",
	admin: "admin group",
	configured: "added in Configuration",
};

// Re-reads every source from the catalogue.
//
// Fields it publishes, and for a metric view the tables underneath it. That
// second one is what the row filter walk needs and cannot fetch itself: opening
// a view definition takes SELECT on the view, which the application does not
// hold and a person running a sync does. So the walk stays blocked until
// somebody runs this once, and again whenever a view is re-pointed.
function SyncSources({
	inFlight,
	onFinished,
}: {
	// A run the server says is still going, which is how this survives the
	// person who started it navigating away: the button state came from a
	// local flag, so a refresh showed an idle button while a walk was still
	// running, and a second press started another.
	inFlight: boolean;
	onFinished: () => void;
}) {
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	// Polled while a walk is going, so the count moves and the page settles by
	// itself when it ends rather than waiting for somebody to reload.
	useEffect(() => {
		if (!inFlight) return;
		const timer = setInterval(() => onFinished(), 4000);
		return () => clearInterval(timer);
		// onFinished is read at call time; depending on it would restart the
		// interval on every render of the parent.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [inFlight]);

	const run = async () => {
		setRunning(true);
		setResult(null);
		setFailure(null);
		try {
			const response = await fetch("/api/admin/sync", { method: "POST" });
			const detail = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(detail?.error ?? `Sync failed (${response.status})`);
				return;
			}
			const totals = detail?.totals ?? {};
			const parts = Object.entries(totals)
				.filter(([, value]) => typeof value === "number" && value > 0)
				.map(
					([key, value]) =>
						`${value} ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`,
				);
			setResult(
				parts.length > 0
					? `Synced. ${parts.join(", ")}.`
					: "Synced. Nothing had changed.",
			);
		} catch (error) {
			setFailure(error instanceof Error ? error.message : "Sync failed");
		} finally {
			setRunning(false);
			// So the line under the button reports this run rather than the
			// one before it.
			onFinished();
		}
	};

	const busy = running || inFlight;

	return (
		<>
			<div className={styles.fieldRow}>
				<button
					type="button"
					className={styles.saveButton}
					disabled={busy}
					onClick={run}
				>
					{busy ? "Syncing" : "Sync from catalogue"}
				</button>
			</div>
			{result && <p className={styles.paneNote}>{result}</p>}
			{failure && <div className={styles.saveError}>{failure}</div>}
		</>
	);
}

// Counters arrive nested, one object per subsystem. Flattened to one label per
// number, because a tile reading {"entries":1,"degraded":0} is a value somebody
// has to parse rather than read.
function counterTiles(replica: Record<string, unknown>) {
	const tiles: { label: string; value: string; tone?: "good" | "bad" }[] = [];

	const spaced = (name: string) =>
		name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

	for (const [group, value] of Object.entries(replica)) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			for (const [name, inner] of Object.entries(
				value as Record<string, unknown>,
			)) {
				// A count of things that went wrong is worth colouring. A count
				// of things that are merely present is not.
				const bad =
					/degraded|dropped|failure|stale/i.test(name) &&
					Number(inner) > 0;
				tiles.push({
					label: `${spaced(group)} ${spaced(name)}`,
					value: String(inner),
					tone: bad ? "bad" : undefined,
				});
			}
		}
	}
	return tiles;
}

function PlatformSection({
	data,
	pane,
	onRefresh,
}: {
	data: PlatformResponse;
	pane: PaneId;
	onRefresh: () => void;
}) {
	const [editingSource, setEditingSource] = useState<string | null>(null);

	const loaded = (value: unknown) =>
		typeof value === "number" && value > 0
			? ago(new Date(value).toISOString())
			: "not yet";

	return (
		<>
			{pane === "health" && (
				<>
					{/* Every counter below describes whichever instance
					    answered this request, so two refreshes reporting two
					    different ids is why the numbers moved. Without this a
					    one-instance problem and an everything problem look
					    identical. */}
					<div className={styles.notice}>
						<div>
							<div className={styles.noticeTitle}>
								Instance{" "}
								{String(data.replica.instanceId ?? "?")}
							</div>
							<p className={styles.noticeBody}>
								These counters are what this one process is
								holding, not a total across the deployment.
								Refreshing may land on a different instance and
								report different numbers.
							</p>
						</div>
					</div>

					<div className={styles.tiles}>
						{counterTiles(data.replica).map((tile) => (
							<Tile
								key={tile.label}
								label={tile.label}
								value={tile.value}
								tone={tile.tone}
							/>
						))}
					</div>

					<div className={styles.definition}>
						<span className={styles.definitionKey}>
							Settings read
						</span>
						<span className={styles.definitionValue}>
							{loaded(data.replica.settingsLoadedAt)}
						</span>
						<span className={styles.definitionKey}>
							Registry read
						</span>
						<span className={styles.definitionValue}>
							{loaded(data.replica.registryLoadedAt)}
						</span>
					</div>
				</>
			)}

			{editingSource && (
				<EditSourceDialog
					sourceKey={editingSource}
					onClose={() => setEditingSource(null)}
					// Refetches the source list rather than reloading the
					// document. A reload threw away the open pane along with
					// everything else on it, which put somebody who had just
					// edited a source back on the first pane of the rail.
					onSaved={() => {
						setEditingSource(null);
						onRefresh();
					}}
				/>
			)}

			{pane === "sources" && (
				<>
					<div className={styles.actionBar}>
						<AddSourceButton
							className={styles.actionPrimary}
							onAdded={onRefresh}
						/>
						<SyncSources
							inFlight={Boolean(
								data.lastSync &&
								!data.lastSync.finishedOn &&
								!data.lastSync.abandoned,
							)}
							onFinished={onRefresh}
						/>
					</div>

					<SyncFreshness run={data.lastSync ?? null} />
					<div className={styles.tableWrap}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>Source</th>
									<th>Kind</th>
									<th className={styles.numeric}>Fields</th>
									<th>Filtered</th>
									<th>Reuse for</th>
									<th>Object</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{data.sources.map((s) => (
									<tr key={s.sourceKey}>
										<td>{s.title}</td>
										<td>
											<span className={styles.badge}>
												{s.kind === "metric_view"
													? "metric view"
													: s.kind}
											</span>
										</td>
										<td className={styles.numeric}>
											{s.dimensions} + {s.measures}
										</td>
										<td>{s.hasRowFilter ? "yes" : "no"}</td>
										<td>
											{s.cacheTtlSeconds > 0
												? `${s.cacheTtlSeconds}s`
												: "platform default"}
										</td>
										<td className={styles.mono}>
											{s.object}
										</td>
										<td>
											<button
												type="button"
												className={styles.linkButton}
												onClick={() =>
													setEditingSource(
														s.sourceKey,
													)
												}
											>
												Edit
											</button>
										</td>
									</tr>
								))}
								{data.sources.length === 0 && (
									<tr>
										<td colSpan={5}>
											No sources registered
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</>
			)}

			{pane === "runtime" && (
				<>
					<header className={styles.sectionHead}>
						<h2 className={styles.sectionTitle}>Connections</h2>
						<p className={styles.paneBlurb}>
							Where this replica reaches the platform store. No
							credential is ever returned here.
						</p>
					</header>

					<div className={styles.definition}>
						{Object.entries(data.runtime).map(([key, value]) => (
							<Row key={key} label={key} value={value} />
						))}
					</div>

					{/* Read-only, and not the same question the settings panes
					    answer. Those show what is stored; this shows what this
					    one replica has loaded, which lags a change made
					    elsewhere until it rereads. It also carries the settings
					    that have no editor. */}
					<header className={styles.sectionHead}>
						<h2 className={styles.sectionTitle}>
							Effective settings
						</h2>
						<p className={styles.paneBlurb}>
							What this replica is running on. A change saved
							elsewhere appears here once it rereads, which the
							Health pane dates.
						</p>
					</header>

					<div className={styles.definition}>
						{Object.entries(data.settings).map(([key, value]) => (
							<Row
								key={key}
								label={
									key === "trackedGroups"
										? "trackedGroups (extra)"
										: key
								}
								value={
									key === "trackedGroups" &&
									Array.isArray(value) &&
									value.length === 0
										? "none set, added to those found"
										: key === "appLogo"
											? typeof value === "string" &&
												value.length > 0
												? `${Math.round(value.length / 1024)}KB of SVG`
												: "none set"
											: value
								}
							/>
						))}
					</div>
				</>
			)}
		</>
	);
}

function Row({ label, value }: { label: string; value: unknown }) {
	return (
		<>
			<span className={styles.definitionKey}>{label}</span>
			<span className={styles.definitionValue}>
				{typeof value === "object" && value !== null
					? JSON.stringify(value)
					: String(value)}
			</span>
		</>
	);
}

function Tile({
	label,
	value,
	tone,
	hint,
}: {
	label: string;
	value: string;
	tone?: "good" | "warn" | "bad";
	// What the colour is measured against. A tile that turns red without
	// saying where the line is reports a verdict nobody can check or act on.
	hint?: string;
}) {
	const toneClass =
		tone === "good"
			? styles.tileGood
			: tone === "warn"
				? styles.tileWarn
				: tone === "bad"
					? styles.tileBad
					: "";
	return (
		<div className={styles.tile}>
			<div className={styles.tileLabel}>{label}</div>
			<div className={`${styles.tileValue} ${toneClass}`}>{value}</div>
			{hint && <div className={styles.tileHint}>{hint}</div>}
		</div>
	);
}
