"use client";

import { useTabParam } from "../hooks/useTabParam";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import type { WorkConfig } from "../../lib/work/model";
import type { Release } from "../../lib/work/releases";
import type { WorkSummary } from "../../lib/work/store";
import { Select } from "../components/shared/Select";
import { EmptyState, emptyIcons } from "../components/shared/EmptyState";
import { LoadError } from "../components/shared/ErrorState";
import { SkeletonTable } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { usePageTitle } from "../hooks/usePageTitle";
import { RequestForm, type RequestDraft } from "./RequestForm";
import { WorkCalendar } from "./WorkCalendar";
import { WorkMetrics } from "./WorkMetrics";
import { WorkViews, type WorkSavedView } from "./WorkViews";
import {
	ReleaseDialog,
	ReleaseSelect,
	ShipDialog,
	releaseDate,
	useReleases,
} from "./ReleaseControls";
import {
	columnLabel,
	daysSince,
	effortLabel,
	initials,
	labelOf,
	personName,
	postJson,
} from "./labels";
import { BlockedIcon } from "./BlockedIcon";
import { FilterMenu } from "./FilterMenu";
import styles from "./Work.module.css";

// The work queue: items for the data engineers, on a board whose columns are
// the statuses, and as a table, a list, a calendar of targets and the queue's
// numbers. Releases are worked on the board itself, grouped by release.
// Anybody can see what they asked for and what is about the data they read.
// The engineers see everything, make items directly and move them.

const tabIds = ["board", "table", "list", "calendar", "metrics"] as const;
type Tab = (typeof tabIds)[number];

interface Answer {
	items: WorkSummary[];
	config: WorkConfig;
	may: { request: boolean; engineer: boolean; devSecOps: boolean };
	me: string;
}

interface Filters {
	q: string;
	assignee: string;
	requester: string;
	workType: string;
	priority: string;
	domain: string;
	layer: string;
	tag: string;
	blocked: string;
	archive: string;
	release: string;
}

const noFilters: Filters = {
	q: "",
	assignee: "",
	requester: "",
	workType: "",
	priority: "",
	domain: "",
	layer: "",
	tag: "",
	blocked: "",
	archive: "",
	release: "",
};

// Where this browser keeps the board's last filters, sort and grouping.
const boardMemoryKey = "work.board";

// The orders a list can be read in. The first is the default.
const sortOrders = [
	{ value: "updated", label: "Recently updated" },
	{ value: "newest", label: "Newest" },
	{ value: "oldest", label: "Oldest" },
	{ value: "priority", label: "Priority" },
	{ value: "target", label: "Target date" },
	{ value: "asked", label: "Most asked for" },
] as const;
type SortOrder = (typeof sortOrders)[number]["value"];

// Ties keep the most recently updated first, so every order is stable.
function sortItems(
	items: WorkSummary[],
	order: SortOrder,
	config: WorkConfig,
): WorkSummary[] {
	const updated = (a: WorkSummary, b: WorkSummary) =>
		b.modifiedOn.localeCompare(a.modifiedOn);
	const rank = (item: WorkSummary) => {
		const at = config.priorities.findIndex((p) => p.id === item.priority);
		return at === -1 ? config.priorities.length : at;
	};
	const compare: Record<
		SortOrder,
		(a: WorkSummary, b: WorkSummary) => number
	> = {
		updated: () => 0,
		newest: (a, b) => b.createdOn.localeCompare(a.createdOn),
		oldest: (a, b) => a.createdOn.localeCompare(b.createdOn),
		priority: (a, b) => rank(a) - rank(b),
		// Requests with no target go last.
		target: (a, b) =>
			(a.target ?? "9999").localeCompare(b.target ?? "9999"),
		asked: (a, b) => b.requesters - a.requesters,
	};
	return [...items].sort((a, b) => compare[order](a, b) || updated(a, b));
}

// What a saved view keeps.
interface ViewState {
	filters?: Partial<Filters> & { closed?: string };
	tab?: Tab;
	lanes?: string;
	sort?: SortOrder;
}

const priorityOrder = ["urgent", "high", "medium", "low"];

// Where a prefilled request came from, read from the address. Anything that does
// not parse is treated as the form.
function originOf(text: string | null): Record<string, unknown> {
	if (!text) return { kind: "form" };
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: { kind: "form" };
	} catch {
		return { kind: "form" };
	}
}

export default function WorkView() {
	usePageTitle("Requests");
	const router = useRouter();
	const asked = useSearchParams();
	const [tab, setTab] = useTabParam<Tab>("tab", tabIds, "board");
	const [filters, setFilters] = useState<Filters>(noFilters);
	const [lanes, setLanes] = useState("");
	const [sort, setSort] = useState<SortOrder>("updated");
	const [requesting, setRequesting] = useState<RequestDraft | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());

	// The filters, sort and grouping last chosen, kept in this browser so a
	// reload comes back to the same board. Read after mount, so the server
	// render and the first client render agree, and written only once read,
	// so the defaults never overwrite what was kept.
	const [remembered, setRemembered] = useState(false);
	useEffect(() => {
		try {
			const kept = JSON.parse(
				window.localStorage.getItem(boardMemoryKey) ?? "null",
			) as {
				filters?: Partial<Filters>;
				lanes?: string;
				sort?: string;
			} | null;
			if (kept) {
				setFilters({ ...noFilters, ...(kept.filters ?? {}) });
				setLanes(typeof kept.lanes === "string" ? kept.lanes : "");
				if (sortOrders.some((order) => order.value === kept.sort))
					setSort(kept.sort as SortOrder);
			}
		} catch {
			// Unreadable or blocked storage starts from the defaults.
		}
		setRemembered(true);
	}, []);
	useEffect(() => {
		if (!remembered) return;
		try {
			window.localStorage.setItem(
				boardMemoryKey,
				JSON.stringify({ filters, lanes, sort }),
			);
		} catch {
			// Without storage the choices last until the page is left.
		}
	}, [remembered, filters, lanes, sort]);

	// Opened with ?new=1 and a draft, from the assistant or a conversation.
	useEffect(() => {
		if (asked.get("new") !== "1") return;
		setRequesting({
			title: asked.get("title") ?? "",
			description: asked.get("description") ?? "",
			workType: asked.get("workType") ?? undefined,
			sources: asked.get("source") ? [asked.get("source") as string] : [],
			requesters: (asked.get("requesters") ?? "")
				.split(",")
				.filter(Boolean),
			origin: originOf(asked.get("origin")),
			asRequest: true,
		});
	}, [asked]);

	const query = useMemo(() => {
		const params = new URLSearchParams();
		for (const [name, value] of Object.entries(filters)) {
			if (value) params.set(name, value);
		}
		return params.toString();
	}, [filters]);
	const { data, error, mutate } = useSWR<Answer>(`/api/work?${query}`, {
		refreshInterval: 15_000,
	});
	const [activeView, setActiveView] = useState<string | null>(null);
	const { releases, refresh: refreshReleases } = useReleases();
	const [editingRelease, setEditingRelease] = useState<
		Release | "new" | null
	>(null);
	const [shipping, setShipping] = useState<Release | null>(null);
	// Only a wait long enough to notice draws a placeholder.
	const showSkeleton = useDeferredLoading(!data && !error);

	if (error && !data) {
		return (
			<div className={styles.page}>
				<LoadError
					error={error}
					subject="requests"
					onRetry={() => void mutate()}
				/>
			</div>
		);
	}
	if (!data) {
		return (
			<div className={styles.page}>
				{showSkeleton && <SkeletonTable rows={8} columns={5} />}
			</div>
		);
	}
	const { config, may } = data;
	const items = sortItems(data.items, sort, config);
	const labelIn = (list: { id: string; label: string }[], id: string) =>
		list.find((entry) => entry.id === id)?.label ?? id;
	const menuFilters = [
		{
			key: "workType",
			name: "Type",
			value:
				filters.workType && labelIn(config.workTypes, filters.workType),
		},
		{
			key: "priority",
			name: "Priority",
			value:
				filters.priority &&
				labelIn(config.priorities, filters.priority),
		},
		{
			key: "domain",
			name: "Domain",
			value: filters.domain && labelIn(config.domains, filters.domain),
		},
		{
			key: "layer",
			name: "Layer",
			value: filters.layer && labelIn(config.layers, filters.layer),
		},
		{
			key: "release",
			name: "Release",
			value:
				filters.release &&
				(releases.find((r) => r.id === filters.release)?.name ??
					"A release"),
		},
	].filter((filter) => filter.value) as {
		key: keyof Filters;
		name: string;
		value: string;
	}[];
	const set = (patch: Partial<Filters>) =>
		setFilters((held) => ({ ...held, ...patch }));
	const open = (key: string) => router.push(`/work/${key}`);

	// A drop on the board, which can also change the release when the board is
	// grouped by release.
	const move = async (
		key: string,
		to: string,
		releaseId: string | null = null,
	) => {
		setFailure(null);
		try {
			const item = items.find((i) => i.key === key);
			if (
				releaseId !== null &&
				item &&
				(item.releaseId ?? "") !== releaseId
			) {
				await postJson(`/api/work/${key}`, {
					action: "update",
					releaseId: releaseId || null,
				});
				void refreshReleases();
			}
			if (item?.status !== to) {
				await postJson(`/api/work/${key}`, { action: "move", to });
			}
			await mutate();
		} catch (error) {
			setFailure(
				`${key}: ${error instanceof Error ? error.message : "it could not be moved"}`,
			);
		}
	};
	const update = async (key: string, patch: Record<string, unknown>) => {
		setFailure(null);
		try {
			await postJson(`/api/work/${key}`, { action: "update", ...patch });
			await mutate();
		} catch (error) {
			setFailure(
				`${key}: ${error instanceof Error ? error.message : "it could not be changed"}`,
			);
		}
	};
	const bulk = async (change: (key: string) => Promise<void>) => {
		for (const key of selected) await change(key);
		setSelected(new Set());
	};

	const applyView = (view: WorkSavedView<ViewState> | null) => {
		setActiveView(view?.view_id ?? null);
		const { closed, ...saved } = view?.state.filters ?? {};
		setFilters({
			...noFilters,
			...saved,
			archive:
				saved.archive ??
				(closed === "include"
					? "all"
					: closed === "only"
						? "archived"
						: ""),
		});
		if (view?.state.tab) setTab(view.state.tab);
		setLanes(view?.state.lanes ?? "");
		setSort(view?.state.sort ?? "updated");
	};

	const tabs: [Tab, string][] = [
		["board", "Board"],
		["table", "Table"],
		["list", "List"],
		["calendar", "Calendar"],
		...(may.engineer ? ([["metrics", "Metrics"]] as [Tab, string][]) : []),
	];
	const choiceOptions = (
		list: { id: string; label: string }[],
		none: string,
	) => [
		{ value: "", label: none },
		...list.map((choice) => ({ value: choice.id, label: choice.label })),
	];

	return (
		<div
			className={`${styles.page} ${tab === "board" && !lanes ? styles.pageFit : ""}`}
		>
			<header className={styles.header}>
				<div>
					<h1 className={styles.title}>Requests</h1>
					<p className={styles.subtitle}>
						Work asked of the data engineers, from a form, the
						assistant or reader feedback, and where each one is.
					</p>
				</div>
			</header>

			<div className={styles.tabs} role="tablist">
				{tabs.map(([id, label]) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={tab === id}
						className={`${styles.tab} ${tab === id ? styles.tabOn : ""}`}
						onClick={() => setTab(id)}
					>
						{label}
					</button>
				))}
			</div>

			{tab !== "metrics" && (
				<div className={styles.toolbarRows}>
					<div className={styles.toolbar}>
						{may.engineer && (
							<button
								type="button"
								className={styles.create}
								onClick={() => setRequesting({})}
							>
								<svg
									viewBox="0 0 24 24"
									width="16"
									height="16"
									aria-hidden="true"
								>
									<path
										d="M12 5v14M5 12h14"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										fill="none"
									/>
								</svg>
								New item
							</button>
						)}
						{(may.request || may.engineer) && (
							<button
								type="button"
								className={
									may.engineer
										? styles.secondary
										: styles.create
								}
								onClick={() =>
									setRequesting({ asRequest: true })
								}
							>
								Request work
							</button>
						)}
						<input
							className={`${styles.search} ${styles.searchWide}`}
							value={filters.q}
							placeholder="Search titles, details, tags or a key"
							aria-label="Search requests"
							onChange={(e) => set({ q: e.target.value })}
						/>
						<div className={styles.toolbarEnd}>
							<WorkViews<ViewState>
								me={data.me}
								current={{ filters, tab, lanes, sort }}
								activeViewId={activeView}
								onApply={applyView}
							/>
						</div>
					</div>

					<div className={styles.toolbar}>
						<div
							className={styles.chips}
							role="group"
							aria-label="Quick filters"
						>
							<button
								type="button"
								className={styles.chip}
								aria-pressed={filters.assignee === "me"}
								onClick={() =>
									set({
										assignee:
											filters.assignee === "me"
												? ""
												: "me",
									})
								}
							>
								Assigned to me
							</button>
							<button
								type="button"
								className={styles.chip}
								aria-pressed={filters.requester === "me"}
								onClick={() =>
									set({
										requester:
											filters.requester === "me"
												? ""
												: "me",
									})
								}
							>
								Asked by me
							</button>
							<button
								type="button"
								className={styles.chip}
								aria-pressed={filters.blocked === "true"}
								onClick={() =>
									set({
										blocked:
											filters.blocked === "true"
												? ""
												: "true",
									})
								}
							>
								<BlockedIcon size={12} />
								Blocked
							</button>
							<FilterMenu count={menuFilters.length}>
								<label className={styles.filterField}>
									<span className={styles.filterLabel}>
										Type
									</span>
									<Select
										value={filters.workType}
										ariaLabel="Work type"
										onChange={(v) => set({ workType: v })}
										options={choiceOptions(
											config.workTypes,
											"Any type",
										)}
									/>
								</label>
								<label className={styles.filterField}>
									<span className={styles.filterLabel}>
										Priority
									</span>
									<Select
										value={filters.priority}
										ariaLabel="Priority"
										onChange={(v) => set({ priority: v })}
										options={choiceOptions(
											config.priorities,
											"Any priority",
										)}
									/>
								</label>
								{config.domains.length > 0 && (
									<label className={styles.filterField}>
										<span className={styles.filterLabel}>
											Domain
										</span>
										<Select
											value={filters.domain}
											ariaLabel="Domain"
											onChange={(v) => set({ domain: v })}
											options={choiceOptions(
												config.domains,
												"Any domain",
											)}
										/>
									</label>
								)}
								{config.layers.length > 0 && (
									<label className={styles.filterField}>
										<span className={styles.filterLabel}>
											Layer
										</span>
										<Select
											value={filters.layer}
											ariaLabel="Layer"
											onChange={(v) => set({ layer: v })}
											options={choiceOptions(
												config.layers,
												"Any layer",
											)}
										/>
									</label>
								)}
								{releases.length > 0 && (
									<label className={styles.filterField}>
										<span className={styles.filterLabel}>
											Release
										</span>
										<Select
											value={filters.release}
											ariaLabel="Release"
											onChange={(v) =>
												set({ release: v })
											}
											options={[
												{
													value: "",
													label: "Any release",
												},
												...releases.map((r) => ({
													value: r.id,
													label: r.name,
													note: releaseDate(r.target),
												})),
											]}
										/>
									</label>
								)}
							</FilterMenu>
						</div>

						{menuFilters.map((filter) => (
							<span
								key={filter.key}
								className={styles.filterChip}
							>
								<span className={styles.filterChipName}>
									{filter.name}:
								</span>
								{filter.value}
								<button
									type="button"
									className={styles.filterChipRemove}
									aria-label={`Remove the ${filter.name.toLowerCase()} filter`}
									onClick={() => set({ [filter.key]: "" })}
								>
									<svg
										width="12"
										height="12"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2.5"
										strokeLinecap="round"
										aria-hidden="true"
									>
										<path d="M18 6L6 18M6 6l12 12" />
									</svg>
								</button>
							</span>
						))}
						{JSON.stringify(filters) !==
							JSON.stringify(noFilters) && (
							<button
								type="button"
								className={styles.link}
								onClick={() => setFilters(noFilters)}
							>
								Clear all
							</button>
						)}

						<div className={styles.toolbarEnd}>
							<div
								className={styles.segmented}
								role="group"
								aria-label="Active or archived"
							>
								{[
									{ value: "", label: "Active" },
									{ value: "archived", label: "Archived" },
									{ value: "all", label: "All" },
								].map((option) => (
									<button
										key={option.value}
										type="button"
										className={styles.segment}
										aria-pressed={
											filters.archive === option.value
										}
										title={
											option.value === "archived"
												? config.rules
														.archiveDoneAfterDays
													? `Declined, duplicates, and requests done for over ${config.rules.archiveDoneAfterDays} days`
													: "Declined and duplicate requests"
												: undefined
										}
										onClick={() =>
											set({ archive: option.value })
										}
									>
										{option.label}
									</button>
								))}
							</div>
							<span className={styles.menuShort}>
								<Select
									value={sort}
									ariaLabel="Sort"
									onChange={(v) => setSort(v as SortOrder)}
									options={sortOrders.map((order) => ({
										value: order.value,
										label: `Sort: ${order.label}`,
									}))}
								/>
							</span>
							{tab === "board" && (
								<span className={styles.menuShort}>
									<Select
										value={lanes}
										ariaLabel="Group the board"
										onChange={setLanes}
										options={[
											{ value: "", label: "Group: None" },
											...(config.domains.length > 0
												? [
														{
															value: "domain",
															label: "Group: Domain",
														},
													]
												: []),
											{
												value: "assignee",
												label: "Group: Assignee",
											},
											{
												value: "priority",
												label: "Group: Priority",
											},
											{
												value: "release",
												label: "Group: Release",
											},
										]}
									/>
								</span>
							)}
							{tab === "board" &&
								lanes === "release" &&
								may.engineer && (
									<button
										type="button"
										className={styles.secondary}
										onClick={() => setEditingRelease("new")}
									>
										New release
									</button>
								)}
						</div>
					</div>
				</div>
			)}

			{failure && <p className={styles.failure}>{failure}</p>}

			{tab === "board" && (
				<Board
					items={items}
					config={config}
					lanes={lanes}
					releases={releases}
					canMove={may.engineer}
					onMove={(key, to, lane) => move(key, to, lane)}
					onOpen={open}
					onAdd={
						may.engineer
							? (status, releaseId) =>
									setRequesting({ status, releaseId })
							: null
					}
					onEditRelease={setEditingRelease}
					onShipRelease={setShipping}
				/>
			)}
			{tab === "table" && (
				<>
					{may.engineer && selected.size > 0 && (
						<div className={styles.bulk}>
							<span>{selected.size} selected</span>
							<Select
								value=""
								ariaLabel="Move selected"
								placeholder="Move to"
								onChange={(to) =>
									void bulk((key) => move(key, to))
								}
								options={config.columns
									.filter((c) => !c.hidden)
									.map((c) => ({
										value: c.id,
										label: c.label,
									}))}
							/>
							<Select
								value=""
								ariaLabel="Set priority"
								placeholder="Set priority"
								onChange={(p) =>
									void bulk((key) =>
										update(key, { priority: p }),
									)
								}
								options={config.priorities.map((p) => ({
									value: p.id,
									label: p.label,
								}))}
							/>
							<span className={styles.menu}>
								<ReleaseSelect
									value=""
									none="Add to release"
									onChange={(releaseId) => {
										if (!releaseId) return;
										void bulk((key) =>
											update(key, { releaseId }),
										).then(() => refreshReleases());
									}}
								/>
							</span>
							<span className={styles.menu}>
								<AssignSelect
									onChange={(person) =>
										void bulk((key) =>
											update(key, {
												assignees: [
													...new Set([
														...(items.find(
															(i) =>
																i.key === key,
														)?.assignees ?? []),
														person,
													]),
												],
											}),
										)
									}
								/>
							</span>
							<button
								type="button"
								className={styles.link}
								onClick={() => setSelected(new Set())}
							>
								Clear
							</button>
						</div>
					)}
					<Table
						items={items}
						config={config}
						editable={may.engineer}
						selected={selected}
						onSelect={setSelected}
						onMove={move}
						onUpdate={update}
						onOpen={open}
					/>
				</>
			)}
			{tab === "list" && (
				<List items={items} config={config} onOpen={open} />
			)}
			{tab === "calendar" && (
				<WorkCalendar items={items} config={config} onOpen={open} />
			)}
			{tab === "metrics" && may.engineer && (
				<WorkMetrics config={config} />
			)}
			{requesting && (
				<RequestForm
					config={config}
					draft={requesting}
					engineer={may.engineer && !requesting.asRequest}
					me={data.me}
					onClose={() => {
						setRequesting(null);
						if (asked.get("new")) router.replace("/work");
					}}
					onCreated={(key) => {
						// Made from the board, it stays on the board. Asked for,
						// it opens, so the person sees what they sent.
						if (
							may.engineer &&
							!requesting.asRequest &&
							!asked.get("new")
						) {
							setRequesting(null);
							void mutate();
							void refreshReleases();
						} else {
							router.push(`/work/${key}`);
						}
					}}
				/>
			)}
			{editingRelease && (
				<ReleaseDialog
					release={
						editingRelease === "new" ? undefined : editingRelease
					}
					onClose={() => setEditingRelease(null)}
					onSaved={() => {
						setEditingRelease(null);
						void refreshReleases();
						void mutate();
					}}
				/>
			)}
			{shipping && (
				<ShipDialog
					release={shipping}
					onClose={() => setShipping(null)}
					onShipped={() => {
						setShipping(null);
						void refreshReleases();
						void mutate();
					}}
				/>
			)}
		</div>
	);
}

// --- Board -------------------------------------------------------------------

function Card({
	item,
	config,
	onOpen,
	onPointerDown,
	onKeyDown,
	state,
}: {
	item: WorkSummary;
	config: WorkConfig;
	onOpen: (key: string) => void;
	onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
	// Shift with an arrow key, to move it a column.
	onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
	// Left behind while it is dragged, or the copy following the pointer.
	state?: "left" | "lifted";
}) {
	return (
		<button
			type="button"
			className={`${styles.card} ${item.blocked ? styles.cardBlocked : ""} ${state === "left" ? styles.cardLeft : ""} ${state === "lifted" ? styles.cardLifted : ""}`}
			tabIndex={state === "lifted" ? -1 : undefined}
			aria-hidden={state === "lifted" || undefined}
			data-card={state === "lifted" ? undefined : item.key}
			aria-keyshortcuts={
				onKeyDown ? "Shift+ArrowLeft Shift+ArrowRight" : undefined
			}
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			onClick={() => onOpen(item.key)}
		>
			<span className={styles.cardTop}>
				<span className={styles.key}>{item.key}</span>
				<span className={styles.cardFlags}>
					{item.blocked && (
						<span className={styles.blockedFlag}>
							<BlockedIcon size={12} />
							Blocked
						</span>
					)}
					{item.visibility === "restricted" && (
						<span className={styles.badge}>Sensitive</span>
					)}
					{item.priority && (
						<span
							className={`${styles.priority} ${styles[`priority_${item.priority}`] ?? ""}`}
						>
							{labelOf(config.priorities, item.priority)}
						</span>
					)}
				</span>
			</span>
			<span className={styles.cardTitle}>{item.title}</span>
			{item.blocked && item.blockedReason && (
				<span
					className={styles.blockedReason}
					title={item.blockedReason}
				>
					{item.blockedReason}
				</span>
			)}
			<span className={styles.cardMeta}>
				{item.effort && <span>{effortLabel(config, item.effort)}</span>}
				{item.target && <span>Target {item.target}</span>}
				{item.children.total > 0 && (
					<span>
						{item.children.done} of {item.children.total} sub-tasks
					</span>
				)}
				{item.requesters > 1 && <span>{item.requesters} asking</span>}
				<span>{daysSince(item.statusSince)}d here</span>
			</span>
			{(item.tags.length > 0 || item.assignees.length > 0) && (
				<span className={styles.cardBottom}>
					<span className={styles.tags}>
						{item.tags.slice(0, 4).map((tag) => (
							<span key={tag} className={styles.tag}>
								{tag}
							</span>
						))}
					</span>
					<span className={styles.avatars}>
						{item.assignees.slice(0, 3).map((person) => (
							<span
								key={person}
								className={styles.avatar}
								title={personName(person)}
							>
								{initials(person)}
							</span>
						))}
					</span>
				</span>
			)}
		</button>
	);
}

function laneOf(item: WorkSummary, lanes: string, config: WorkConfig): string {
	if (lanes === "domain")
		return labelOf(config.domains, item.domain) || "No domain";
	if (lanes === "priority")
		return labelOf(config.priorities, item.priority) || "No priority";
	if (lanes === "assignee")
		return item.assignees[0] ? personName(item.assignees[0]) : "Unassigned";
	if (lanes === "release") return item.releaseId ?? "";
	return "";
}

interface Lane {
	// What laneOf gives for the items in it. For releases, the release id.
	id: string;
	title: string;
	release: Release | null;
}

function lanesFor(
	items: WorkSummary[],
	lanes: string,
	config: WorkConfig,
	releases: Release[],
): Lane[] {
	if (lanes === "release") {
		// Every release still to ship has a row, even with nothing in it yet,
		// so items can be dragged into it. A shipped one shows only while it
		// still holds open items.
		const holding = new Set(items.map((item) => item.releaseId));
		return [
			...releases
				.filter((r) => !r.shippedOn || holding.has(r.id))
				.map((r) => ({ id: r.id, title: r.name, release: r })),
			{ id: "", title: "No release", release: null },
		];
	}
	if (!lanes) return [{ id: "", title: "", release: null }];
	const names = [
		...new Set(items.map((item) => laneOf(item, lanes, config))),
	];
	names.sort((a, b) =>
		lanes === "priority"
			? priorityOrder.indexOf(
					config.priorities.find((p) => p.label === a)?.id ?? "",
				) -
				priorityOrder.indexOf(
					config.priorities.find((p) => p.label === b)?.id ?? "",
				)
			: a.localeCompare(b),
	);
	// With nothing to group, the columns still show, so there is somewhere to
	// see the board's shape and add an item.
	if (names.length === 0) return [{ id: "", title: "", release: null }];
	return names.map((name) => ({ id: name, title: name, release: null }));
}

function Board({
	items,
	config,
	lanes,
	releases,
	canMove,
	onMove,
	onOpen,
	onAdd,
	onEditRelease,
	onShipRelease,
}: {
	items: WorkSummary[];
	config: WorkConfig;
	lanes: string;
	releases: Release[];
	canMove: boolean;
	onMove: (key: string, to: string, lane: string | null) => Promise<void>;
	onOpen: (key: string) => void;
	onAdd: ((status: string, releaseId: string) => void) | null;
	onEditRelease: (release: Release) => void;
	onShipRelease: (release: Release) => void;
}) {
	const columns = config.columns.filter((column) => !column.hidden);
	const [announcement, setAnnouncement] = useState("");
	const { drag, landing, begin, wasDragged, moveTo } = useCardDrag({
		canMove,
		lanes,
		items,
		onMove,
	});
	// A card just dropped shows in its new column while the move is saved.
	const open = items
		.filter((item) => !item.closedAs)
		.map((item) =>
			landing && item.key === landing.key
				? {
						...item,
						status: landing.status,
						releaseId:
							landing.lane === null
								? item.releaseId
								: landing.lane || null,
					}
				: item,
		);
	const rows = lanesFor(open, lanes, config, releases);
	const over = drag?.over ?? null;
	return (
		<div className={styles.boardWrap}>
			{rows.map((lane) => (
				<section key={lane.id || "none"} className={styles.lane}>
					{lane.title && (
						<div className={styles.laneHead}>
							<h2 className={styles.laneTitle}>{lane.title}</h2>
							{lane.release && (
								<>
									<span className={styles.meta}>
										{releaseDate(lane.release.target)}
									</span>
									<span className={styles.laneProgress}>
										<span
											style={{
												width: `${lane.release.items ? (lane.release.done / lane.release.items) * 100 : 0}%`,
											}}
										/>
									</span>
									<span className={styles.meta}>
										{lane.release.done} of{" "}
										{lane.release.items} done
									</span>
									{lane.release.shippedOn ? (
										<span className={styles.badge}>
											Shipped{" "}
											{releaseDate(
												lane.release.shippedOn,
											)}
										</span>
									) : (
										canMove && (
											<span
												className={styles.laneActions}
											>
												<button
													type="button"
													className={styles.link}
													onClick={() =>
														onEditRelease(
															lane.release!,
														)
													}
												>
													Edit
												</button>
												<button
													type="button"
													className={styles.secondary}
													onClick={() =>
														onShipRelease(
															lane.release!,
														)
													}
												>
													Ship
												</button>
											</span>
										)
									)}
								</>
							)}
						</div>
					)}
					<div
						className={styles.board}
						data-board=""
						style={{
							gridTemplateColumns: `repeat(${columns.length}, minmax(200px, 1fr))`,
						}}
					>
						{columns.map((column) => {
							const here = open.filter(
								(item) =>
									item.status === column.id &&
									(!lanes ||
										laneOf(item, lanes, config) ===
											lane.id),
							);
							const target = `${lane.id}|${column.id}`;
							return (
								<div
									key={column.id}
									className={`${styles.column} ${over === target ? styles.columnOver : ""}`}
									data-drop={target}
								>
									<div className={styles.columnHead}>
										<span>{column.label}</span>
										<span className={styles.columnTools}>
											<span className={styles.count}>
												{here.length}
											</span>
											{onAdd && (
												<button
													type="button"
													className={styles.addButton}
													aria-label={`New item in ${column.label}${lane.release ? `, ${lane.release.name}` : ""}`}
													title="New item here"
													onClick={() =>
														onAdd(
															column.id,
															lane.release?.id ??
																"",
														)
													}
												>
													<svg
														viewBox="0 0 24 24"
														width="14"
														height="14"
														aria-hidden="true"
													>
														<path
															d="M12 5v14M5 12h14"
															stroke="currentColor"
															strokeWidth="2"
															strokeLinecap="round"
															fill="none"
														/>
													</svg>
												</button>
											)}
										</span>
									</div>
									<div className={styles.cards} data-cards="">
										{drag &&
											over === target &&
											drag.from !== target && (
												<div
													className={styles.dropSlot}
													style={{
														height: drag.height,
													}}
													aria-hidden="true"
												/>
											)}
										{here.map((item) => (
											<Card
												key={item.id}
												item={item}
												config={config}
												state={
													drag?.item.key === item.key
														? "left"
														: undefined
												}
												onPointerDown={
													canMove
														? (e) =>
																begin(
																	item,
																	target,
																	e,
																)
														: undefined
												}
												onKeyDown={
													canMove
														? (e) => {
																if (
																	!e.shiftKey ||
																	(e.key !==
																		"ArrowLeft" &&
																		e.key !==
																			"ArrowRight")
																)
																	return;
																e.preventDefault();
																const at =
																	columns.findIndex(
																		(c) =>
																			c.id ===
																			column.id,
																	);
																const next =
																	columns[
																		at +
																			(e.key ===
																			"ArrowLeft"
																				? -1
																				: 1)
																	];
																if (!next)
																	return;
																moveTo(
																	item.key,
																	next.id,
																	lanes ===
																		"release"
																		? lane.id
																		: null,
																);
																setAnnouncement(
																	`${item.key} moved to ${next.label}`,
																);
															}
														: undefined
												}
												onOpen={(key) => {
													if (!wasDragged())
														onOpen(key);
												}}
											/>
										))}
									</div>
								</div>
							);
						})}
					</div>
				</section>
			))}
			<p className={styles.srOnly} aria-live="polite">
				{announcement}
			</p>
			{drag &&
				createPortal(
					<div
						className={styles.dragLayer}
						style={{
							width: drag.width,
							transform: `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px)`,
						}}
					>
						<Card
							item={drag.item}
							config={config}
							state="lifted"
							onOpen={() => {}}
						/>
					</div>,
					document.body,
				)}
		</div>
	);
}

interface CardDrag {
	item: WorkSummary;
	// The lane and column it came from, as "lane|column".
	from: string;
	// Where it would land, as "lane|column", or null over nothing.
	over: string | null;
	x: number;
	y: number;
	// Where in the card it was picked up, so it stays under the pointer there.
	offsetX: number;
	offsetY: number;
	width: number;
	height: number;
}

// How far the pointer moves before a press becomes a drag, so a click with a
// shaky hand still opens the card.
const dragThreshold = 5;
// How close to an edge of a scrolling area the pointer has to be to scroll it.
const edgeZone = 56;
// How long a finger rests on a card before it lifts, and how far it may drift
// meanwhile. Moving further first is a scroll.
const holdMs = 350;
const holdDrift = 10;

// Moving cards with the pointer rather than the browser's own drag, which
// draws a faint copy and shows nothing of where the card will land. On touch a
// card lifts after a short hold, so a quick swipe still scrolls the board.
function useCardDrag({
	canMove,
	lanes,
	items,
	onMove,
}: {
	canMove: boolean;
	lanes: string;
	items: WorkSummary[];
	onMove: (key: string, to: string, lane: string | null) => Promise<void>;
}) {
	const [drag, setDrag] = useState<CardDrag | null>(null);
	const [landing, setLanding] = useState<{
		key: string;
		status: string;
		lane: string | null;
	} | null>(null);
	const live = useRef<CardDrag | null>(null);
	const pressed = useRef<{
		item: WorkSummary;
		from: string;
		startX: number;
		startY: number;
		rect: DOMRect;
		// A finger, which has to hold still before the card lifts.
		touch: boolean;
		held: boolean;
	} | null>(null);
	const holdTimer = useRef(0);
	const startHold = useRef<() => void>(() => {});
	const dragged = useRef(false);
	const moveRef = useRef(onMove);
	moveRef.current = onMove;

	// The landing copy goes once the saved items agree, or the move failed.
	useEffect(() => {
		if (!landing) return;
		const now = items.find((item) => item.key === landing.key);
		if (!now || now.status === landing.status) setLanding(null);
	}, [items, landing]);

	useEffect(() => {
		let frame = 0;
		const show = (next: CardDrag | null) => {
			live.current = next;
			setDrag(next);
		};
		// Where a card under the pointer would go. Only grouping by release
		// changes anything but the column, so other groupings land it in its
		// own row.
		const targetAt = (x: number, y: number, from: string) => {
			const zone = document
				.elementFromPoint(x, y)
				?.closest<HTMLElement>("[data-drop]");
			if (!zone) return null;
			const [lane, column] = (zone.dataset.drop ?? "").split("|");
			return lanes === "release"
				? `${lane}|${column}`
				: `${from.split("|")[0]}|${column}`;
		};
		// Scrolls the board sideways and a column up or down while the pointer
		// is near their edges.
		const scrollEdges = () => {
			const current = live.current;
			if (!current) return;
			const under = document.elementFromPoint(current.x, current.y);
			const board = under?.closest<HTMLElement>("[data-board]");
			const cards = under?.closest<HTMLElement>("[data-cards]");
			const nudge = (distance: number) =>
				Math.round(((edgeZone - distance) / edgeZone) * 14);
			if (board) {
				const box = board.getBoundingClientRect();
				if (current.x - box.left < edgeZone)
					board.scrollLeft -= nudge(current.x - box.left);
				else if (box.right - current.x < edgeZone)
					board.scrollLeft += nudge(box.right - current.x);
			}
			if (cards) {
				const box = cards.getBoundingClientRect();
				if (current.y - box.top < edgeZone)
					cards.scrollTop -= nudge(current.y - box.top);
				else if (box.bottom - current.y < edgeZone)
					cards.scrollTop += nudge(box.bottom - current.y);
			}
			frame = requestAnimationFrame(scrollEdges);
		};
		const finish = () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(holdTimer.current);
			document.body.style.userSelect = "";
			pressed.current = null;
			show(null);
		};
		const lift = (x: number, y: number) => {
			const press = pressed.current;
			if (!press) return;
			document.body.style.userSelect = "none";
			dragged.current = true;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(scrollEdges);
			show({
				item: press.item,
				from: press.from,
				over: targetAt(x, y, press.from),
				x,
				y,
				offsetX: press.startX - press.rect.left,
				offsetY: press.startY - press.rect.top,
				width: press.rect.width,
				height: press.rect.height,
			});
		};
		// Lets begin start the hold on a touch press.
		startHold.current = () => {
			window.clearTimeout(holdTimer.current);
			holdTimer.current = window.setTimeout(() => {
				const press = pressed.current;
				if (!press?.touch) return;
				press.held = true;
				navigator.vibrate?.(10);
				lift(press.startX, press.startY);
			}, holdMs);
		};
		const onPointerMove = (event: PointerEvent) => {
			const press = pressed.current;
			if (!press) return;
			const moved = Math.hypot(
				event.clientX - press.startX,
				event.clientY - press.startY,
			);
			if (press.touch && !press.held) {
				// Moving before the hold ends is a scroll, not a drag.
				if (moved > holdDrift) finish();
				return;
			}
			if (!live.current && moved < dragThreshold) return;
			lift(event.clientX, event.clientY);
		};
		// Once a card is lifted by a finger, moving it must not scroll the page.
		const onTouchMove = (event: TouchEvent) => {
			if (live.current) event.preventDefault();
		};
		const onContextMenu = (event: Event) => {
			if (pressed.current?.touch) event.preventDefault();
		};
		const onPointerUp = () => {
			const current = live.current;
			finish();
			if (!current?.over || current.over === current.from) return;
			const [lane, status] = current.over.split("|");
			const key = current.item.key;
			const laneChange = lanes === "release" ? lane : null;
			setLanding({ key, status, lane: laneChange });
			void moveRef
				.current(key, status, laneChange)
				.finally(() => setLanding(null));
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && live.current) finish();
		};
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", finish);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("touchmove", onTouchMove, { passive: false });
		window.addEventListener("contextmenu", onContextMenu);
		return () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(holdTimer.current);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", finish);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("touchmove", onTouchMove);
			window.removeEventListener("contextmenu", onContextMenu);
		};
	}, [lanes]);

	return {
		drag,
		landing,
		begin: (
			item: WorkSummary,
			from: string,
			event: React.PointerEvent<HTMLButtonElement>,
		) => {
			if (!canMove || event.button !== 0) return;
			const touch = event.pointerType === "touch";
			dragged.current = false;
			pressed.current = {
				item,
				from,
				startX: event.clientX,
				startY: event.clientY,
				rect: event.currentTarget.getBoundingClientRect(),
				touch,
				held: false,
			};
			if (touch) startHold.current();
		},
		// A move made from the keyboard, shown in its new column while it saves
		// and keeping focus on the card.
		moveTo: (key: string, status: string, lane: string | null) => {
			setLanding({ key, status, lane });
			requestAnimationFrame(() =>
				requestAnimationFrame(() =>
					document
						.querySelector<HTMLElement>(`[data-card="${key}"]`)
						?.focus(),
				),
			);
			void moveRef
				.current(key, status, lane)
				.finally(() => setLanding(null));
		},
		// True once after a drag, so the click that ends it does not open the
		// card.
		wasDragged: () => {
			const was = dragged.current;
			dragged.current = false;
			return was;
		},
	};
}

// --- Table and list ----------------------------------------------------------

function Table({
	items,
	config,
	editable,
	selected,
	onSelect,
	onMove,
	onUpdate,
	onOpen,
}: {
	items: WorkSummary[];
	config: WorkConfig;
	editable: boolean;
	selected: Set<string>;
	onSelect: (next: Set<string>) => void;
	onMove: (key: string, to: string) => void;
	onUpdate: (key: string, patch: Record<string, unknown>) => void;
	onOpen: (key: string) => void;
}) {
	const [sort, setSort] = useState<{ by: keyof WorkSummary; desc: boolean }>({
		by: "modifiedOn",
		desc: true,
	});
	const sorted = [...items].sort((a, b) => {
		const left = String(a[sort.by] ?? "");
		const right = String(b[sort.by] ?? "");
		return sort.desc
			? right.localeCompare(left, undefined, { numeric: true })
			: left.localeCompare(right, undefined, { numeric: true });
	});
	const head = (by: keyof WorkSummary, label: string) => (
		<th>
			<button
				type="button"
				className={styles.sortHead}
				onClick={() =>
					setSort({ by, desc: sort.by === by ? !sort.desc : false })
				}
			>
				{label}
				{sort.by === by ? (sort.desc ? " ↓" : " ↑") : ""}
			</button>
		</th>
	);
	const toggle = (key: string) => {
		const next = new Set(selected);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		onSelect(next);
	};
	return (
		<div className={styles.tableWrap}>
			<table className={styles.table}>
				<thead>
					<tr>
						{editable && (
							<th>
								<input
									type="checkbox"
									aria-label="Select every request"
									checked={
										selected.size > 0 &&
										selected.size === items.length
									}
									onChange={(e) =>
										onSelect(
											e.target.checked
												? new Set(
														items.map((i) => i.key),
													)
												: new Set(),
										)
									}
								/>
							</th>
						)}
						{head("number", "Key")}
						{head("title", "Title")}
						{head("status", "Status")}
						{head("priority", "Priority")}
						{head("effort", "Effort")}
						<th>Assigned</th>
						{config.domains.length > 0 && head("domain", "Domain")}
						{head("target", "Target")}
						{head("modifiedOn", "Updated")}
					</tr>
				</thead>
				<tbody>
					{sorted.map((item) => (
						<tr
							key={item.id}
							className={item.blocked ? styles.rowBlocked : ""}
						>
							{editable && (
								<td>
									<input
										type="checkbox"
										aria-label={`Select ${item.key}`}
										checked={selected.has(item.key)}
										onChange={() => toggle(item.key)}
									/>
								</td>
							)}
							<td>
								<button
									type="button"
									className={styles.keyLink}
									onClick={() => onOpen(item.key)}
								>
									{item.key}
								</button>
							</td>
							<td className={styles.titleCell}>
								<button
									type="button"
									className={styles.titleLink}
									onClick={() => onOpen(item.key)}
								>
									{item.title}
								</button>
								{item.blocked && (
									<span className={styles.blockedMini}>
										<BlockedIcon size={12} />
										Blocked
									</span>
								)}
							</td>
							<td>
								{editable && !item.closedAs ? (
									<Select
										value={item.status}
										ariaLabel={`Status of ${item.key}`}
										onChange={(to) => onMove(item.key, to)}
										options={config.columns.map((c) => ({
											value: c.id,
											label: c.label,
										}))}
									/>
								) : item.closedAs ? (
									item.closedAs === "duplicate" ? (
										"Duplicate"
									) : (
										"Declined"
									)
								) : (
									columnLabel(config, item.status)
								)}
							</td>
							<td>
								{editable ? (
									<Select
										value={item.priority ?? ""}
										ariaLabel={`Priority of ${item.key}`}
										onChange={(p) =>
											onUpdate(item.key, {
												priority: p || null,
											})
										}
										options={[
											{ value: "", label: "None" },
											...config.priorities.map((p) => ({
												value: p.id,
												label: p.label,
											})),
										]}
									/>
								) : (
									labelOf(config.priorities, item.priority)
								)}
							</td>
							<td>
								{editable ? (
									<Select
										value={item.effort ?? ""}
										ariaLabel={`Effort of ${item.key}`}
										onChange={(e) =>
											onUpdate(item.key, {
												effort: e || null,
											})
										}
										options={[
											{ value: "", label: "None" },
											...config.efforts.map((e) => ({
												value: e.id,
												label: e.label,
											})),
										]}
									/>
								) : (
									effortLabel(config, item.effort)
								)}
							</td>
							<td>{item.assignees.map(personName).join(", ")}</td>
							{config.domains.length > 0 && (
								<td>{labelOf(config.domains, item.domain)}</td>
							)}
							<td>{item.target ?? ""}</td>
							<td>
								{new Date(item.modifiedOn).toLocaleDateString()}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{items.length === 0 && <NoRequests />}
		</div>
	);
}

// What the table and the list show when the filters leave nothing.
function NoRequests() {
	return (
		<EmptyState icon={emptyIcons.filter} title="No requests match">
			Try clearing a filter or the search above.
		</EmptyState>
	);
}

function List({
	items,
	config,
	onOpen,
}: {
	items: WorkSummary[];
	config: WorkConfig;
	onOpen: (key: string) => void;
}) {
	const groups = [
		...config.columns.map((column) => ({
			label: column.label,
			items: items.filter((i) => !i.closedAs && i.status === column.id),
		})),
		{ label: "Closed", items: items.filter((i) => i.closedAs) },
	].filter((group) => group.items.length > 0);
	if (groups.length === 0) return <NoRequests />;
	return (
		<div className={styles.list}>
			{groups.map((group) => (
				<section key={group.label}>
					<h2 className={styles.laneTitle}>
						{group.label}{" "}
						<span className={styles.count}>
							{group.items.length}
						</span>
					</h2>
					<ul className={styles.listItems}>
						{group.items.map((item) => (
							<li key={item.id}>
								<button
									type="button"
									className={styles.listRow}
									onClick={() => onOpen(item.key)}
								>
									<span className={styles.key}>
										{item.key}
									</span>
									<span className={styles.listTitle}>
										{item.title}
									</span>
									{item.blocked && (
										<span className={styles.blockedMini}>
											<BlockedIcon size={12} />
											Blocked
										</span>
									)}
									<span className={styles.meta}>
										{[
											labelOf(
												config.priorities,
												item.priority,
											),
											effortLabel(config, item.effort),
											item.assignees
												.map(personName)
												.join(", "),
										]
											.filter(Boolean)
											.join(", ")}
									</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

// Adds somebody to every selected item.
function AssignSelect({ onChange }: { onChange: (email: string) => void }) {
	const { data } = useSWR<{ people: { email: string; name: string }[] }>(
		"/api/changes?people=1",
	);
	return (
		<Select
			value=""
			searchable
			ariaLabel="Assign selected"
			placeholder="Assign to"
			onChange={(email) => email && onChange(email)}
			options={(data?.people ?? []).map((p) => ({
				value: p.email,
				label: p.name,
				note: p.email,
			}))}
		/>
	);
}
