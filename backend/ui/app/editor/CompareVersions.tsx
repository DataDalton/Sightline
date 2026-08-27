"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type {
	Box,
	FieldRow,
	PageDiff,
	VersionDiff,
	VisualDiff,
	VisualSide,
} from "../../lib/platform/versionDetail";
import { isPageControl } from "../../lib/visuals/catalog";
import { gridGap, rowHeight } from "../../lib/visuals/layout";
import { openingFilters } from "../../lib/visuals/pageDefaults";
import { wordDiff, type Piece } from "../../lib/visuals/wordDiff";
import { Modal } from "../components/shared/Modal";
import { SkeletonText } from "../components/shared/Skeleton";
import { ReportGrid } from "../r/ReportGrid";
import { FilterBar } from "../visuals/FilterWidgets";
import { PageFilterProvider } from "../visuals/PageFilters";
import type { SourceMeta } from "../visuals/types";
import { VisualRenderer, type VisualConfig } from "../visuals/VisualRenderer";
import styles from "./CompareVersions.module.css";

// The report before, and the report after.
//
// The two pages are the comparison. Both go through ReportGrid, the component
// the published page uses, so what is on screen is the page rather than a
// drawing of it: the same overlap resolution, the same groups, the same frames,
// the same data. Reimplementing any of that produced a page that was nearly
// right, which is worse than one that is obviously wrong.
//
// Beside them, a margin down each side saying precisely what changed, lined up
// with the visual it is about. The page answers what moved and what arrived. It
// cannot answer what a paragraph now says, because at the size two pages fit
// side by side prose is a grey shape, so the margins carry the words and mark
// the ones that are new. Old values on the left of the older page, new values
// on the right of the newer one, so each margin belongs to the version it is
// standing next to.
//
// Clicking a visual, on either page or in either margin, opens that one at a
// size it can be read at, both versions, with the same marking. That is where
// somebody goes when the margin has told them a sentence changed and they want
// to see it in the panel it lives in.

// The width each page is laid out at before being scaled into its column.
const pageWidth = 1180;

interface VersionMeta {
	version: number;
	author: string | null;
	createdOn: string;
}

interface CompareVersionsProps {
	slug: string;
	reportId: string;
	sources: Record<string, SourceMeta>;
	// The right hand side. The left is the version before it unless another is
	// picked.
	version: number;
	versions: VersionMeta[];
	onClose: () => void;
}

function personFor(email: string | null): string {
	if (!email) return "Someone";
	const local = email.split("@")[0] ?? email;
	return local
		.replace(/[._-]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function when(iso: string | undefined): string {
	if (!iso) return "";
	const then = new Date(iso);
	return Number.isFinite(then.getTime()) ? then.toLocaleString() : "";
}

function sameBox(a: Box | undefined, b: Box | undefined): boolean {
	if (!a || !b) return false;
	return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function movedOnly(entry: VisualDiff): boolean {
	return (
		entry.status === "changed" &&
		!entry.fields.some((row) => row.changed && !isPlacement(row)) &&
		!sameBox(entry.before?.layout, entry.after?.layout)
	);
}

// Where a visual sits is said by the two pages, so the margin does not repeat
// it in words.
function isPlacement(row: FieldRow): boolean {
	return row.label === "Position" || row.label === "Size";
}

function differs(entry: VisualDiff): boolean {
	if (entry.status === "unchanged") return false;
	if (entry.status === "changed") {
		return (
			entry.fields.some((row) => row.changed) ||
			!sameBox(entry.before?.layout, entry.after?.layout)
		);
	}
	return true;
}

function toStored(side: VisualSide) {
	return {
		visualId: side.visualId,
		visualType: side.visualType,
		title: side.title,
		sourceKey: side.sourceKey,
		config: side.config as VisualConfig,
		layout: side.layout,
	};
}

function toSpec(side: VisualSide) {
	return {
		visualId: side.visualId,
		visualType: side.visualType,
		title: side.title,
		sourceKey: side.sourceKey,
		config: side.config as VisualConfig,
	};
}

// A value with the words that are not in the other version picked out. Renders
// as the text, so a note still reads as the note it is.
function Marks({ pieces }: { pieces: Piece[] }) {
	return (
		<>
			{pieces.map((piece, i) => (
				<span
					key={i}
					className={
						piece.state === "gone"
							? styles.gone
							: piece.state === "new"
								? styles.fresh
								: undefined
					}
				>
					{piece.text}
				</span>
			))}
		</>
	);
}

// One changed property, on one side. Prose is compared word by word; a setting
// is a value, and marking the letters inside "valueDesc" would say nothing.
function Change({ row, side }: { row: FieldRow; side: "before" | "after" }) {
	const value = side === "before" ? row.before : row.after;

	const body = row.prose ? (
		<Marks
			pieces={
				side === "before"
					? wordDiff(row.before, row.after).before
					: wordDiff(row.before, row.after).after
			}
		/>
	) : value === "" ? (
		<span className={styles.nothing}>nothing</span>
	) : (
		<span className={side === "before" ? styles.gone : styles.fresh}>
			{value}
		</span>
	);

	return (
		<div className={styles.change}>
			<span className={styles.changeLabel}>{row.label}</span>
			<span className={styles.changeValue}>{body}</span>
		</div>
	);
}

interface Note {
	visualId: string;
	name: string;
	top: number;
	entry: VisualDiff;
}

// The margin beside one page. Each note is held level with the visual it is
// about, measured from where the grid actually put it rather than from the
// rectangle it was given, because overlapping rectangles get resolved on the
// way in.
function Margin({
	notes,
	side,
	focusId,
	onOpen,
}: {
	notes: Note[];
	side: "before" | "after";
	focusId: string | null;
	onOpen: (visualId: string) => void;
}) {
	return (
		<div className={styles.margin}>
			{notes.map((note, i) => {
				const rows = note.entry.fields.filter(
					(row) => row.changed && !isPlacement(row),
				);
				const gone = note.entry.status === "removed";
				const added = note.entry.status === "added";

				return (
					<button
						key={note.visualId}
						type="button"
						className={`${styles.note} ${
							focusId === note.visualId ? styles.noteOpen : ""
						} ${gone ? styles.noteGone : added ? styles.noteAdded : ""}`}
						style={{
							marginTop: i === 0 ? Math.max(0, note.top) : 0,
							// Reaches down to where the next note begins, so
							// the one after it starts level with its own visual
							// rather than wherever this one happened to end.
							minHeight:
								i < notes.length - 1
									? Math.max(
											0,
											notes[i + 1].top - note.top - 8,
										)
									: undefined,
						}}
						onClick={() => onOpen(note.visualId)}
					>
						<span className={styles.noteName}>{note.name}</span>

						{added && (
							<span className={styles.noteWord}>
								Added to the page
							</span>
						)}
						{gone && (
							<span className={styles.noteWord}>
								Taken off the page
							</span>
						)}
						{!added && !gone && movedOnly(note.entry) && (
							<span className={styles.noteWord}>
								Moved or resized
							</span>
						)}

						{!added &&
							!gone &&
							rows.map((row) => (
								<Change key={row.label} row={row} side={side} />
							))}
					</button>
				);
			})}
		</div>
	);
}

// One version of the page.
//
// Laid out at pageWidth inside a box that is then scaled, so the arrangement is
// the one a reader gets. The frame carries the scaled height, because a
// transform leaves the original box behind in the flow.
function PageCopy({
	entries,
	side,
	sources,
	reportId,
	pageId,
	caption,
	byline,
	pageTitle,
	absent,
	focusId,
	onOpen,
	onTops,
}: {
	entries: VisualDiff[];
	side: "before" | "after";
	sources: Record<string, SourceMeta>;
	reportId: string;
	pageId: string;
	caption: string;
	byline: string;
	// Null where the report has one page, so its name is not worth repeating.
	pageTitle: string | null;
	// The page is not in this version at all, which is different from a page
	// that is there with nothing on it.
	absent: boolean;
	focusId: string | null;
	onOpen: (visualId: string) => void;
	onTops: (tops: Record<string, number>) => void;
}) {
	const frameRef = useRef<HTMLDivElement | null>(null);
	const pageRef = useRef<HTMLDivElement | null>(null);
	const [scale, setScale] = useState(0.45);
	const [height, setHeight] = useState(0);

	const here = useMemo(
		() =>
			entries
				.map((entry) => ({ entry, spec: entry[side] }))
				.filter(
					(pair): pair is { entry: VisualDiff; spec: VisualSide } =>
						pair.spec !== null,
				),
		[entries, side],
	);

	const controls = useMemo(
		() => here.filter((pair) => isPageControl(pair.spec.visualType)),
		[here],
	);
	const visuals = useMemo(
		() =>
			here
				.filter((pair) => !isPageControl(pair.spec.visualType))
				.map((pair) => toStored(pair.spec)),
		[here],
	);

	const highlight = useMemo(() => {
		const marks: Record<string, "changed" | "removed"> = {};
		for (const pair of here) {
			if (!differs(pair.entry)) continue;
			marks[pair.entry.visualId] =
				pair.entry.status === "removed" ? "removed" : "changed";
		}
		return marks;
	}, [here]);

	// The page's widgets start where the published page starts them, so the
	// visuals read the same filters a reader's first paint reads.
	const opening = useMemo(
		() =>
			openingFilters(
				here.map((pair) => ({
					visualId: pair.spec.visualId,
					visualType: pair.spec.visualType,
					config: pair.spec.config as {
						dimensions?: string[];
						measures?: string[];
						options?: Record<string, unknown>;
					},
				})),
				new Date(),
			),
		[here],
	);

	// Measured after layout rather than worked out from the rectangles, since
	// how tall the page comes out and where each visual ends up are both
	// decided by the grid.
	useLayoutEffect(() => {
		const frame = frameRef.current;
		const page = pageRef.current;
		if (!frame || !page) return;

		let last = "";
		const measure = () => {
			setScale(Math.min(1, frame.clientWidth / pageWidth));
			setHeight(page.scrollHeight);

			const origin = frame.getBoundingClientRect().top;
			const tops: Record<string, number> = {};
			for (const node of page.querySelectorAll("[data-visual-id]")) {
				const id = node.getAttribute("data-visual-id");
				if (!id) continue;
				tops[id] = node.getBoundingClientRect().top - origin;
			}

			// Only handed up when it says something new, or the parent's state
			// change would bring us straight back in here.
			const serialised = JSON.stringify(tops);
			if (serialised === last) return;
			last = serialised;
			onTops(tops);
		};
		measure();

		const observer = new ResizeObserver(measure);
		observer.observe(frame);
		observer.observe(page);
		return () => observer.disconnect();
	}, [visuals, onTops]);

	return (
		<div className={styles.copy}>
			<div className={styles.caption}>
				<span className={styles.captionSide}>{caption}</span>
				{pageTitle !== null && (
					<span className={styles.captionPage}>{pageTitle}</span>
				)}
				{byline !== "" && (
					<span className={styles.captionByline}>{byline}</span>
				)}
			</div>

			<div
				className={`${styles.frame} ${absent ? styles.frameAbsent : ""}`}
				ref={frameRef}
				style={{ height: absent ? undefined : height * scale }}
			>
				{absent ? (
					<p className={styles.blank}>
						{side === "before"
							? "This page did not exist yet"
							: "This page was deleted"}
					</p>
				) : (
					<PageFilterProvider opening={opening}>
						<div
							className={styles.page}
							ref={pageRef}
							style={{
								width: pageWidth,
								transform: `scale(${scale})`,
							}}
						>
							{controls.length > 0 && (
								<div className={styles.strip}>
									<FilterBar>
										{controls.map((pair) => (
											<div
												key={pair.entry.visualId}
												data-visual-id={
													pair.entry.visualId
												}
												className={
													!differs(pair.entry)
														? undefined
														: pair.entry.status ===
															  "removed"
															? styles.controlGone
															: styles.controlChanged
												}
											>
												<VisualRenderer
													visual={toSpec(pair.spec)}
													sources={sources}
												/>
											</div>
										))}
									</FilterBar>
								</div>
							)}

							{visuals.length > 0 ? (
								<ReportGrid
									visuals={visuals}
									sources={sources}
									reportId={reportId}
									pageId={pageId}
									still
									highlight={highlight}
									opened={focusId}
									onOpen={onOpen}
								/>
							) : (
								<p className={styles.blank}>
									Nothing on this page
								</p>
							)}
						</div>
					</PageFilterProvider>
				)}
			</div>
		</div>
	);
}

// One visual on its own, both versions, at a size its text can be read at.
//
// Where somebody arrives once the margin has told them a sentence changed. The
// same two copies as the page, of one thing instead of everything.
function Opened({
	entry,
	sources,
	reportId,
	pageId,
	leftName,
	rightName,
	onBack,
}: {
	entry: VisualDiff;
	sources: Record<string, SourceMeta>;
	reportId: string;
	pageId: string;
	leftName: string;
	rightName: string;
	onBack: () => void;
}) {
	const named = entry.after ?? entry.before;
	const rows = entry.fields.filter((row) => row.changed && !isPlacement(row));

	const copy = (spec: VisualSide | null, side: "before" | "after") => {
		if (!spec) {
			return (
				<div className={`${styles.openFrame} ${styles.frameAbsent}`}>
					<p className={styles.blank}>
						{side === "before"
							? "Not on the page yet"
							: "Taken off the page"}
					</p>
				</div>
			);
		}
		const tall = spec.layout.h * rowHeight + (spec.layout.h - 1) * gridGap;
		return (
			<div className={styles.openFrame} style={{ height: tall }}>
				<PageFilterProvider>
					<div className={styles.openBody}>
						<VisualRenderer
							visual={toSpec(spec)}
							sources={sources}
							reportId={reportId}
							pageId={pageId}
							frameHeight={tall}
						/>
					</div>
				</PageFilterProvider>
			</div>
		);
	};

	return (
		<div className={styles.opened}>
			<div className={styles.openHead}>
				<button type="button" className={styles.back} onClick={onBack}>
					Back to the page
				</button>
				<span className={styles.openName}>{named?.name}</span>
				<span className={styles.openType}>{named?.type}</span>
			</div>

			<div className={styles.openCopies}>
				<div className={styles.openSide}>
					<span className={styles.captionSide}>{leftName}</span>
					{copy(entry.before, "before")}
					<div className={styles.openChanges}>
						{rows.map((row) => (
							<Change key={row.label} row={row} side="before" />
						))}
					</div>
				</div>

				<div className={styles.openSide}>
					<span className={styles.captionSide}>{rightName}</span>
					{copy(entry.after, "after")}
					<div className={styles.openChanges}>
						{rows.map((row) => (
							<Change key={row.label} row={row} side="after" />
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

export function CompareVersions({
	slug,
	reportId,
	sources,
	version,
	versions,
	onClose,
}: CompareVersionsProps) {
	// Undefined asks for the version before this one, which is what the entry
	// in the list is already describing.
	const [against, setAgainst] = useState<number | undefined>(undefined);
	// Which page the two copies are showing. Null until the answer arrives, at
	// which point the first page something happened to is the one worth
	// opening on.
	const [openPage, setOpenPage] = useState<string | null>(null);
	// One visual, opened at a size it can be read at.
	const [focusId, setFocusId] = useState<string | null>(null);

	const [topsBefore, setTopsBefore] = useState<Record<string, number>>({});
	const [topsAfter, setTopsAfter] = useState<Record<string, number>>({});

	const query = against === undefined ? "" : `?from=${against}`;
	const { data, error, isLoading } = useSWR<VersionDiff>(
		`/api/report/${encodeURIComponent(slug)}/history/${version}${query}`,
	);

	// The shared fetcher throws on a failed response and hangs the parsed body
	// off the error, so the reason the server gave is what gets shown.
	const failure = error
		? ((error as { info?: { error?: string } }).info?.error ??
			"Could not read those versions")
		: null;

	const metaFor = (wanted: number | null | undefined) =>
		wanted === null || wanted === undefined
			? undefined
			: versions.find((entry) => entry.version === wanted);

	const byline = (meta: VersionMeta | undefined) =>
		meta ? `${personFor(meta.author)}, ${when(meta.createdOn)}` : "";

	const leftMeta = metaFor(data?.from);
	const rightMeta = metaFor(data?.to ?? version);
	const leftName =
		data?.from === null || data?.from === undefined
			? "Before"
			: `Before, version ${data.from}`;
	const rightName = `After, version ${data?.to ?? version}`;

	const pages = data?.pages ?? [];
	const changedPage = (page: PageDiff) =>
		page.touched > 0 || page.status !== "unchanged";

	// One page is drawn at a time. Every page of both versions at once is a
	// panel nobody can find anything in, and two full pages of live visuals for
	// each of them is a lot of asking for answers nobody is reading.
	const active =
		pages.find((page) => page.pageId === openPage) ??
		pages.find(changedPage) ??
		pages[0];

	const entries = useMemo(
		() =>
			(data?.visuals ?? []).filter(
				(entry) =>
					(entry.after?.pageId ?? entry.before?.pageId) ===
					active?.pageId,
			),
		[data, active],
	);

	const focused = entries.find((entry) => entry.visualId === focusId);

	// A note for every visual that is not the same on both sides, held level
	// with where that page put it.
	const notesFor = (
		side: "before" | "after",
		tops: Record<string, number>,
	): Note[] =>
		entries
			.filter((entry) => differs(entry) && entry[side] !== null)
			.map((entry) => ({
				visualId: entry.visualId,
				name: entry[side]?.name ?? "",
				top: tops[entry.visualId] ?? 0,
				entry,
			}))
			.sort((a, b) => a.top - b.top);

	const open = (visualId: string) => setFocusId(visualId);

	return (
		<Modal
			isOpen
			onClose={onClose}
			title="Compare versions"
			width="min(1600px, 97vw)"
		>
			<div className={styles.body}>
				<label className={styles.pick}>
					<span className={styles.pickLabel}>Compare against</span>
					<select
						className={styles.select}
						value={against ?? ""}
						onChange={(event) => {
							setOpenPage(null);
							setFocusId(null);
							setAgainst(
								event.target.value === ""
									? undefined
									: Number(event.target.value),
							);
						}}
					>
						<option value="">The version before</option>
						{versions
							.filter((entry) => entry.version !== version)
							.map((entry) => (
								<option
									key={entry.version}
									value={entry.version}
								>
									Version {entry.version}
									{entry.author
										? `, ${personFor(entry.author)}`
										: ""}
								</option>
							))}
					</select>
				</label>

				{isLoading && <SkeletonText lines={8} />}

				{failure && <div className={styles.failure}>{failure}</div>}

				{data && !failure && active && (
					<>
						{/* The report's pages, as the report has them. A page
						    one version does not have is the one change two
						    copies of a page cannot show, so it shows here. */}
						{pages.length > 1 && (
							<div className={styles.tabs} role="tablist">
								{pages.map((page) => (
									<button
										key={page.pageId}
										type="button"
										role="tab"
										aria-selected={
											page.pageId === active.pageId
										}
										className={`${styles.tab} ${
											page.pageId === active.pageId
												? styles.tabOpen
												: ""
										} ${
											page.status === "added"
												? styles.tabAdded
												: page.status === "removed"
													? styles.tabGone
													: ""
										}`}
										onClick={() => {
											setOpenPage(page.pageId);
											setFocusId(null);
										}}
										title={
											page.status === "added"
												? "Added in this version"
												: page.status === "removed"
													? "Deleted in this version"
													: undefined
										}
									>
										{page.title || "Untitled page"}
										{changedPage(page) &&
											page.status !== "added" &&
											page.status !== "removed" && (
												<span
													className={styles.tabDot}
													aria-hidden="true"
												/>
											)}
									</button>
								))}
							</div>
						)}

						{focused ? (
							<Opened
								entry={focused}
								sources={sources}
								reportId={reportId}
								pageId={active.pageId}
								leftName={leftName}
								rightName={rightName}
								onBack={() => setFocusId(null)}
							/>
						) : (
							<div className={styles.spread}>
								<Margin
									notes={notesFor("before", topsBefore)}
									side="before"
									focusId={focusId}
									onOpen={open}
								/>

								<PageCopy
									entries={entries}
									side="before"
									sources={sources}
									reportId={reportId}
									pageId={active.pageId}
									caption={leftName}
									byline={byline(leftMeta)}
									pageTitle={
										pages.length > 1
											? active.titleBefore
											: null
									}
									absent={active.status === "added"}
									focusId={focusId}
									onOpen={open}
									onTops={setTopsBefore}
								/>

								<PageCopy
									entries={entries}
									side="after"
									sources={sources}
									reportId={reportId}
									pageId={active.pageId}
									caption={rightName}
									byline={byline(rightMeta)}
									pageTitle={
										pages.length > 1
											? active.titleAfter
											: null
									}
									absent={active.status === "removed"}
									focusId={focusId}
									onOpen={open}
									onTops={setTopsAfter}
								/>

								<Margin
									notes={notesFor("after", topsAfter)}
									side="after"
									focusId={focusId}
									onOpen={open}
								/>
							</div>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}
