// Grid geometry for the report canvas.
//
// The canvas is a fixed 12 column grid with a fixed row height, and a visual
// occupies a rectangle of cells. Columns rather than pixels because the canvas
// has to work from a phone to an ultrawide: a visual six columns across is
// half the width at every size, while a visual 640 pixels across is most of a
// laptop and a third of a monitor.
//
// Placement is free-form. Visuals may sit anywhere, including overlapping,
// because an author arranging a page knows what they want better than a
// reflow algorithm does. What the grid provides is snapping, so a row of
// visuals lines up without anyone nudging pixels.

export const gridColumns = 12;
export const rowHeight = 52;
export const gridGap = 12;

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export const minWidth = 2;
export const minHeight = 2;

export function clampRect(rect: Rect): Rect {
	const w = Math.max(minWidth, Math.min(rect.w, gridColumns));
	const h = Math.max(minHeight, rect.h);
	// A visual is kept inside the left and right edges. There is no bottom
	// edge: the canvas grows downward as an author adds to it.
	const x = Math.max(0, Math.min(rect.x, gridColumns - w));
	const y = Math.max(0, rect.y);
	return { x, y, w, h };
}

export interface CanvasMetrics {
	// Usable width in pixels, excluding the canvas padding.
	width: number;
	columnWidth: number;
}

export function measureCanvas(width: number): CanvasMetrics {
	const totalGap = gridGap * (gridColumns - 1);
	return {
		width,
		columnWidth: Math.max(1, (width - totalGap) / gridColumns),
	};
}

// Pixel position of a rectangle, for absolute placement.
export function rectToPixels(
	rect: Rect,
	metrics: CanvasMetrics,
): { left: number; top: number; width: number; height: number } {
	return {
		left: rect.x * (metrics.columnWidth + gridGap),
		top: rect.y * (rowHeight + gridGap),
		width: rect.w * metrics.columnWidth + (rect.w - 1) * gridGap,
		height: rect.h * rowHeight + (rect.h - 1) * gridGap,
	};
}

// Nearest grid cell to a pixel offset. Used while dragging, so the visual
// snaps as it moves rather than jumping into place on release.
export function pixelsToCell(
	left: number,
	top: number,
	metrics: CanvasMetrics,
): { x: number; y: number } {
	return {
		x: Math.round(left / (metrics.columnWidth + gridGap)),
		y: Math.round(top / (rowHeight + gridGap)),
	};
}

export function pixelsToSpan(
	width: number,
	height: number,
	metrics: CanvasMetrics,
): { w: number; h: number } {
	return {
		w: Math.max(
			minWidth,
			Math.round((width + gridGap) / (metrics.columnWidth + gridGap)),
		),
		h: Math.max(minHeight, Math.round((height + gridGap) / (rowHeight + gridGap))),
	};
}

// Total rows the canvas needs, plus room to drop something below the last
// visual. Without the spare rows there is nowhere to drag a new visual to.
export function canvasRows(rects: Rect[], spare = 4): number {
	const lowest = rects.reduce((max, r) => Math.max(max, r.y + r.h), 0);
	return lowest + spare;
}

// First free position wide enough for a new visual, scanning left to right and
// top to bottom. Falls back to the row below everything when the canvas is
// full, so adding a visual always puts it somewhere visible.
export function findFreeSlot(existing: Rect[], w: number, h: number): Rect {
	const width = Math.min(w, gridColumns);
	const occupied = (x: number, y: number): boolean =>
		existing.some(
			(r) =>
				x < r.x + r.w && x + width > r.x && y < r.y + r.h && y + h > r.y,
		);

	const maxRow = canvasRows(existing, 0);
	for (let y = 0; y <= maxRow; y++) {
		for (let x = 0; x + width <= gridColumns; x++) {
			if (!occupied(x, y)) return { x, y, w: width, h };
		}
	}
	return { x: 0, y: maxRow, w: width, h };
}

// True when two rectangles overlap. Used to warn an author rather than to
// prevent the placement, since deliberate overlap is sometimes what is wanted.
export function overlaps(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.w &&
		a.x + a.w > b.x &&
		a.y < b.y + b.h &&
		a.y + a.h > b.y
	);
}

// Collapses the canvas to a single column, for a narrow screen. Order is taken
// from reading order rather than from the stored y, so a visual placed to the
// right of another appears after it rather than jumping above.
export function stackForNarrow(
	items: { id: string; rect: Rect }[],
): { id: string; rect: Rect }[] {
	const ordered = [...items].sort((a, b) => {
		if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y;
		return a.rect.x - b.rect.x;
	});

	let y = 0;
	return ordered.map((item) => {
		const rect = { x: 0, y, w: gridColumns, h: item.rect.h };
		y += item.rect.h;
		return { id: item.id, rect };
	});
}

// Removes empty rows the arrangement does not need.
//
// Page controls used to occupy rows on the grid before they were lifted into
// their own strip, which left the pages that had one opening on a band of
// nothing. The same happens whenever an author deletes the top visual. Leading
// and interior gaps are closed while the relative order and the gaps an author
// deliberately left within a row are kept.
//
// Only whole empty rows are closed. A visual is never moved sideways and two
// visuals that share a row stay sharing it, because that is an arrangement
// someone made rather than an accident.
export function compactRows<T extends { rect: Rect }>(items: T[]): T[] {
	if (items.length === 0) return items;

	const occupied = new Set<number>();
	for (const item of items) {
		for (let y = item.rect.y; y < item.rect.y + item.rect.h; y++) {
			occupied.add(y);
		}
	}

	// How far each row moves up once the empty ones above it are closed.
	const shift = new Map<number, number>();
	const maxRow = Math.max(...items.map((i) => i.rect.y + i.rect.h));
	let removed = 0;
	for (let y = 0; y <= maxRow; y++) {
		if (!occupied.has(y)) {
			removed++;
			continue;
		}
		shift.set(y, removed);
	}

	return items.map((item) => ({
		...item,
		rect: { ...item.rect, y: item.rect.y - (shift.get(item.rect.y) ?? 0) },
	}));
}

// Pushes overlapping items down until nothing sits on top of anything else.
//
// The editor allows overlap on purpose: rearranging a page is a judgement an
// author is making and a reflow algorithm would fight them. A reader has no
// such intent, and a reader who has made one visual taller has grown it into
// whatever was underneath. Only vertical position moves, so a page keeps the
// columns and the side-by-side pairings the author set up.
//
// A no-op on an arrangement that does not overlap, which is what keeps the
// published page identical to the canvas by default.
export function resolveVerticalOverlaps<T extends { rect: Rect }>(
	items: T[],
): T[] {
	const sorted = [...items].sort(
		(a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x,
	);

	const placed: T[] = [];
	for (const item of sorted) {
		let y = item.rect.y;
		let settled = false;

		while (!settled) {
			settled = true;
			for (const other of placed) {
				const sharesColumns =
					item.rect.x < other.rect.x + other.rect.w &&
					item.rect.x + item.rect.w > other.rect.x;
				if (!sharesColumns) continue;
				if (y < other.rect.y + other.rect.h && y + item.rect.h > other.rect.y) {
					y = other.rect.y + other.rect.h;
					settled = false;
				}
			}
		}

		placed.push({ ...item, rect: { ...item.rect, y } });
	}
	return placed;
}

// Converting between a pixel height and a number of grid rows, so a height a
// reader dragged to can be expressed in the same units as the arrangement.
export function heightForRows(rows: number): number {
	return rows * rowHeight + (rows - 1) * gridGap;
}

export function rowsForHeight(pixels: number): number {
	return Math.max(minHeight, Math.round((pixels + gridGap) / (rowHeight + gridGap)));
}

// Grows the visuals on the bottom row to reach the foot of the viewport.
//
// A detail table is usually the last thing on a page and the thing a reader
// spends their time in, and leaving it at a fixed six rows wastes whatever the
// screen has spare while making the reader scroll inside a short box. Filling
// is the sensible default for those, and an author can turn it off where the
// table is deliberately a preview.
//
// Only the bottom row grows, and only downwards, so nothing else on the page
// moves. A visual already taller than the space is left alone rather than
// shrunk: the author asked for that height.
export function fillToViewport<T extends { rect: Rect; canFill?: boolean }>(
	items: T[],
	availableHeight: number,
): T[] {
	if (items.length === 0 || availableHeight <= 0) return items;

	const bottom = Math.max(...items.map((i) => i.rect.y + i.rect.h));
	const growable = items.filter(
		(i) => i.canFill && i.rect.y + i.rect.h === bottom,
	);
	if (growable.length === 0) return items;

	return items.map((item) => {
		if (!growable.includes(item)) return item;
		const topPixels = item.rect.y * (rowHeight + gridGap);
		const rows = rowsForHeight(availableHeight - topPixels);
		if (rows <= item.rect.h) return item;
		return { ...item, rect: { ...item.rect, h: rows } };
	});
}
