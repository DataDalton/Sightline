"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VisualTypeDefinition } from "../../lib/visuals/catalog";
import type { SourceMeta } from "../visuals/types";
import { Hint } from "./PanelSection";
import styles from "./Editor.module.css";

// Every field a visual could read, in one list.
//
// It used to be four lists: a chosen list per kind above an available list per
// kind. That asked an author to hold four places at once, and it put measures
// above dimensions in the panel while a table renders its dimensions first, so
// the panel's order and the page's order disagreed.
//
// One list, one box, one scroll. The fields the visual reads sit at the top, in
// the order it reads them, which for a table is the order the columns come out
// in. Everything else follows after a line. Ticking a field moves it up,
// unticking drops it back, and dragging the handle changes the order of what is
// chosen. There is no second list to look in.
//
// A field moves within its own kind and not across the line between the two.
// The definition holds dimensions and measures as separate ordered lists and
// every renderer reads them that way: a table puts its dimensions before its
// measures, a bar chart takes its axis from the first dimension and ranks by
// the first measure. A drop that interleaved them would show an order nothing
// renders.

export type FieldKind = "dimensions" | "measures";

interface FieldEntry {
	name: string;
	kind: FieldKind;
	description: string | null;
	chosen: boolean;
}

const kindLabels: Record<FieldKind, string> = {
	dimensions: "Dimension",
	measures: "Measure",
};

export function FieldList({
	source,
	dimensions,
	measures,
	encoding,
	showDimensions,
	showMeasures,
	search,
	onSearch,
	onToggle,
	onMove,
}: {
	source: SourceMeta | undefined;
	dimensions: string[];
	measures: string[];
	encoding: VisualTypeDefinition["encoding"];
	// A type that reads none of a kind never offers one.
	showDimensions: boolean;
	showMeasures: boolean;
	search: string;
	onSearch: (v: string) => void;
	onToggle: (name: string, kind: FieldKind) => void;
	onMove: (kind: FieldKind, from: number, to: number) => void;
}) {
	const rows = useRef(new Map<string, HTMLElement>());
	const listRef = useRef<HTMLDivElement | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	// Where the pointer was last seen, so the drag can be worked out on every
	// frame rather than only when the pointer moves.
	const pointerY = useRef(0);

	const term = search.trim().toLowerCase();
	const matches = (name: string) =>
		term === "" || name.toLowerCase().includes(term);

	const describe = useMemo(() => {
		const map = new Map<string, string | null>();
		for (const f of source?.dimensions ?? [])
			map.set(f.name, f.description);
		for (const f of source?.measures ?? []) map.set(f.name, f.description);
		return map;
	}, [source]);

	const heldBy = (kind: FieldKind) =>
		kind === "dimensions" ? dimensions : measures;

	const entry = (name: string, kind: FieldKind, chosen: boolean) => ({
		name,
		kind,
		chosen,
		description: describe.get(name) ?? null,
	});

	// Chosen first, in the order the visual reads them, which is dimensions
	// then measures. Then everything else, in the order the source declares
	// it. One sequence, so the list reads as one list.
	const listed: FieldEntry[] = [
		...(showDimensions ? dimensions : [])
			.filter(matches)
			.map((name) => entry(name, "dimensions", true)),
		...(showMeasures ? measures : [])
			.filter(matches)
			.map((name) => entry(name, "measures", true)),
		...(showDimensions ? (source?.dimensions ?? []) : [])
			.filter((f) => !dimensions.includes(f.name) && matches(f.name))
			.map((f) => entry(f.name, "dimensions", false)),
		...(showMeasures ? (source?.measures ?? []) : [])
			.filter((f) => !measures.includes(f.name) && matches(f.name))
			.map((f) => entry(f.name, "measures", false)),
	];

	const chosenCount = listed.filter((f) => f.chosen).length;

	// Reordering is offered only on the whole list. A search hides rows, and
	// working a landing position out from the ones still showing would move a
	// field past neighbours nobody can see.
	const canReorder = term === "";

	const indexIn = (field: FieldEntry) =>
		heldBy(field.kind).indexOf(field.name);

	const limitFor = (kind: FieldKind) =>
		kind === "dimensions" ? encoding.dimensions : encoding.measures;

	// Where this field would land, counted over the rows it may land among.
	// Measured from the rows themselves rather than from a row height, since a
	// long name wraps and the rows are not all one height.
	const landingFor = (field: FieldEntry, y: number): number | null => {
		let landing = 0;
		for (const other of listed) {
			if (!other.chosen || other.kind !== field.kind) continue;
			const node = rows.current.get(other.name);
			if (!node) continue;
			const box = node.getBoundingClientRect();
			if (y > box.top + box.height / 2) landing = indexIn(other) + 1;
		}

		const from = indexIn(field);
		// Lifting the row out shifts everything below it up by one, so a
		// landing past its own place is one too far.
		const to = landing > from ? landing - 1 : landing;
		return to === from ? null : to;
	};

	const startDrag = (field: FieldEntry, event: React.PointerEvent) => {
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		pointerY.current = event.clientY;
		setDragging(field.name);
	};

	// A drag is worked out on a frame rather than on a pointer move.
	//
	// The list scrolls, and a field being carried past the last visible row has
	// to take the list with it. Reordering only when the pointer moves cannot
	// do that: the pointer sits still against the bottom edge while the rows
	// underneath it need to keep going, and holding it there did nothing at
	// all. Reading the last known position every frame scrolls the box and
	// moves the field by the same rule, so both keep going while the pointer
	// is held.
	const drag = () => {
		const list = listRef.current;
		const field = listed.find((f) => f.chosen && f.name === dragging);
		if (!list || !field) return;

		const box = list.getBoundingClientRect();
		const edge = 28;
		const y = pointerY.current;
		if (y < box.top + edge) {
			list.scrollTop -= Math.max(3, (box.top + edge - y) / 2);
		} else if (y > box.bottom - edge) {
			list.scrollTop += Math.max(3, (y - box.bottom + edge) / 2);
		}

		const to = landingFor(field, y);
		if (to !== null) onMove(field.kind, indexIn(field), to);
	};

	// Rebuilt every render, so the frame always reads the order as it stands
	// rather than the one the drag started against.
	const dragRef = useRef(drag);
	dragRef.current = drag;

	useEffect(() => {
		if (!dragging) return;
		let running = true;
		let frame = 0;
		const step = () => {
			if (!running) return;
			dragRef.current();
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => {
			running = false;
			cancelAnimationFrame(frame);
		};
	}, [dragging]);

	// Arrow keys do the same thing. A list that can only be reordered by
	// dragging cannot be reordered by anybody working from the keyboard.
	const onHandleKey = (field: FieldEntry, event: React.KeyboardEvent) => {
		const from = indexIn(field);
		const held = heldBy(field.kind);
		if (event.key === "ArrowUp" && from > 0) {
			event.preventDefault();
			onMove(field.kind, from, from - 1);
		}
		if (event.key === "ArrowDown" && from < held.length - 1) {
			event.preventDefault();
			onMove(field.kind, from, from + 1);
		}
	};

	return (
		<div className={styles.fields}>
			<input
				className={styles.input}
				placeholder="Search fields"
				value={search}
				onChange={(e) => onSearch(e.target.value)}
			/>

			{/* Scrolls itself. A wide source puts a hundred and twenty rows in
			    this column, and everything below them, the drill path and the
			    control that removes the visual included, sat under all of it. */}
			<div
				className={`${styles.fieldList} ${dragging ? styles.listDragging : ""}`}
				ref={listRef}
			>
				{listed.length === 0 ? (
					<p className={styles.listEmpty}>
						{!source
							? "This visual has no source yet."
							: `Nothing matches "${search.trim()}".`}
					</p>
				) : (
					listed.map((field, i) => {
						const limit = limitFor(field.kind);
						const full =
							!field.chosen &&
							heldBy(field.kind).length >= limit.max;
						const noun = kindLabels[field.kind].toLowerCase();
						// The line between what is read and what is not. Drawn
						// on the first row below it rather than as a heading,
						// so the list stays one list.
						const firstSpare = !field.chosen && i === chosenCount;

						return (
							<div
								key={`${field.kind}:${field.name}`}
								ref={(node) => {
									if (node)
										rows.current.set(field.name, node);
									else rows.current.delete(field.name);
								}}
								className={`${styles.fieldRow} ${
									field.chosen ? styles.fieldOn : ""
								} ${dragging === field.name ? styles.fieldMoving : ""} ${
									firstSpare ? styles.fieldSplit : ""
								}`}
							>
								{field.chosen && canReorder ? (
									<button
										type="button"
										className={styles.fieldGrip}
										aria-label={`Reorder ${field.name}`}
										onPointerDown={(e) =>
											startDrag(field, e)
										}
										onPointerMove={(e) => {
											pointerY.current = e.clientY;
										}}
										onPointerUp={() => setDragging(null)}
										onPointerCancel={() =>
											setDragging(null)
										}
										onKeyDown={(e) => onHandleKey(field, e)}
									>
										<GripIcon />
									</button>
								) : (
									// Held open so every checkbox in the list
									// sits in the same column.
									<span
										className={styles.fieldGripSlot}
										aria-hidden="true"
									/>
								)}

								<button
									type="button"
									className={styles.fieldBody}
									disabled={full}
									aria-pressed={field.chosen}
									onClick={() =>
										onToggle(field.name, field.kind)
									}
									title={
										full
											? `Untick one first. This visual reads at most ${limit.max} ${limit.max === 1 ? noun : `${noun}s`}.`
											: (field.description ?? field.name)
									}
								>
									<Check on={field.chosen} />
									<span className={styles.fieldName}>
										{field.name}
									</span>
									<span className={styles.kindTag}>
										{kindLabels[field.kind]}
									</span>
								</button>
							</div>
						);
					})
				)}
			</div>

			{chosenCount > 1 && (
				<Hint>
					Order is the encoding. The first dimension is the axis and
					the first measure is the one anything ranked is ranked by.
				</Hint>
			)}
		</div>
	);
}

export function Check({ on }: { on: boolean }) {
	return (
		<span
			className={`${styles.checkbox} ${on ? styles.checked : ""}`}
			aria-hidden="true"
		>
			<svg width="9" height="9" viewBox="0 0 16 16" fill="none">
				<path
					d="M3 8.5l3.5 3.5L13 5"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</span>
	);
}

function GripIcon() {
	return (
		<svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
			{[2, 7, 12].map((y) =>
				[2, 8].map((x) => (
					<circle
						key={`${x}-${y}`}
						cx={x}
						cy={y}
						r="1.2"
						fill="currentColor"
					/>
				)),
			)}
		</svg>
	);
}
