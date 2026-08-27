"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fillsHeight, optionValue } from "../../lib/visuals/catalog";
import {
	fillToViewport,
	gridGap,
	heightForRows,
	measureCanvas,
	rectToPixels,
	resolveVerticalOverlaps,
	rowHeight,
	stackForNarrow,
	type CanvasMetrics,
	type Rect,
} from "../../lib/visuals/layout";
import { GroupFrame } from "../visuals/GroupFrame";
import { VisualRenderer, type VisualSpec } from "../visuals/VisualRenderer";
import { usePageFilters } from "../visuals/PageFilters";
import type { SourceMeta } from "../visuals/types";
import { useDragResize } from "../editor/useDragResize";
import { useViewScale } from "./ViewScale";
import styles from "./ReportView.module.css";

// The published page, laid out from the arrangement an author made.
//
// This is the same twelve column grid the editor works on, measured the same
// way, so what someone arranges is what everybody else opens. The reader used
// to get a flow layout instead, grouping visuals by type, which meant the
// canvas was a drawing of a page nobody would ever see.
//
// Two things are allowed to differ from the canvas, and only two:
//
//   A narrow screen collapses to one column, in reading order. A twelve column
//   arrangement on a phone is unreadable whatever the author intended.
//
//   A visual a reader has resized takes its own size, and whatever sat under it
//   moves down. That is the reader's own copy of the page and affects nobody
//   else.
//
// Resizing uses the same gesture machinery as the editor, so a reader dragging
// a corner gets the behaviour an author gets rather than a second, weaker
// version of it. What a reader cannot do is move a visual: position is the
// author's arrangement and the reading order of the page depends on it.

interface StoredVisual extends VisualSpec {
	layout?: Rect;
}

interface ReportGridProps {
	visuals: StoredVisual[];
	sources: Record<string, SourceMeta>;
	reportId: string;
	pageId?: string | null;
	columnOrder?: string[];
	pinnedColumns?: string[];
	onColumnLayout?: (next: {
		columnOrder: string[];
		pinnedColumns: string[];
	}) => void;
}

// Below this a twelve column grid stops being readable and the page stacks.
const stackBelow = 900;

export function ReportGrid({
	visuals,
	sources,
	reportId,
	pageId,
	columnOrder,
	pinnedColumns,
	onColumnLayout,
}: ReportGridProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(1200);
	// How much screen is left below the top of the grid, so the last visual can
	// use it instead of leaving it blank.
	const [available, setAvailable] = useState(0);
	const { sizeFor, setSize, resetSize } = useViewScale();
	const [selected, setSelected] = useState<string | null>(null);

	// Anywhere outside the grid clears it too. Without this a reader who
	// resized something was stuck with it selected: the gaps between visuals
	// are thin, and the rest of the page never got the press.
	useEffect(() => {
		if (!selected) return;
		const onDown = (e: PointerEvent) => {
			const container = containerRef.current;
			if (container && !container.contains(e.target as Node)) {
				setSelected(null);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setSelected(null);
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [selected]);

	useLayoutEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		const measure = () => {
			setWidth(Math.max(320, element.clientWidth));
			const top = element.getBoundingClientRect().top;
			// A little room at the foot, so the page does not end flush
			// against the edge of the window.
			setAvailable(Math.max(0, window.innerHeight - top - 24));
		};
		measure();

		const observer = new ResizeObserver(measure);
		observer.observe(element);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, []);

	const narrow = width < stackBelow;
	const metrics = measureCanvas(width);

	// A visual inside a group is laid out by the group, not by the page. Split
	// before anything else runs, so the page's own arrangement never sees a
	// child rectangle: those are measured from their group's content box and
	// would otherwise be read as page coordinates.
	//
	// A parent that is missing, or that is not a group, leaves its children at
	// the top level rather than dropping them. A visual nobody can see is worse
	// than one in the wrong place.
	const { topLevel, childrenOf } = useMemo(() => {
		const byId = new Map(visuals.map((v) => [v.visualId, v]));
		const held = new Map<string, StoredVisual[]>();
		const top: StoredVisual[] = [];

		for (const visual of visuals) {
			const parent = visual.config.parentId;
			const container = parent ? byId.get(parent) : undefined;
			if (!parent || container?.visualType !== "group") {
				top.push(visual);
				continue;
			}
			const list = held.get(parent) ?? [];
			list.push(visual);
			held.set(parent, list);
		}
		return { topLevel: top, childrenOf: held };
	}, [visuals]);

	// The reader's gestures, committed to their own overlay rather than to the
	// report. Only the size is kept: a reader dragging a corner is saying how
	// much room they want, not rearranging the page for everyone.
	const { state, begin, move, end, cancel } = useDragResize({
		metrics,
		zoom: 1,
		onCommit: (id, rect) => setSize(id, { w: rect.w, h: rect.h }),
	});

	const placed = useMemo(() => {
		// A visual authored before the canvas existed has no stored position,
		// so one is derived from reading order rather than piling everything
		// at the origin.
		let fallbackY = 0;
		const items = topLevel.map((visual) => {
			const stored = visual.layout;
			const rect: Rect = stored ?? {
				x: 0,
				y: (fallbackY += 6) - 6,
				w: 12,
				h: 6,
			};

			// A size the reader dragged to is in the same columns and rows the
			// author arranged in, so it takes part in the same layout.
			const override = sizeFor(visual.visualId);
			const live = state?.id === visual.visualId ? state.rect : null;

			const sized: Rect = live
				? // Mid-gesture the live rectangle wins, so the box follows the
					// pointer. Position stays the author's.
					{ ...rect, w: live.w, h: live.h }
				: override
					? {
							...rect,
							w: override.w ?? rect.w,
							h: override.h ?? rect.h,
						}
					: rect;

			return {
				id: visual.visualId,
				visual,
				rect: sized,
				// A reader who set a size has said what they want, so the fill
				// does not then override them.
				canFill:
					!override &&
					!live &&
					fillsHeight(visual.visualType, visual.config.options),
			};
		});

		// Stacked on a narrow screen the page scrolls anyway, so filling the
		// screen with the last visual would only push everything else off it.
		if (narrow) return stackForNarrow(items.map((i) => ({ ...i })));
		return fillToViewport(resolveVerticalOverlaps(items), available);
	}, [topLevel, narrow, sizeFor, available, state]);

	const byId = useMemo(
		() => new Map(visuals.map((v) => [v.visualId, v])),
		[visuals],
	);

	// What a group holds, drawn into the box the group hands over. Recursive,
	// because a group is a visual and so a group can hold one.
	const renderHeld = (
		groupId: string,
		inner: CanvasMetrics,
	): React.ReactNode => {
		const held = childrenOf.get(groupId) ?? [];
		return held.map((child) => {
			const rect = child.layout ?? { x: 0, y: 0, w: 12, h: 4 };
			const box = rectToPixels(rect, inner);
			return (
				<div
					key={child.visualId}
					className={styles.heldItem}
					style={{
						left: box.left,
						top: box.top,
						width: box.width,
						height: box.height,
					}}
				>
					{child.visualType === "group" ? (
						<GroupBox
							visual={child}
							width={box.width}
							height={box.height}
							held={childrenOf.get(child.visualId) ?? []}
							renderHeld={renderHeld}
						/>
					) : (
						<VisualRenderer
							visual={child}
							sources={sources}
							reportId={reportId}
							pageId={pageId}
							frameHeight={box.height}
							columnOrder={columnOrder}
							pinnedColumns={pinnedColumns}
							onColumnLayout={onColumnLayout}
						/>
					)}
				</div>
			);
		});
	};

	const rows = placed.reduce(
		(max, i) => Math.max(max, i.rect.y + i.rect.h),
		0,
	);

	return (
		<div
			className={styles.grid}
			ref={containerRef}
			style={{ height: rows * (rowHeight + gridGap) }}
			// A press on the gaps between visuals clears the selection, which
			// is how a reader stops showing the grips without having to find
			// something else to click.
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) setSelected(null);
			}}
		>
			{placed.map((item) => {
				const visual = byId.get(item.id);
				if (!visual) return null;
				const pixels = rectToPixels(item.rect, metrics);

				const isSelected = selected === item.id;
				const resized = Boolean(sizeFor(item.id));

				return (
					<div
						key={item.id}
						className={`${styles.gridItem} ${
							isSelected ? styles.gridItemSelected : ""
						} ${state?.id === item.id ? styles.gridItemResizing : ""}`}
						style={{
							left: pixels.left,
							top: pixels.top,
							width: pixels.width,
							height: pixels.height,
						}}
						onPointerDown={() => setSelected(item.id)}
					>
						<div className={styles.gridBody}>
							{visual.visualType === "group" ? (
								<GroupBox
									visual={visual}
									width={pixels.width}
									height={pixels.height}
									held={childrenOf.get(visual.visualId) ?? []}
									renderHeld={renderHeld}
								/>
							) : (
								<VisualRenderer
									visual={visual}
									sources={sources}
									reportId={reportId}
									pageId={pageId}
									frameHeight={heightForRows(item.rect.h)}
									columnOrder={columnOrder}
									pinnedColumns={pinnedColumns}
									onColumnLayout={onColumnLayout}
								/>
							)}
						</div>

						{/* Stacked layouts are one column wide and scroll, so
						    resizing them means nothing. */}
						{!narrow && (
							<>
								{(
									[
										"resize-e",
										"resize-s",
										"resize-se",
									] as const
								).map((kind) => (
									<div
										key={kind}
										className={`${styles.readerGrip} ${
											styles[
												kind === "resize-e"
													? "readerGripE"
													: kind === "resize-s"
														? "readerGripS"
														: "readerGripSE"
											]
										}`}
										onPointerDown={(e) => {
											e.stopPropagation();
											setSelected(item.id);
											begin(e, kind, item.id, item.rect);
										}}
										onPointerMove={move}
										onPointerUp={end}
										onPointerCancel={cancel}
										role="separator"
										aria-label="Resize"
									/>
								))}

								{resized && isSelected && (
									<button
										type="button"
										className={styles.resetSize}
										onClick={() => resetSize(item.id)}
										title="Put this back to the size the report defines"
									>
										Reset size
									</button>
								)}
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}

// One group on the published page.
//
// Reads its own settings from the catalogue rather than from the config
// directly, so the default a reader gets is the same one the control in the
// editor shows.
function GroupBox({
	visual,
	width,
	height,
	held,
	renderHeld,
}: {
	visual: StoredVisual;
	width: number;
	height: number;
	// What it holds, so a shut group can still say how much of it is doing
	// something. Hiding a control hides the fact that it is set, and a reader
	// looking at a narrowed page with no visible reason concludes the data is
	// wrong rather than that somebody left a filter on.
	held: StoredVisual[];
	renderHeld: (groupId: string, inner: CanvasMetrics) => React.ReactNode;
}) {
	const { byWidget } = usePageFilters();
	const activeCount = held.filter(
		(child) => (byWidget[child.visualId]?.length ?? 0) > 0,
	).length;

	const presentation =
		optionValue<string>(
			visual.visualType,
			visual.config,
			"presentation",
		) === "popup"
			? "popup"
			: "frame";

	return (
		<GroupFrame
			title={visual.title}
			presentation={presentation}
			openLabel={
				optionValue<string>(
					visual.visualType,
					visual.config,
					"openLabel",
				) ?? null
			}
			showBorder={visual.config.options?.frame !== false}
			width={width}
			height={height}
			activeCount={activeCount}
			renderChildren={(inner) => renderHeld(visual.visualId, inner)}
		/>
	);
}
