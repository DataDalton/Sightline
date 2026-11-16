"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import type { WorkConfig } from "../../lib/work/model";
import type { Release } from "../../lib/work/releases";
import type { WorkSummary } from "../../lib/work/store";
import { describeFetchError } from "../../lib/swr";
import { Select } from "../components/shared/Select";
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
import styles from "./Work.module.css";

// The work queue: items for the data engineers, on a board whose columns are
// the statuses, and as a table, a list, a calendar of targets and the queue's
// numbers. Releases are worked on the board itself, grouped by release.
// Anybody can see what they asked for and what is about the data they read.
// The engineers see everything, make items directly and move them.

type Tab = "board" | "table" | "list" | "calendar" | "metrics";

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
	closed: string;
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
	closed: "",
	release: "",
};

// What a saved view keeps.
interface ViewState {
	filters?: Partial<Filters>;
	tab?: Tab;
	lanes?: string;
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
	const [tab, setTab] = useState<Tab>("board");
	const [filters, setFilters] = useState<Filters>(noFilters);
	const [lanes, setLanes] = useState("");
	const [requesting, setRequesting] = useState<RequestDraft | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());

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

	if (error) {
		return (
			<div className={styles.page}>
				<p className={styles.empty}>
					{describeFetchError(error, "requests")}
				</p>
			</div>
		);
	}
	if (!data) return <div className={styles.page} />;
	const { config, items, may } = data;
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
		setFilters({ ...noFilters, ...(view?.state.filters ?? {}) });
		if (view?.state.tab) setTab(view.state.tab);
		setLanes(view?.state.lanes ?? "");
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
		<div className={styles.page}>
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
								may.engineer ? styles.secondary : styles.create
							}
							onClick={() => setRequesting({ asRequest: true })}
						>
							Request work
						</button>
					)}
					<input
						className={styles.search}
						value={filters.q}
						placeholder="Search titles, details, tags or a key"
						aria-label="Search requests"
						onChange={(e) => set({ q: e.target.value })}
					/>
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
										filters.assignee === "me" ? "" : "me",
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
										filters.requester === "me" ? "" : "me",
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
							Blocked
						</button>
					</div>
					<div className={styles.menus}>
						<span className={styles.menu}>
							<Select
								value={filters.workType}
								ariaLabel="Work type"
								onChange={(v) => set({ workType: v })}
								options={choiceOptions(
									config.workTypes,
									"Any type",
								)}
							/>
						</span>
						<span className={styles.menu}>
							<Select
								value={filters.priority}
								ariaLabel="Priority"
								onChange={(v) => set({ priority: v })}
								options={choiceOptions(
									config.priorities,
									"Any priority",
								)}
							/>
						</span>
						{config.domains.length > 0 && (
							<span className={styles.menu}>
								<Select
									value={filters.domain}
									ariaLabel="Domain"
									onChange={(v) => set({ domain: v })}
									options={choiceOptions(
										config.domains,
										"Any domain",
									)}
								/>
							</span>
						)}
						{config.layers.length > 0 && (
							<span className={styles.menu}>
								<Select
									value={filters.layer}
									ariaLabel="Layer"
									onChange={(v) => set({ layer: v })}
									options={choiceOptions(
										config.layers,
										"Any layer",
									)}
								/>
							</span>
						)}
						{releases.length > 0 && (
							<span className={styles.menu}>
								<Select
									value={filters.release}
									ariaLabel="Release"
									onChange={(v) => set({ release: v })}
									options={[
										{ value: "", label: "Any release" },
										...releases.map((r) => ({
											value: r.id,
											label: r.name,
											note: releaseDate(r.target),
										})),
									]}
								/>
							</span>
						)}
					</div>
					<div
						className={styles.segmented}
						role="group"
						aria-label="Open or closed"
					>
						{[
							{ value: "", label: "Open" },
							{ value: "include", label: "All" },
							{ value: "only", label: "Closed" },
						].map((option) => (
							<button
								key={option.value}
								type="button"
								className={styles.segment}
								aria-pressed={filters.closed === option.value}
								onClick={() => set({ closed: option.value })}
							>
								{option.label}
							</button>
						))}
					</div>
					{JSON.stringify(filters) !== JSON.stringify(noFilters) && (
						<button
							type="button"
							className={styles.link}
							onClick={() => setFilters(noFilters)}
						>
							Clear filters
						</button>
					)}
					<div className={styles.toolbarEnd}>
						{tab === "board" && (
							<span className={styles.menu}>
								<Select
									value={lanes}
									ariaLabel="Group the board"
									onChange={setLanes}
									options={[
										{ value: "", label: "No grouping" },
										...(config.domains.length > 0
											? [
													{
														value: "domain",
														label: "Group by domain",
													},
												]
											: []),
										{
											value: "assignee",
											label: "Group by assignee",
										},
										{
											value: "priority",
											label: "Group by priority",
										},
										{
											value: "release",
											label: "Group by release",
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
						<WorkViews<ViewState>
							me={data.me}
							current={{ filters, tab, lanes }}
							activeViewId={activeView}
							onApply={applyView}
						/>
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
					onMove={(key, to, lane) => void move(key, to, lane)}
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
	draggable,
	onOpen,
}: {
	item: WorkSummary;
	config: WorkConfig;
	draggable: boolean;
	onOpen: (key: string) => void;
}) {
	return (
		<button
			type="button"
			className={`${styles.card} ${item.blocked ? styles.cardBlocked : ""}`}
			draggable={draggable}
			onDragStart={(e) =>
				e.dataTransfer.setData("text/work-key", item.key)
			}
			onClick={() => onOpen(item.key)}
		>
			<span className={styles.cardTop}>
				<span className={styles.key}>{item.key}</span>
				{item.priority && (
					<span
						className={`${styles.priority} ${styles[`priority_${item.priority}`] ?? ""}`}
					>
						{labelOf(config.priorities, item.priority)}
					</span>
				)}
				{item.visibility === "restricted" && (
					<span className={styles.badge}>Sensitive</span>
				)}
			</span>
			<span className={styles.cardTitle}>{item.title}</span>
			{item.blocked && (
				<span
					className={styles.blocked}
					title={item.blockedReason ?? undefined}
				>
					Blocked{item.blockedReason ? `: ${item.blockedReason}` : ""}
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
	onMove: (key: string, to: string, lane: string | null) => void;
	onOpen: (key: string) => void;
	onAdd: ((status: string, releaseId: string) => void) | null;
	onEditRelease: (release: Release) => void;
	onShipRelease: (release: Release) => void;
}) {
	const columns = config.columns.filter((column) => !column.hidden);
	const open = items.filter((item) => !item.closedAs);
	const rows = lanesFor(open, lanes, config, releases);
	const [over, setOver] = useState<string | null>(null);
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
									onDragOver={(e) => {
										if (!canMove) return;
										e.preventDefault();
										setOver(target);
									}}
									onDragLeave={() => setOver(null)}
									onDrop={(e) => {
										e.preventDefault();
										setOver(null);
										const key =
											e.dataTransfer.getData(
												"text/work-key",
											);
										if (key)
											onMove(
												key,
												column.id,
												lanes === "release"
													? lane.id
													: null,
											);
									}}
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
									<div className={styles.cards}>
										{here.map((item) => (
											<Card
												key={item.id}
												item={item}
												config={config}
												draggable={canMove}
												onOpen={onOpen}
											/>
										))}
									</div>
								</div>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
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
			{items.length === 0 && (
				<p className={styles.empty}>No requests match.</p>
			)}
		</div>
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
	if (groups.length === 0)
		return <p className={styles.empty}>No requests match.</p>;
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
