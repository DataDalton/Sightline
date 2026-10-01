"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
	defaultSizes,
	minSizes,
	type BoardDefinition,
	type BoardItem,
	type BoardLink,
	type ItemStyle,
	type NoteColor,
	type ShapeKind,
} from "../../lib/boards/definition";
import {
	snapMove,
	snapResize,
	type Guide,
	type Rect,
	type SnapOptions,
} from "../../lib/boards/geometry";
import { usePageTitle } from "../hooks/usePageTitle";
import { ShareDialog } from "../sheets/ShareDialog";
import { VisualRenderer } from "../visuals/VisualRenderer";
import type { SourceMeta } from "../visuals/types";
import { ArrowLayer } from "./ArrowLayer";
import { ItemFormat, LinkFormat } from "./FormatPanel";
import {
	dashOf,
	fillOf,
	strokeOf,
	styleOf,
	textOf,
	textPixels,
} from "./palette";
import { useBoard } from "./useBoard";
import { gridSizes, useSnapSettings, type GridSize } from "./useSnapSettings";
import styles from "./Boards.module.css";

// A board, an open canvas of live visuals, shapes, notes and text, with
// arrows from one item to another.
//
// The canvas pans by dragging its background or scrolling, and zooms with the
// buttons or ctrl and scroll. A shape, note or text item moves by dragging it
// anywhere, and a visual by its top bar, since the chart inside answers clicks
// of its own. Everything resizes from its corner. Moving snaps to a grid and
// lines up with the edges and centres of other items, as the snapping menu
// sets, with Shift keeping a move to one direction or a resize to its shape,
// and Alt moving freely. Double clicking a shape, note or text item writes in
// it and opens its formatting, and double clicking an arrow opens its own.
//
// Each visual is read by whoever opens the board, under their own access, so
// a visual on a dataset they cannot read says so and shows nothing of it.

type View = { x: number; y: number; z: number };
type Selection = { kind: "item" | "link"; id: string } | null;

const minZoom = 0.2;
const maxZoom = 2;
// The bar a visual is moved by.
const handleHeight = 26;
// How near, on screen, an edge has to come to another to line up with it.
const alignWithin = 6;

// How long typing in one item may pause and still be one step to undo.
const joinWithin = 1200;
// Steps kept for undo. Older ones are let go, which only limits how far back
// undo reaches in one sitting.
const historyDepth = 200;

const clampZoom = (z: number) => Math.min(maxZoom, Math.max(minZoom, z));

// Whether something under the pointer would scroll itself in this direction,
// such as a table's rows, in which case a wheel scrolls it, not the board.
function scrollsItself(start: EventTarget | null, stop: Element, dy: number) {
	let el = start instanceof Element ? start : null;
	while (el && el !== stop) {
		const style = getComputedStyle(el);
		if (
			/(auto|scroll)/.test(style.overflowY) &&
			el.scrollHeight > el.clientHeight &&
			((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight) ||
				(dy < 0 && el.scrollTop > 0))
		)
			return true;
		el = el.parentElement;
	}
	return false;
}

// Text selection is held off for the length of a drag, and anything already
// half selected is cleared, so moving the board or an item never highlights
// the labels it passes over. Typing and selecting inside an item being
// written in is not a drag and is untouched. Answers the function that lets
// selection back.
function holdSelection(): () => void {
	window.getSelection()?.removeAllRanges();
	const body = document.body.style;
	const before = body.userSelect;
	body.userSelect = "none";
	return () => {
		body.userSelect = before;
	};
}

function newId(): string {
	return `i${Math.random().toString(36).slice(2, 10)}`;
}

// The outline of a shape, drawn at the size of its box.
function ShapeArt({ item, w, h }: { item: BoardItem; w: number; h: number }) {
	const style = styleOf(item);
	const sw = style.strokeWidth;
	const inset = sw / 2;
	const paint: React.CSSProperties = {
		fill: fillOf(style.fill),
		stroke: sw === 0 ? "transparent" : strokeOf(style.stroke),
		strokeWidth: sw,
		strokeDasharray: dashOf(style.strokeStyle, sw),
		strokeLinecap: style.strokeStyle === "dotted" ? "round" : "butt",
	};
	const iw = Math.max(w - sw, 0);
	const ih = Math.max(h - sw, 0);
	const shape = item.shape ?? "rectangle";
	return (
		<svg
			className={styles.shapeArt}
			width={w}
			height={h}
			aria-hidden="true"
		>
			{shape === "ellipse" ? (
				<ellipse
					cx={w / 2}
					cy={h / 2}
					rx={iw / 2}
					ry={ih / 2}
					style={paint}
				/>
			) : shape === "diamond" ? (
				<polygon
					points={`${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`}
					style={paint}
				/>
			) : (
				<rect
					x={inset}
					y={inset}
					width={iw}
					height={ih}
					rx={shape === "rounded" ? Math.min(18, ih / 4) : 2}
					style={paint}
				/>
			)}
		</svg>
	);
}

// The words in a shape, note or text item, or the field they are written in.
function Words({
	item,
	editing,
	selected,
	onText,
	onDone,
}: {
	item: BoardItem;
	editing: boolean;
	// Whether the item is chosen, which is when an empty box offers to be
	// written in.
	selected: boolean;
	onText: (text: string) => void;
	onDone: () => void;
}) {
	const style = styleOf(item);
	const look: React.CSSProperties = {
		color: textOf(style.textColor),
		fontSize: textPixels[style.textSize],
		fontWeight: style.bold ? 650 : 400,
		fontStyle: style.italic ? "italic" : "normal",
		textAlign: style.align,
		justifyContent:
			style.valign === "middle"
				? "center"
				: style.valign === "bottom"
					? "flex-end"
					: "flex-start",
		// A shape's words keep clear of its outline, which is drawn inside its
		// box. A diamond or ellipse keeps further in, where its sides narrow.
		padding:
			item.kind === "shape"
				? item.shape === "diamond"
					? "18% 22%"
					: item.shape === "ellipse"
						? "12% 14%"
						: `${8 + style.strokeWidth}px ${12 + style.strokeWidth}px`
				: undefined,
	};
	// An empty box says nothing unless it is chosen, so a box drawn around a
	// group of items stays a plain outline.
	const placeholder =
		item.kind === "note"
			? "Write a note"
			: item.kind === "shape"
				? selected
					? "Add text"
					: ""
				: "Add text";
	if (editing) {
		return (
			<div className={styles.words} style={look}>
				<textarea
					className={styles.wordsEdit}
					style={{
						textAlign: style.align,
						fontStyle: look.fontStyle,
						fontWeight: look.fontWeight,
					}}
					value={item.text ?? ""}
					placeholder={placeholder || "Add text"}
					autoFocus
					onFocus={(e) => {
						const end = e.currentTarget.value.length;
						e.currentTarget.setSelectionRange(end, end);
					}}
					onChange={(e) => onText(e.target.value)}
					onBlur={onDone}
					onKeyDown={(e) => {
						if (e.key === "Escape") e.currentTarget.blur();
					}}
					aria-label="Text"
				/>
			</div>
		);
	}
	return (
		<div className={styles.words} style={look}>
			{item.text ? (
				<span className={styles.wordsText}>{item.text}</span>
			) : placeholder ? (
				<span className={styles.wordsPlaceholder}>{placeholder}</span>
			) : null}
		</div>
	);
}

export default function BoardView({ id }: { id: string }) {
	const board = useBoard(id);
	usePageTitle(board.title || "Board");
	const { data: sourceData } = useSWR<{ sources: SourceMeta[] }>(
		"/api/authoring",
	);
	const sources = useMemo(
		() =>
			Object.fromEntries(
				(sourceData?.sources ?? []).map((s) => [s.sourceKey, s]),
			) as Record<string, SourceMeta>,
		[sourceData],
	);

	const definition = board.definition;
	const editable = board.editable;
	const canvasRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<View>({ x: 40, y: 40, z: 1 });
	const [selected, setSelected] = useState<Selection>(null);
	const [tool, setTool] = useState<"select" | "arrow">("select");
	const [arrowFrom, setArrowFrom] = useState<string | null>(null);
	const [sharing, setSharing] = useState(false);
	// Where items being moved or resized are drawn until the gesture ends.
	const [live, setLive] = useState<Record<string, Rect>>({});
	const [panning, setPanning] = useState(false);
	const [guides, setGuides] = useState<Guide[]>([]);
	// The item being written in, and whether its formatting is open.
	const [editing, setEditing] = useState<string | null>(null);
	const [formatting, setFormatting] = useState(false);
	const [snap, setSnap] = useSnapSettings();
	const [snapOpen, setSnapOpen] = useState(false);

	const rectOf = useCallback(
		(item: BoardItem): Rect =>
			live[item.id] ?? { x: item.x, y: item.y, w: item.w, h: item.h },
		[live],
	);

	// Every change goes through here, so each can be undone. The board as it
	// was is kept before the change, and a change carrying the same key as the
	// one just before it, such as typing in one item or dragging one slider,
	// joins that step rather than making one per keystroke.
	const past = useRef<BoardDefinition[]>([]);
	const future = useRef<BoardDefinition[]>([]);
	const lastStep = useRef<{ key: string; at: number } | null>(null);
	const [, redraw] = useState(0);

	const update = useCallback(
		(change: (d: BoardDefinition) => BoardDefinition, joinKey?: string) => {
			if (!definition) return;
			const now = Date.now();
			const joins =
				joinKey !== undefined &&
				lastStep.current?.key === joinKey &&
				now - lastStep.current.at < joinWithin;
			if (!joins) {
				past.current.push(definition);
				if (past.current.length > historyDepth) past.current.shift();
			}
			future.current = [];
			lastStep.current =
				joinKey !== undefined ? { key: joinKey, at: now } : null;
			board.change(change(definition));
			redraw((n) => n + 1);
		},
		[board, definition],
	);

	const undo = useCallback(() => {
		const previous = past.current.pop();
		if (!previous || !definition) return;
		future.current.push(definition);
		lastStep.current = null;
		board.change(previous);
		setEditing(null);
		redraw((n) => n + 1);
	}, [board, definition]);

	const redo = useCallback(() => {
		const next = future.current.pop();
		if (!next || !definition) return;
		past.current.push(definition);
		lastStep.current = null;
		board.change(next);
		setEditing(null);
		redraw((n) => n + 1);
	}, [board, definition]);

	const changeItem = (
		itemId: string,
		patch: (i: BoardItem) => Partial<BoardItem>,
		joinKey?: string,
	) =>
		update(
			(d) => ({
				...d,
				items: d.items.map((i) =>
					i.id === itemId ? { ...i, ...patch(i) } : i,
				),
			}),
			joinKey,
		);

	const changeLink = (
		linkId: string,
		patch: Partial<BoardLink>,
		joinKey?: string,
	) =>
		update(
			(d) => ({
				...d,
				links: d.links.map((l) =>
					l.id === linkId ? { ...l, ...patch } : l,
				),
			}),
			joinKey,
		);

	// Everything in view, with a margin, at a zoom no larger than full size.
	const fit = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas || !definition) return;
		const cw = canvas.clientWidth;
		const ch = canvas.clientHeight;
		if (definition.items.length === 0) {
			setView({ x: cw / 2 - 200, y: ch / 2 - 120, z: 1 });
			return;
		}
		const minX = Math.min(...definition.items.map((i) => i.x));
		const minY = Math.min(...definition.items.map((i) => i.y));
		const maxX = Math.max(...definition.items.map((i) => i.x + i.w));
		const maxY = Math.max(...definition.items.map((i) => i.y + i.h));
		const pad = 48;
		const z = clampZoom(
			Math.min(
				1,
				(cw - pad * 2) / (maxX - minX),
				(ch - pad * 2) / (maxY - minY),
			),
		);
		setView({
			x: (cw - (maxX - minX) * z) / 2 - minX * z,
			y: Math.max(pad, (ch - (maxY - minY) * z) / 2) - minY * z,
			z,
		});
	}, [definition]);

	const fitted = useRef(false);
	useEffect(() => {
		if (fitted.current || !definition) return;
		fitted.current = true;
		fit();
	}, [definition, fit]);

	// Zooms keeping the centre still.
	const zoomTo = useCallback((z: number) => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const point = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
		setView((v) => {
			const next = clampZoom(z);
			return {
				z: next,
				x: point.x - ((point.x - v.x) * next) / v.z,
				y: point.y - ((point.y - v.y) * next) / v.z,
			};
		});
	}, []);

	// Scroll pans, ctrl or command with scroll zooms around the pointer.
	// Bound by hand because React's wheel handler cannot stop the page itself
	// scrolling.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const onWheel = (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				const box = canvas.getBoundingClientRect();
				setView((v) => {
					const next = clampZoom(v.z * Math.exp(-e.deltaY * 0.0015));
					const px = e.clientX - box.left;
					const py = e.clientY - box.top;
					return {
						z: next,
						x: px - ((px - v.x) * next) / v.z,
						y: py - ((py - v.y) * next) / v.z,
					};
				});
				return;
			}
			if (scrollsItself(e.target, canvas, e.deltaY)) return;
			e.preventDefault();
			setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
		};
		canvas.addEventListener("wheel", onWheel, { passive: false });
		return () => canvas.removeEventListener("wheel", onWheel);
	}, []);

	// Dragging the background pans, and a click on it lets go of everything.
	const onBackgroundDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		if (!(e.target as HTMLElement).hasAttribute("data-surface")) return;
		setSelected(null);
		setArrowFrom(null);
		setEditing(null);
		setFormatting(false);
		setSnapOpen(false);
		const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
		e.preventDefault();
		const target = e.currentTarget;
		target.setPointerCapture(e.pointerId);
		const release = holdSelection();
		setPanning(true);
		const move = (ev: PointerEvent) =>
			setView((v) => ({
				...v,
				x: start.vx + ev.clientX - start.x,
				y: start.vy + ev.clientY - start.y,
			}));
		const end = () => {
			release();
			setPanning(false);
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", end);
			target.removeEventListener("pointercancel", end);
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", end);
		target.addEventListener("pointercancel", end);
	};

	// In arrow mode, the first item chosen is where the arrow starts and the
	// second where it points.
	const chooseForArrow = (itemId: string) => {
		if (!editable) return;
		if (!arrowFrom) {
			setArrowFrom(itemId);
			return;
		}
		if (arrowFrom !== itemId) {
			const from = arrowFrom;
			const link: BoardLink = { id: newId(), from, to: itemId };
			update((d) =>
				d.links.some((l) => l.from === from && l.to === itemId)
					? d
					: { ...d, links: [...d.links, link] },
			);
			setSelected({ kind: "link", id: link.id });
		}
		setArrowFrom(null);
		setTool("select");
	};

	// How a drag lands, as the snapping menu sets it, or freely with Alt.
	const snapping = (free: boolean): SnapOptions =>
		free
			? { grid: null, guides: false, threshold: 0 }
			: {
					grid: snap.grid ? snap.gridSize : null,
					guides: snap.guides,
					threshold: alignWithin / view.z,
				};

	// Moving an item, or resizing it by its corner. Drawn live and saved once,
	// when the pointer lets go, so a drag is one step to undo.
	const startGesture =
		(item: BoardItem, mode: "move" | "resize") =>
		(e: React.PointerEvent<HTMLElement>) => {
			if (e.button !== 0) return;
			if ((e.target as HTMLElement).closest("a, button, textarea, input"))
				return;
			e.stopPropagation();
			if (tool === "arrow") {
				chooseForArrow(item.id);
				return;
			}
			setSelected({ kind: "item", id: item.id });
			// Choosing something that can be formatted opens its formatting.
			setFormatting(item.kind !== "visual");
			if (editing && editing !== item.id) setEditing(null);
			if (!editable || editing === item.id) return;
			e.preventDefault();
			const target = e.currentTarget;
			target.setPointerCapture(e.pointerId);
			const release = holdSelection();
			const start = { x: e.clientX, y: e.clientY };
			const from = { x: item.x, y: item.y, w: item.w, h: item.h };
			const others = (definition?.items ?? [])
				.filter((i) => i.id !== item.id)
				.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
			let last = from;
			const move = (ev: PointerEvent) => {
				let dx = (ev.clientX - start.x) / view.z;
				let dy = (ev.clientY - start.y) / view.z;
				const options = snapping(ev.altKey);
				if (mode === "move") {
					// Shift keeps the move to the direction it mostly went.
					const lockX = ev.shiftKey && Math.abs(dy) > Math.abs(dx);
					const lockY = ev.shiftKey && !lockX;
					if (lockX) dx = 0;
					if (lockY) dy = 0;
					const landed = snapMove(
						{ ...from, x: from.x + dx, y: from.y + dy },
						others,
						options,
					);
					last = {
						...from,
						x: lockX ? from.x : landed.x,
						y: lockY ? from.y : landed.y,
					};
					setGuides(
						landed.guides.filter(
							(g) =>
								!(lockX && g.axis === "x") &&
								!(lockY && g.axis === "y"),
						),
					);
				} else {
					let w = from.w + dx;
					let h = from.h + dy;
					// Shift keeps the shape it had.
					if (ev.shiftKey) {
						const ratio = from.h / from.w;
						if (Math.abs(dx) * ratio >= Math.abs(dy)) h = w * ratio;
						else w = h / ratio;
					}
					const sized = snapResize(
						{ ...from, w, h },
						others,
						ev.shiftKey
							? { ...options, grid: null, guides: false }
							: options,
						minSizes[item.kind],
					);
					last = {
						...from,
						w: Math.round(sized.w),
						h: Math.round(sized.h),
					};
					setGuides(sized.guides);
				}
				setLive((prev) => ({ ...prev, [item.id]: last }));
			};
			const end = () => {
				release();
				setGuides([]);
				target.removeEventListener("pointermove", move);
				target.removeEventListener("pointerup", end);
				target.removeEventListener("pointercancel", end);
				setLive((prev) => {
					const next = { ...prev };
					delete next[item.id];
					return next;
				});
				if (
					last.x !== from.x ||
					last.y !== from.y ||
					last.w !== from.w ||
					last.h !== from.h
				) {
					changeItem(item.id, () => ({
						x: Math.round(last.x),
						y: Math.round(last.y),
						w: last.w,
						h: last.h,
					}));
				}
			};
			target.addEventListener("pointermove", move);
			target.addEventListener("pointerup", end);
			target.addEventListener("pointercancel", end);
		};

	const remove = useCallback(
		(target: Selection) => {
			if (!target) return;
			update((d) =>
				target.kind === "item"
					? {
							items: d.items.filter((i) => i.id !== target.id),
							links: d.links.filter(
								(l) =>
									l.from !== target.id && l.to !== target.id,
							),
						}
					: {
							...d,
							links: d.links.filter((l) => l.id !== target.id),
						},
			);
			setSelected(null);
			setFormatting(false);
			setEditing(null);
		},
		[update],
	);

	// Delete removes what is selected, Escape lets go of it, Enter writes in
	// it, and the arrow keys nudge it by a grid step. Not while typing.
	const nudgeStep = snap.grid ? snap.gridSize : 1;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const typing = (e.target as HTMLElement).closest(
				"input, textarea, select, [contenteditable]",
			);
			if (e.key === "Escape" && !typing) {
				setSelected(null);
				setArrowFrom(null);
				setTool("select");
				setFormatting(false);
				setSnapOpen(false);
				return;
			}
			// Undo and redo for the board. Inside a field the browser's own
			// undo takes back the typing instead.
			const mod = e.ctrlKey || e.metaKey;
			if (mod && !typing && editable) {
				const key = e.key.toLowerCase();
				if (key === "z" || key === "y") {
					e.preventDefault();
					if (key === "y" || e.shiftKey) redo();
					else undo();
					return;
				}
			}
			if (typing || !editable || !selected) return;
			if (e.key === "Delete" || e.key === "Backspace") {
				e.preventDefault();
				remove(selected);
				return;
			}
			if (e.key === "Enter" && selected.kind === "item") {
				const item = definition?.items.find(
					(i) => i.id === selected.id,
				);
				if (item && item.kind !== "visual") {
					e.preventDefault();
					setEditing(item.id);
				}
				return;
			}
			const step = e.shiftKey ? nudgeStep * 4 : nudgeStep;
			const nudge: Record<string, [number, number]> = {
				ArrowLeft: [-step, 0],
				ArrowRight: [step, 0],
				ArrowUp: [0, -step],
				ArrowDown: [0, step],
			};
			const by = nudge[e.key];
			if (by && selected.kind === "item") {
				e.preventDefault();
				update(
					(d) => ({
						...d,
						items: d.items.map((i) =>
							i.id === selected.id
								? { ...i, x: i.x + by[0], y: i.y + by[1] }
								: i,
						),
					}),
					`nudge:${selected.id}`,
				);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [editable, selected, remove, update, undo, redo, definition, nudgeStep]);

	// A new item lands in the middle of what is in view, on the grid.
	const add = (
		kind: "note" | "text" | "shape",
		shape: ShapeKind = "rectangle",
	) => {
		const canvas = canvasRef.current;
		if (!canvas || !definition) return;
		const size = defaultSizes[kind];
		const step = snap.grid ? snap.gridSize : 1;
		const onGrid = (v: number) => Math.round(v / step) * step;
		const item: BoardItem = {
			id: newId(),
			kind,
			x: onGrid((canvas.clientWidth / 2 - view.x) / view.z - size.w / 2),
			y: onGrid((canvas.clientHeight / 2 - view.y) / view.z - size.h / 2),
			...size,
			text: "",
			...(kind === "note" ? { color: "yellow" as NoteColor } : {}),
			...(kind === "shape" ? { shape } : {}),
		};
		update((d) => ({ ...d, items: [...d.items, item] }));
		setSelected({ kind: "item", id: item.id });
		setEditing(item.id);
	};

	// Writing in an item opens its formatting with it.
	const openItem = (item: BoardItem) => {
		if (!editable || item.kind === "visual") return;
		setSelected({ kind: "item", id: item.id });
		setEditing(item.id);
		setFormatting(true);
	};

	if (board.error) {
		return (
			<div className={styles.missing}>
				<h1 className={styles.missingTitle}>
					This board could not be opened
				</h1>
				<p>It may have been deleted, or it is not shared with you.</p>
				<Link href="/mine/" className={styles.primary}>
					Back to My pages
				</Link>
			</div>
		);
	}

	const items = definition?.items ?? [];
	const links = definition?.links ?? [];
	const byId = new Map(items.map((i) => [i.id, i]));
	const selectedItem =
		selected?.kind === "item" ? byId.get(selected.id) : undefined;
	const selectedLink =
		selected?.kind === "link"
			? links.find((l) => l.id === selected.id)
			: undefined;
	const formattable =
		(selectedItem && selectedItem.kind !== "visual") || selectedLink;
	const dots = snap.grid ? Math.max(snap.gridSize, 16) : 24;

	const icon = (d: string) => (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={d} />
		</svg>
	);

	return (
		<div className={styles.board}>
			<header className={styles.toolbar}>
				<Link
					href="/mine/"
					className={styles.back}
					aria-label="Back to My pages"
				>
					{icon("M15 18l-6-6 6-6")}
				</Link>
				<div className={styles.titleGroup}>
					{editable ? (
						<input
							className={styles.titleInput}
							value={board.title}
							onChange={(e) => board.rename(e.target.value)}
							aria-label="Board name"
							// A width in characters for browsers that do not size
							// a field to its content.
							size={Math.max(board.title.length, 8)}
							maxLength={160}
						/>
					) : (
						<h1 className={styles.titleText}>{board.title}</h1>
					)}
					<span className={styles.status} aria-live="polite">
						{!board.board
							? ""
							: board.saving
								? "Saving"
								: editable
									? "Saved"
									: "View only"}
					</span>
				</div>

				<div className={styles.right}>
					{editable && (
						<div
							className={styles.tools}
							role="toolbar"
							aria-label="Add to the board"
						>
							<button
								type="button"
								className={styles.tool}
								onClick={() => add("shape")}
							>
								{icon("M4 6h16v12H4z")}
								Box
							</button>
							<button
								type="button"
								className={styles.tool}
								onClick={() => add("note")}
							>
								{icon("M4 4h16v11l-5 5H4zM15 20v-5h5")}
								Note
							</button>
							<button
								type="button"
								className={styles.tool}
								onClick={() => add("text")}
							>
								{icon("M5 6V4h14v2M12 4v16M9 20h6")}
								Text
							</button>
							<button
								type="button"
								className={styles.tool}
								aria-pressed={tool === "arrow"}
								data-on={tool === "arrow" || undefined}
								onClick={() => {
									setTool((t) =>
										t === "arrow" ? "select" : "arrow",
									);
									setArrowFrom(null);
								}}
							>
								{icon("M5 19L19 5M10 5h9v9")}
								Arrow
							</button>
						</div>
					)}

					{editable && (
						<div className={styles.snapWrap}>
							<button
								type="button"
								className={styles.tool}
								aria-expanded={snapOpen}
								data-on={snapOpen || undefined}
								onClick={() => setSnapOpen((open) => !open)}
								title="How items move"
							>
								{icon("M4 4h6v6H4zM14 14h6v6h-6zM10 7h7v7")}
								Snapping
							</button>
							{snapOpen && (
								<div
									className={styles.snapMenu}
									role="dialog"
									aria-label="Snapping"
								>
									<label className={styles.snapOption}>
										<input
											type="checkbox"
											checked={snap.grid}
											onChange={(e) =>
												setSnap({
													grid: e.target.checked,
												})
											}
										/>
										Snap to the grid
									</label>
									<div
										className={styles.snapSizes}
										role="radiogroup"
										aria-label="Grid size"
									>
										{gridSizes.map((size) => (
											<button
												key={size}
												type="button"
												role="radio"
												aria-checked={
													snap.gridSize === size
												}
												data-on={
													snap.gridSize === size ||
													undefined
												}
												disabled={!snap.grid}
												className={styles.segment}
												onClick={() =>
													setSnap({
														gridSize:
															size as GridSize,
													})
												}
											>
												{size}
											</button>
										))}
									</div>
									<label className={styles.snapOption}>
										<input
											type="checkbox"
											checked={snap.guides}
											onChange={(e) =>
												setSnap({
													guides: e.target.checked,
												})
											}
										/>
										Line up with other items
									</label>
									<p className={styles.snapHint}>
										Hold <kbd>Shift</kbd> to move in one
										direction or keep a shape while
										resizing. Hold <kbd>Alt</kbd> to move
										freely.
									</p>
								</div>
							)}
						</div>
					)}

					{editable && (
						<div
							className={styles.zoom}
							role="group"
							aria-label="History"
						>
							<button
								type="button"
								className={styles.zoomButton}
								onClick={undo}
								disabled={past.current.length === 0}
								aria-label="Undo"
								title="Undo (Ctrl+Z)"
							>
								{icon(
									"M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
								)}
							</button>
							<button
								type="button"
								className={styles.zoomButton}
								onClick={redo}
								disabled={future.current.length === 0}
								aria-label="Redo"
								title="Redo (Ctrl+Shift+Z)"
							>
								{icon(
									"M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
								)}
							</button>
						</div>
					)}
					<div className={styles.zoom} role="group" aria-label="Zoom">
						<button
							type="button"
							className={styles.zoomButton}
							onClick={() => zoomTo(view.z / 1.25)}
							aria-label="Zoom out"
						>
							−
						</button>
						<button
							type="button"
							className={styles.zoomLevel}
							onClick={fit}
							title="Fit everything in view"
						>
							{Math.round(view.z * 100)}%
						</button>
						<button
							type="button"
							className={styles.zoomButton}
							onClick={() => zoomTo(view.z * 1.25)}
							aria-label="Zoom in"
						>
							+
						</button>
					</div>

					{board.board?.permission === "owner" && (
						<button
							type="button"
							className={styles.primary}
							onClick={() => setSharing(true)}
						>
							Share
						</button>
					)}
				</div>
			</header>

			{board.notice && (
				<div className={styles.notice} role="alert">
					{board.notice}
					<button
						type="button"
						className={styles.noticeClose}
						onClick={board.clearNotice}
						aria-label="Dismiss"
					>
						×
					</button>
				</div>
			)}

			{tool === "arrow" && (
				<div className={styles.hint}>
					{arrowFrom
						? "Now choose what the arrow points to. Escape cancels."
						: "Choose the item the arrow starts from."}
				</div>
			)}

			<div
				ref={canvasRef}
				className={styles.canvas}
				data-surface
				data-panning={panning || undefined}
				onPointerDown={onBackgroundDown}
				style={
					{
						"--grid-size": `${dots * view.z}px`,
						backgroundPosition: `${view.x}px ${view.y}px`,
					} as React.CSSProperties
				}
			>
				<div
					className={styles.world}
					data-surface
					style={{
						transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
					}}
				>
					<ArrowLayer
						links={links}
						rectOf={(itemId) => {
							const item = byId.get(itemId);
							return item ? rectOf(item) : null;
						}}
						selectedId={selectedLink?.id ?? null}
						guides={guides}
						onSelect={(linkId) => {
							setSelected({ kind: "link", id: linkId });
							setEditing(null);
							setFormatting(true);
						}}
						onOpen={(linkId) => {
							setSelected({ kind: "link", id: linkId });
							setFormatting(true);
						}}
					/>

					{items.map((item) => {
						const r = rectOf(item);
						const isSelected =
							selected?.kind === "item" &&
							selected.id === item.id;
						const isVisual = item.kind === "visual";
						const source = item.visual
							? sources[item.visual.sourceKey]
							: undefined;
						return (
							<div
								key={item.id}
								className={`${styles.item} ${styles[`item_${item.kind}`] ?? ""}`}
								data-selected={isSelected || undefined}
								data-editing={editing === item.id || undefined}
								data-arrow-from={
									arrowFrom === item.id || undefined
								}
								data-arrow-mode={tool === "arrow" || undefined}
								data-color={
									item.kind === "note"
										? item.color
										: undefined
								}
								data-movable={
									(!isVisual && editable) || undefined
								}
								style={{
									left: r.x,
									top: r.y,
									width: r.w,
									height: r.h,
								}}
								onPointerDown={
									isVisual
										? () => {
												if (tool === "arrow")
													chooseForArrow(item.id);
												else {
													setSelected({
														kind: "item",
														id: item.id,
													});
													setFormatting(false);
												}
											}
										: startGesture(item, "move")
								}
								onDoubleClick={
									isVisual ? undefined : () => openItem(item)
								}
							>
								{isVisual ? (
									<>
										<div
											className={styles.handle}
											style={{ height: handleHeight }}
											onPointerDown={startGesture(
												item,
												"move",
											)}
										>
											<span
												className={styles.grip}
												aria-hidden="true"
											/>
											{item.origin?.slug ? (
												<Link
													href={`/r/${item.origin.slug}/`}
													className={styles.origin}
												>
													{item.origin.title ||
														"Open the report"}
												</Link>
											) : (
												<span className={styles.origin}>
													{item.origin?.title}
												</span>
											)}
										</div>
										<div className={styles.itemBody}>
											{!item.visual ? null : !sourceData ? (
												<div
													className={
														styles.itemLoading
													}
												/>
											) : source ? (
												<VisualRenderer
													visual={{
														visualId: item.id,
														visualType:
															item.visual
																.visualType,
														title: item.visual
															.title,
														sourceKey:
															item.visual
																.sourceKey,
														config: item.visual
															.config as never,
													}}
													sources={sources}
													reportId={
														item.origin?.reportId ??
														null
													}
													frameHeight={
														r.h - handleHeight
													}
												/>
											) : (
												<div
													className={styles.noAccess}
												>
													<strong>
														{item.visual.title ||
															"A visual"}
													</strong>
													<span>
														It reads a dataset you
														do not have access to,
														so nothing of it is
														shown.
													</span>
												</div>
											)}
										</div>
									</>
								) : (
									<>
										{item.kind === "shape" && (
											<ShapeArt
												item={item}
												w={r.w}
												h={r.h}
											/>
										)}
										<Words
											item={item}
											editing={editing === item.id}
											selected={editable && isSelected}
											onText={(text) =>
												changeItem(
													item.id,
													() => ({ text }),
													`text:${item.id}`,
												)
											}
											onDone={() =>
												setEditing((now) =>
													now === item.id
														? null
														: now,
												)
											}
										/>
									</>
								)}

								{editable && (
									<span
										className={styles.resize}
										onPointerDown={startGesture(
											item,
											"resize",
										)}
										aria-hidden="true"
									/>
								)}
							</div>
						);
					})}
				</div>

				{definition && items.length === 0 && (
					<div className={styles.empty}>
						<h2 className={styles.emptyTitle}>An empty board</h2>
						<p>
							Use <strong>Add to board</strong> on any chart or
							table in a report, a card on your home page, or an
							answer from the assistant.
							{editable
								? " Boxes, notes, text and arrows are in the bar above."
								: ""}
						</p>
					</div>
				)}

				{editable &&
					formatting &&
					selectedItem &&
					selectedItem.kind !== "visual" && (
						<ItemFormat
							item={selectedItem}
							onStyle={(patch: Partial<ItemStyle>) =>
								changeItem(
									selectedItem.id,
									(i) => ({
										style: { ...(i.style ?? {}), ...patch },
									}),
									`style:${selectedItem.id}:${Object.keys(patch).join()}`,
								)
							}
							onShape={(shape) =>
								changeItem(selectedItem.id, () => ({ shape }))
							}
							onNoteColor={(color) =>
								changeItem(selectedItem.id, () => ({ color }))
							}
							onClose={() => setFormatting(false)}
						/>
					)}
				{editable && formatting && selectedLink && (
					<LinkFormat
						link={selectedLink}
						onChange={(patch) =>
							changeLink(
								selectedLink.id,
								patch,
								`link:${selectedLink.id}:${Object.keys(patch).join()}`,
							)
						}
						onClose={() => setFormatting(false)}
					/>
				)}

				{editable && (selectedItem || selectedLink) && (
					<div
						className={styles.selectionBar}
						role="toolbar"
						aria-label="Selected"
					>
						{formattable && (
							<button
								type="button"
								className={styles.barButton}
								aria-pressed={formatting}
								onClick={() => setFormatting((open) => !open)}
							>
								Format
							</button>
						)}
						<button
							type="button"
							className={styles.removeButton}
							onClick={() => remove(selected)}
						>
							{selectedLink ? "Remove arrow" : "Remove"}
						</button>
					</div>
				)}
			</div>

			{sharing && board.board && (
				<ShareDialog
					sheetId={board.board.id}
					isOwner
					sharesUrl={`/api/boards/${board.board.id}/shares/`}
					title="Share this board"
					hint="Each person sees every visual through their own access, so a chart on data they cannot read shows them nothing of it. They are told in their inbox."
					onClose={() => setSharing(false)}
				/>
			)}
		</div>
	);
}
