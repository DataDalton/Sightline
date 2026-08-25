"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { formatCompact } from "../../lib/format";
import { usePageTitle } from "../hooks/usePageTitle";
import styles from "./Admin.module.css";

// Administration: adoption, cost, failures, and who can reach what.
//
// The sections answer three different questions and are kept apart because the
// audiences differ. Usage is for whoever owns the reporting estate; Security is
// for whoever answers an access review; Platform is for whoever gets paged.

type Section = "usage" | "security" | "platform" | "configuration";

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
	policyGroups: { name: string; scope: string; origin: string }[];
	filterDiscovery: { at: number | null; unreadableSources: string[] };
	sources: {
		sourceKey: string;
		title: string;
		kind: string;
		object: string;
		hasRowFilter: boolean;
		dimensions: number;
		measures: number;
	}[];
}

function timeAgo(iso: string | null): string {
	if (!iso) return "-";
	const ms = Date.now() - new Date(iso).getTime();
	const minutes = Math.floor(ms / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export default function AdminView() {
	usePageTitle("Administration");

	const [section, setSection] = useState<Section>("usage");
	const [days, setDays] = useState(7);

	// Configuration reads its own endpoint, so the shared query is skipped for
	// it rather than fetching a section the server does not serve.
	const key =
		section === "configuration"
			? null
			: section === "usage"
				? `/api/admin?days=${days}`
				: `/api/admin?section=${section}`;
	const { data, error, isLoading } = useSWR(key);

	if (error) {
		return (
			<div className={styles.page}>
				<div className={styles.state}>
					This section is not available to you.
				</div>
			</div>
		);
	}

	return (
		<div className={styles.page}>
			<h1 className={styles.title}>Administration</h1>
			<p className={styles.subtitle}>
				Adoption, access and platform health.
			</p>

			<div className={styles.tabs} role="tablist">
				{(
					[
						["usage", "Usage & observability"],
						["security", "Security & access"],
						["platform", "Platform"],
						["configuration", "Configuration"],
					] as [Section, string][]
				).map(([id, label]) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={section === id}
						className={`${styles.tab} ${
							section === id ? styles.tabActive : ""
						}`}
						onClick={() => setSection(id)}
					>
						{label}
					</button>
				))}
			</div>

			{/* Configuration reads its own endpoint, so it does not wait on the
			    usage query that the other sections share. */}
			{section === "configuration" && <ConfigurationSection />}

			{isLoading && section !== "configuration" && (
				<div className={styles.state}>Loading</div>
			)}

			{!isLoading && section === "usage" && data && (
				<UsageSection
					data={data as UsageResponse}
					days={days}
					onDays={setDays}
				/>
			)}
			{!isLoading && section === "security" && data && (
				<SecuritySection data={data as SecurityResponse} />
			)}
			{!isLoading && section === "platform" && data && (
				<PlatformSection data={data as PlatformResponse} />
			)}
		</div>
	);
}

function UsageSection({
	data,
	days,
	onDays,
}: {
	data: UsageResponse;
	days: number;
	onDays: (d: number) => void;
}) {
	const { summary, daily } = data;
	// Which row an admin has opened. A drawer rather than a separate page: the
	// question is always "why does that row look like that", so the row it
	// came from should stay on screen behind it.
	const [drill, setDrill] = useState<Drill | null>(null);
	const peak = Math.max(1, ...daily.map((d) => d.events));

	return (
		<>
			<div className={styles.controls}>
				{[1, 7, 30, 90].map((d) => (
					<button
						key={d}
						type="button"
						className={`${styles.rangeButton} ${
							days === d ? styles.rangeActive : ""
						}`}
						onClick={() => onDays(d)}
					>
						{d === 1 ? "24 hours" : `${d} days`}
					</button>
				))}
			</div>

			<div className={styles.tiles}>
				<Tile
					label="Active users"
					value={summary.activeUsers.toLocaleString()}
				/>
				<Tile
					label="Page views"
					value={formatCompact(summary.pageViews, "integer")}
				/>
				<Tile
					label="Queries"
					value={formatCompact(summary.queries, "integer")}
				/>
				<Tile
					label="Exports"
					value={summary.exports.toLocaleString()}
				/>
				<Tile
					label="Errors"
					value={summary.errors.toLocaleString()}
					tone={summary.errors > 0 ? "bad" : "good"}
				/>
				<Tile
					label="Cache hit rate"
					value={`${summary.cacheHitRate.toFixed(1)}%`}
					// Below half means most interactions still reach the
					// warehouse, which is the cost driver worth watching.
					tone={
						summary.cacheHitRate >= 70
							? "good"
							: summary.cacheHitRate >= 40
								? "warn"
								: "bad"
					}
				/>
				<Tile
					label="Median query"
					value={`${summary.medianQueryMs}ms`}
				/>
				<Tile
					label="p95 query"
					value={`${summary.p95QueryMs}ms`}
					tone={
						summary.p95QueryMs > 10000
							? "bad"
							: summary.p95QueryMs > 5000
								? "warn"
								: "good"
					}
				/>
			</div>

			{daily.length > 0 && (
				<div className={styles.sparkRow} title="Events per day">
					{daily.map((d) => (
						<div
							key={d.day}
							className={styles.sparkBar}
							style={{
								height: `${Math.max(3, (d.events / peak) * 100)}%`,
							}}
							title={`${d.day}: ${d.events} events, ${d.users} users`}
						/>
					))}
				</div>
			)}

			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>Most used reports</h2>
				<p className={styles.sectionNote}>
					A report with few distinct users but many views is usually
					one person&apos;s workflow, not a shared asset.
				</p>
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
									<td>{timeAgo(r.lastViewed)}</td>
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
			</div>

			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>Slowest sources</h2>
				<p className={styles.sectionNote}>
					Average warehouse time per source, with the share served
					from cache. A slow source with a low hit rate is where cost
					accumulates.
				</p>
				<div className={styles.tableWrap}>
					<table className={styles.table}>
						<thead>
							<tr>
								<th>Source</th>
								<th className={styles.numeric}>Queries</th>
								<th className={styles.numeric}>Avg</th>
								<th className={styles.numeric}>Max</th>
								<th className={styles.numeric}>Cache hit</th>
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
			</div>

			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>Most active users</h2>
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
									<td>{timeAgo(u.lastSeen)}</td>
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
			</div>

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

				{isLoading && <div className={styles.sectionNote}>Loading</div>}

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
										<td>{timeAgo(v.firstViewed)}</td>
										<td>{timeAgo(v.lastViewed)}</td>
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
											{timeAgo(event.occurredOn)}
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
	groupCacheTtlSeconds: number;
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
const configGroups = [
	{
		id: "branding",
		label: "Branding",
		blurb: "The name and mark in the header of every page.",
	},
	{
		id: "data",
		label: "Data source",
		blurb: "Which warehouse runs the queries and which catalogue they read.",
	},
	{
		id: "performance",
		label: "Performance",
		blurb: "How long answers and memberships are reused before being asked again.",
	},
	{
		id: "access",
		label: "Access",
		blurb: "Who may edit reports, and who may administer the platform.",
	},
] as const;

type ConfigGroup = (typeof configGroups)[number]["id"];

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

function ConfigurationSection() {
	const { data, isLoading, mutate } = useSWR<{
		settings: ConfigValues;
		maxLogoBytes: number;
	}>("/api/admin/settings");

	const [group, setGroup] = useState<ConfigGroup>("branding");
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
		return <div className={styles.sectionNote}>Loading</div>;
	}

	const logoKb = Math.round(new Blob([values.appLogo ?? ""]).size / 1024);
	const limitKb = Math.round((data?.maxLogoBytes ?? 0) / 1024);
	const active = configGroups.find((g) => g.id === group);

	const groupList = (key: "editorGroups" | "adminGroups") => (
		<input
			className={styles.input}
			placeholder="None set"
			value={values[key].join(", ")}
			onChange={(e) =>
				set({
					[key]: e.target.value
						.split(",")
						.map((g) => g.trim())
						.filter(Boolean),
				} as Partial<ConfigValues>)
			}
		/>
	);

	return (
		<div className={styles.config}>
			<nav className={styles.configNav} aria-label="Settings">
				{configGroups.map((g) => (
					<button
						key={g.id}
						type="button"
						className={`${styles.configNavItem} ${
							group === g.id ? styles.configNavActive : ""
						}`}
						onClick={() => setGroup(g.id)}
						aria-current={group === g.id}
					>
						{g.label}
					</button>
				))}
			</nav>

			<div className={styles.configPane}>
				<header className={styles.paneHeader}>
					<h2 className={styles.paneTitle}>{active?.label}</h2>
					<p className={styles.paneBlurb}>{active?.blurb}</p>
				</header>

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

						<p className={styles.paneNote}>
							Uploads are rebuilt from an allow-list before being
							stored, so anything scriptable in the file is
							dropped. The mark is kept in the settings table
							rather than on disk, because a Databricks App has no
							disk that survives a restart.
						</p>
					</>
				)}

				{group === "data" && (
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

						<p className={styles.paneNote}>
							Applies to the next connection each reader opens, so
							moving to a different warehouse needs no redeploy.
							Catalogue and schema are not here: they belong to
							each source rather than to the platform, and are set
							per source in the semantic layer.
						</p>

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

				{group === "performance" && (
					<>
						<div className={styles.fieldRow}>
							<Field
								label="Result cache"
								hint="Longer is cheaper and staler."
							>
								<div className={styles.withUnit}>
									<input
										type="number"
										className={styles.input}
										value={values.resultTtlSeconds}
										onChange={(e) =>
											set({
												resultTtlSeconds: Number(
													e.target.value,
												),
											})
										}
									/>
									<span className={styles.unit}>seconds</span>
								</div>
							</Field>

							<Field
								label="Membership cache"
								hint="Also how long a revoked grant keeps working."
							>
								<div className={styles.withUnit}>
									<input
										type="number"
										className={styles.input}
										value={values.groupCacheTtlSeconds}
										onChange={(e) =>
											set({
												groupCacheTtlSeconds: Number(
													e.target.value,
												),
											})
										}
									/>
									<span className={styles.unit}>seconds</span>
								</div>
							</Field>
						</div>

						<p className={styles.paneNote}>
							An answer is only ever reused for someone whose
							group membership is identical, so a longer cache
							trades freshness for cost, never for correctness.
						</p>
					</>
				)}

				{group === "access" && (
					<>
						<div className={styles.fieldRow}>
							<Field
								label="Reachability"
								hint="Where the list of reports a person can open comes from."
							>
								<select
									className={styles.input}
									value={values.accessModel ?? "catalog"}
									onChange={(e) =>
										set({
											accessModel: e.target.value as
												| "catalog"
												| "grants",
										})
									}
								>
									<option value="catalog">
										Follows Unity Catalog
									</option>
									<option value="grants">
										Access grants only
									</option>
								</select>
							</Field>
						</div>

						<p className={styles.paneNote}>
							Following the catalogue means a reader sees the
							reports built on data they already hold SELECT on,
							so the grant made once in Unity Catalog is the whole
							statement and there is no second list to keep in
							step. Access grants still apply on top and can raise
							somebody above view. Choosing grants only is for a
							deployment where reaching a report is a narrower
							decision than reading its data.
						</p>

						<div className={styles.fieldRow}>
							<Field
								label="Editor groups"
								hint="May edit any report. Changes publish to everyone."
							>
								{groupList("editorGroups")}
							</Field>

							<Field
								label="Admin groups"
								hint="Hold every permission, including this page."
							>
								{groupList("adminGroups")}
							</Field>
						</div>

						<p className={styles.paneNote}>
							Comma separated, and matched against the account
							exactly as written. Case matters: a group spelled
							differently here never matches and the failure is
							silent, so nobody is denied with an error, they
							simply have no permissions.
						</p>
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

function SecuritySection({ data }: { data: SecurityResponse }) {
	return (
		<>
			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>Privileged groups</h2>
				<p className={styles.sectionNote}>
					Members of these groups hold their permission on every
					report, without an explicit grant. Editors publish changes
					to everyone; administrators additionally manage access and
					platform settings.
				</p>
				<div className={styles.definition}>
					<span className={styles.definitionKey}>Editors</span>
					<span className={styles.definitionValue}>
						{data.editorGroups.join(", ") || "none"}
					</span>
					<span className={styles.definitionKey}>Administrators</span>
					<span className={styles.definitionValue}>
						{data.adminGroups.join(", ") || "none"}
					</span>
				</div>
			</div>

			<AccessGrants />

			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>Export audit</h2>
				<p className={styles.sectionNote}>
					Every export writes a request record before the query runs
					and a completion record after it. A request with no matching
					completion means the export failed or was interrupted, which
					is itself worth seeing.
				</p>
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
									<td>{timeAgo(e.changedOn)}</td>
									<td>{e.changedBy}</td>
									<td>
										<span
											className={`${styles.badge} ${
												e.action === "failed"
													? styles.badgeFail
													: e.action === "completed"
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
			</div>
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
		<div className={styles.section}>
			<h2 className={styles.sectionTitle}>Access grants</h2>
			<p className={styles.sectionNote}>
				Exceptions. While reachability follows Unity Catalog, a reader
				already sees the reports built on data they hold SELECT on, and
				nothing has to be listed here for that to work. These entries
				add reach somebody would not otherwise have, or raise a
				permission above view.
			</p>
			<p className={styles.sectionNote}>
				Reachability only. Which rows a person sees inside a report is
				decided by Unity Catalog when the query runs under their own
				identity, and is not configurable here. Granting to a group also
				puts that group on the membership probe list, so no separate
				step is needed, and group names are matched against the account
				directory exactly as spelled, including case.
			</p>

			<div className={styles.fieldRow}>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Subject</span>
					<select
						className={styles.input}
						value={subjectType}
						onChange={(e) =>
							setSubjectType(e.target.value as "group" | "user")
						}
					>
						<option value="group">Group</option>
						<option value="user">User</option>
					</select>
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
					<select
						className={styles.input}
						value={resourceType}
						onChange={(e) =>
							pickResourceType(
								e.target.value as "category" | "report",
							)
						}
					>
						<option value="category">Category</option>
						<option value="report">Report</option>
					</select>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>
						{resourceType === "category" ? "Category" : "Report"}
					</span>
					<select
						className={styles.input}
						value={resourceId}
						onChange={(e) => setResourceId(e.target.value)}
					>
						<option value="">Choose one</option>
						{choices.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Permission</span>
					<select
						className={styles.input}
						value={permission}
						onChange={(e) =>
							setPermission(
								e.target.value as "view" | "edit" | "admin",
							)
						}
					>
						<option value="view">View</option>
						<option value="edit">Edit</option>
						<option value="admin">Admin</option>
					</select>
				</label>
				<button
					type="button"
					className={styles.saveButton}
					disabled={busy || !ready}
					onClick={grant}
				>
					{busy ? "Working" : "Grant"}
				</button>
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
						{isLoading && (
							<tr>
								<td colSpan={6}>Loading</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</div>
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

function PlatformSection({ data }: { data: PlatformResponse }) {
	return (
		<>
			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>Registered sources</h2>
				<p className={styles.sectionNote}>
					A metric view owns its own aggregation, so measures are read
					with MEASURE() and the app never restates them. Sources
					marked as filtered have their results cached per policy
					class rather than shared.
				</p>
				<div className={styles.tableWrap}>
					<table className={styles.table}>
						<thead>
							<tr>
								<th>Source</th>
								<th>Kind</th>
								<th>Object</th>
								<th className={styles.numeric}>Dimensions</th>
								<th className={styles.numeric}>Measures</th>
								<th>Row filtered</th>
							</tr>
						</thead>
						<tbody>
							{data.sources.map((s) => (
								<tr key={s.sourceKey}>
									<td>{s.title}</td>
									<td>
										<span className={styles.badge}>
											{s.kind}
										</span>
									</td>
									<td className={styles.mono}>{s.object}</td>
									<td className={styles.numeric}>
										{s.dimensions}
									</td>
									<td className={styles.numeric}>
										{s.measures}
									</td>
									<td>{s.hasRowFilter ? "yes" : "no"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>Policy groups</h2>
				<p className={styles.sectionNote}>
					Membership in these decides which cached answers a reader
					may be served. Two people share a cached result only when
					every one of these agrees for both, which is what stops a
					filtered source handing one reader another reader&apos;s
					rows.
				</p>
				<p className={styles.sectionNote}>
					Most are found rather than configured: the platform reads
					the row filters on each source and probes whatever groups
					they branch on, so this list follows a filter someone edits
					without anybody maintaining it. The scope is the directory
					each is asked about, matching the function the filter used.
				</p>

				{data.filterDiscovery.unreadableSources.length > 0 && (
					<p className={styles.sectionNote}>
						Could not read the filters on{" "}
						{data.filterDiscovery.unreadableSources.join(", ")}.
						Groups named only there are not being probed, so add
						them below in Configuration until the catalogue is
						readable.
					</p>
				)}

				<div className={styles.tableWrap}>
					<table className={styles.table}>
						<thead>
							<tr>
								<th>Group</th>
								<th>Directory</th>
								<th>Source</th>
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
										No groups are being probed. Every reader
										resolves to one policy class, so a
										filtered source would share results
										between people who see different rows.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>

			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>This replica</h2>
				<p className={styles.sectionNote}>
					Caches and pools are per replica, so these counters describe
					the instance that served this request rather than the whole
					deployment.
				</p>
				<div className={styles.definition}>
					{Object.entries(data.replica).map(([key, value]) => (
						<Row key={key} label={key} value={value} />
					))}
				</div>
			</div>

			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>Runtime</h2>
				<div className={styles.definition}>
					{Object.entries(data.runtime).map(([key, value]) => (
						<Row key={key} label={key} value={value} />
					))}
				</div>
			</div>

			<div className={styles.section}>
				<h2 className={styles.sectionTitle}>Settings</h2>
				<p className={styles.sectionNote}>
					Stored in the platform_settings table and polled every
					minute, so a change reaches every replica without a
					redeploy.
				</p>
				<div className={styles.definition}>
					{Object.entries(data.settings).map(([key, value]) => (
						<Row
							key={key}
							label={
								key === "trackedGroups"
									? "trackedGroups (extra, added to those found)"
									: key
							}
							value={
								key === "trackedGroups" &&
								Array.isArray(value) &&
								value.length === 0
									? "none set, see Policy groups above"
									: key === "appLogo"
										? typeof value === "string" &&
											value.length > 0
											? `${Math.round(value.length / 1024)}KB of SVG, see Configuration`
											: "none set"
										: value
							}
						/>
					))}
				</div>
			</div>
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
}: {
	label: string;
	value: string;
	tone?: "good" | "warn" | "bad";
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
		</div>
	);
}
