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
		h: Math.max(
			minHeight,
			Math.round((height + gridGap) / (rowHeight + gridGap)),
		),
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
				x < r.x + r.w &&
				x + width > r.x &&
				y < r.y + r.h &&
				y + h > r.y,
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
		a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
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
// A page opens on whatever its first visual is, not on a band of empty rows.
// Gaps appear when a visual is deleted, or when something that was on the grid
// moves off it. Leading and interior gaps close; relative order and the gaps an
// author left within a row are kept.
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
				if (
					y < other.rect.y + other.rect.h &&
					y + item.rect.h > other.rect.y
				) {
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
	return Math.max(
		minHeight,
		Math.round((pixels + gridGap) / (rowHeight + gridGap)),
	);
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

// --- Groups ----------------------------------------------------------------
//
// A group is a visual that holds other visuals. What it holds is stored on the
// children, each naming its parent, and a child's rectangle is measured from
// the group's content box rather than from the page. That is what lets a group
// move without touching anything inside it: the children's numbers do not
// change, only where the box they are measured from happens to be.
//
// A child is laid out on the same twelve columns as the page, measured across
// the group's width. So a child six columns wide is half the group, whatever
// size the group is, which is the same promise the page grid makes.

export const groupPadding = 12;
export const groupHeaderHeight = 30;

export function groupContentBox(
	outer: { width: number; height: number },
	hasHeader: boolean,
): { width: number; height: number } {
	return {
		width: Math.max(1, outer.width - groupPadding * 2),
		height: Math.max(
			0,
			outer.height -
				groupPadding * 2 -
				(hasHeader ? groupHeaderHeight : 0),
		),
	};
}

// The lowest edge a set of rectangles reaches. What a group needs to be tall
// enough for, and where the next thing dropped into one belongs.
export function boundsRows(rects: Rect[]): number {
	return rects.reduce((max, r) => Math.max(max, r.y + r.h), 0);
}

// Whether putting `child` inside `parent` would make a loop.
//
// A group can hold a group, so the chain has to be walked rather than just
// checking the two ends. Without this, dropping a group into something it
// already contains produces a page that renders until the stack runs out.
export function wouldLoop(
	childId: string,
	parentId: string | null,
	parentOf: (id: string) => string | null | undefined,
): boolean {
	if (!parentId) return false;
	if (parentId === childId) return true;

	const seen = new Set<string>([childId]);
	let at: string | null | undefined = parentId;
	while (at) {
		if (seen.has(at)) return true;
		seen.add(at);
		at = parentOf(at);
	}
	return false;
}

// --- Tidying an arrangement -------------------------------------------------

// How close two heights have to be before they are treated as meant to match.
//
// A row where one visual is four rows and its neighbour is five reads as a
// mistake, and levelling it is the whole point of tidying. A row where one is
// four and its neighbour is nine reads as a decision, and growing the short one
// to nine would throw that decision away. One row of slack separates the two.
const levellingSlack = 1;

// A row narrower than this is left at the width the author gave it. Filling a
// single three column visual out to the full twelve is not tidying, it is
// rewriting the page.
const fillableFrom = 9;

export interface TidyResult<T> {
	items: T[];
	// How many rectangles the tidy actually changed, so the editor can say
	// nothing needed doing rather than recording an empty step.
	moved: number;
}

function sameRect(a: Rect, b: Rect): boolean {
	return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// Straightens one container's arrangement: closes gaps, lines rows up, and
// levels heights that were nearly level already.
//
// Rows are the visuals sharing a y, which is what an author means by a row and
// what the grid's snapping already produces. Grouping by overlap instead would
// pull a tall visual and the two stacked beside it into one row and then
// flatten all three, which is a rearrangement rather than a tidy.
//
// Five rules, in order, each one narrow enough to predict before pressing it:
//
//   1. Rows keep their vertical order, and stack with no empty rows between.
//   2. A row of two or more closes the horizontal gaps between its visuals,
//      preserving their left-to-right order.
//   3. A row already reaching most of the way across is stretched to fill the
//      grid, so the page has one right edge rather than a ragged one.
//   4. Heights within a row level up to the tallest, but only when they were
//      within a row of each other to begin with.
//   5. A row holding one visual keeps its x and its width, because a visual
//      placed on its own is placed where somebody wanted it.
//
// Nothing here reads or writes a parent, so a caller with groups on the page
// runs it once per container. A group's children are measured from the group's
// own origin, and mixing the two coordinate spaces would move every child.
export function tidyLayout<T extends { rect: Rect }>(
	items: T[],
): TidyResult<T> {
	if (items.length === 0) return { items, moved: 0 };

	// Rows in the order they appear down the page, each sorted left to right.
	const rows = new Map<number, T[]>();
	for (const item of items) {
		const row = rows.get(item.rect.y);
		if (row) row.push(item);
		else rows.set(item.rect.y, [item]);
	}
	const ordered = [...rows.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, row]) => [...row].sort((a, b) => a.rect.x - b.rect.x));

	const next = new Map<T, Rect>();
	let y = 0;

	for (const row of ordered) {
		const heights = row.map((i) => i.rect.h);
		const tallest = Math.max(...heights);
		const shortest = Math.min(...heights);
		// Rule 4. A row whose heights already agree is levelled for free, and
		// one where they disagree by more than the slack is left alone.
		const level = tallest - shortest <= levellingSlack;

		if (row.length === 1) {
			// Rule 5.
			const only = row[0];
			next.set(only, { ...only.rect, y });
			y += only.rect.h;
			continue;
		}

		const total = row.reduce((sum, i) => sum + i.rect.w, 0);
		// Rule 3. Slack is shared from the left, so the leftmost visuals take
		// the extra column when it does not divide evenly. Never widens past
		// the grid, and never narrows anything.
		const slack =
			total >= fillableFrom && total < gridColumns
				? gridColumns - total
				: 0;
		const share = Math.floor(slack / row.length);
		let spare = slack - share * row.length;

		let x = 0;
		for (const item of row) {
			const extra = share + (spare > 0 ? 1 : 0);
			if (spare > 0) spare--;
			const w = Math.min(item.rect.w + extra, gridColumns - x);
			next.set(item, {
				x,
				y,
				w: Math.max(minWidth, w),
				h: level ? tallest : item.rect.h,
			});
			// Rule 2. The next visual starts where this one ends.
			x += w;
		}

		y += level ? tallest : Math.max(...heights);
	}

	let moved = 0;
	const result = items.map((item) => {
		const rect = next.get(item);
		if (!rect || sameRect(rect, item.rect)) return item;
		moved++;
		return { ...item, rect };
	});

	return { items: result, moved };
}

// --- Aligning a selection ---------------------------------------------------

// What lining up a set of rectangles can mean.
//
// Every mode is measured against the selection's own bounds rather than
// against one member of it. Aligning left means the leftmost edge in the
// selection, not the edge of whichever visual happened to be clicked first,
// which is the behaviour of every tool an author has arranged anything in.
export type AlignMode =
	| "left"
	| "right"
	| "centreX"
	| "top"
	| "bottom"
	| "centreY"
	| "matchWidth"
	| "matchHeight";

function bounds(rects: Rect[]): {
	left: number;
	right: number;
	top: number;
	bottom: number;
} {
	return {
		left: Math.min(...rects.map((r) => r.x)),
		right: Math.max(...rects.map((r) => r.x + r.w)),
		top: Math.min(...rects.map((r) => r.y)),
		bottom: Math.max(...rects.map((r) => r.y + r.h)),
	};
}

export function alignRects<T extends { rect: Rect }>(
	items: T[],
	mode: AlignMode,
): T[] {
	// One rectangle is already aligned with itself.
	if (items.length < 2) return items;

	const box = bounds(items.map((i) => i.rect));
	const widest = Math.max(...items.map((i) => i.rect.w));
	const tallest = Math.max(...items.map((i) => i.rect.h));

	return items.map((item) => {
		const r = item.rect;
		let next: Rect;

		switch (mode) {
			case "left":
				next = { ...r, x: box.left };
				break;
			case "right":
				next = { ...r, x: box.right - r.w };
				break;
			case "centreX":
				next = {
					...r,
					x: Math.round((box.left + box.right - r.w) / 2),
				};
				break;
			case "top":
				next = { ...r, y: box.top };
				break;
			case "bottom":
				next = { ...r, y: box.bottom - r.h };
				break;
			case "centreY":
				next = {
					...r,
					y: Math.round((box.top + box.bottom - r.h) / 2),
				};
				break;
			case "matchWidth":
				// Widened rather than narrowed, so matching never hides
				// content that was visible before it.
				next = { ...r, w: Math.min(widest, gridColumns - r.x) };
				break;
			case "matchHeight":
				next = { ...r, h: tallest };
				break;
		}

		// Alignment cannot push anything off the grid, whatever the arithmetic
		// above worked out.
		next = {
			...next,
			x: Math.max(0, Math.min(next.x, gridColumns - next.w)),
		};
		return sameRect(next, r) ? item : { ...item, rect: next };
	});
}

// Spreads a selection so the gaps between its members are equal.
//
// The outermost two stay where they are, which is what makes this predictable:
// an author sets the span by placing the ends, and distributing fills it. With
// fewer than three there is no middle to move, so nothing happens.
//
// Gaps rather than centres. Equal centres on rectangles of different widths
// leaves visibly uneven space between them, and space is what the eye reads.
export function distributeRects<T extends { rect: Rect }>(
	items: T[],
	axis: "x" | "y",
): T[] {
	if (items.length < 3) return items;

	const size = axis === "x" ? "w" : "h";
	const sorted = [...items].sort((a, b) => a.rect[axis] - b.rect[axis]);

	const first = sorted[0].rect;
	const last = sorted[sorted.length - 1].rect;
	const start = first[axis];
	const end = last[axis] + last[size];
	const occupied = sorted.reduce((sum, i) => sum + i.rect[size], 0);
	const free = end - start - occupied;
	// Overlapping already, so there is no free space to share out and any
	// answer here would be an invention.
	if (free < 0) return items;

	const gap = free / (sorted.length - 1);

	const moved = new Map<T, Rect>();
	let at = start;
	for (const item of sorted) {
		const value = Math.round(at);
		if (value !== item.rect[axis]) {
			moved.set(item, { ...item.rect, [axis]: value });
		}
		at += item.rect[size] + gap;
	}

	return items.map((item) => {
		const rect = moved.get(item);
		return rect ? { ...item, rect } : item;
	});
}
