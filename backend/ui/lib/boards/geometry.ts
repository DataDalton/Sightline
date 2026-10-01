// Where arrows run and where moved items land on a board. Pure, so the
// geometry can be tested without a canvas.

import type { ArrowRoute } from "./definition";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Point {
	x: number;
	y: number;
}

const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

// Where a line from a rectangle's centre towards a point leaves it, so a
// straight arrow starts and ends at the edges of the items it joins.
export function edgePoint(rect: Rect, toward: Point): Point {
	const c = centre(rect);
	const dx = toward.x - c.x;
	const dy = toward.y - c.y;
	if (dx === 0 && dy === 0) return c;
	const sx = dx === 0 ? Infinity : rect.w / 2 / Math.abs(dx);
	const sy = dy === 0 ? Infinity : rect.h / 2 / Math.abs(dy);
	const t = Math.min(sx, sy);
	return { x: c.x + dx * t, y: c.y + dy * t };
}

export interface ArrowPath {
	d: string;
	// Where a label sits.
	mid: Point;
}

// Whether two rectangles are further apart across than up and down, which
// decides whether a routed arrow leaves from a side or from the top or bottom.
function across(a: Rect, b: Rect): boolean {
	const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0);
	const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0);
	if (gapX !== gapY) return gapX > gapY;
	const ca = centre(a);
	const cb = centre(b);
	return Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y);
}

const fixed = (n: number) => Math.round(n * 10) / 10;

// The path an arrow takes between two items. Straight runs edge to edge. A
// right angled route leaves from the side facing the other item and turns
// halfway, and a curve leaves and arrives along the same directions.
export function arrowPath(a: Rect, b: Rect, route: ArrowRoute): ArrowPath {
	if (route === "straight") {
		const s = edgePoint(a, centre(b));
		const e = edgePoint(b, centre(a));
		return {
			d: `M${fixed(s.x)},${fixed(s.y)} L${fixed(e.x)},${fixed(e.y)}`,
			mid: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 },
		};
	}
	const ca = centre(a);
	const cb = centre(b);
	if (across(a, b)) {
		const right = cb.x >= ca.x;
		const s = { x: right ? a.x + a.w : a.x, y: ca.y };
		const e = { x: right ? b.x : b.x + b.w, y: cb.y };
		const mx = (s.x + e.x) / 2;
		if (route === "orthogonal") {
			return {
				d: `M${fixed(s.x)},${fixed(s.y)} H${fixed(mx)} V${fixed(e.y)} H${fixed(e.x)}`,
				mid: { x: mx, y: (s.y + e.y) / 2 },
			};
		}
		const k = Math.max(40, Math.abs(e.x - s.x) / 2) * (right ? 1 : -1);
		return {
			d: `M${fixed(s.x)},${fixed(s.y)} C${fixed(s.x + k)},${fixed(s.y)} ${fixed(e.x - k)},${fixed(e.y)} ${fixed(e.x)},${fixed(e.y)}`,
			mid: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 },
		};
	}
	const down = cb.y >= ca.y;
	const s = { x: ca.x, y: down ? a.y + a.h : a.y };
	const e = { x: cb.x, y: down ? b.y : b.y + b.h };
	const my = (s.y + e.y) / 2;
	if (route === "orthogonal") {
		return {
			d: `M${fixed(s.x)},${fixed(s.y)} V${fixed(my)} H${fixed(e.x)} V${fixed(e.y)}`,
			mid: { x: (s.x + e.x) / 2, y: my },
		};
	}
	const k = Math.max(40, Math.abs(e.y - s.y) / 2) * (down ? 1 : -1);
	return {
		d: `M${fixed(s.x)},${fixed(s.y)} C${fixed(s.x)},${fixed(s.y + k)} ${fixed(e.x)},${fixed(e.y - k)} ${fixed(e.x)},${fixed(e.y)}`,
		mid: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 },
	};
}

// --- Snapping ----------------------------------------------------------------

export interface SnapOptions {
	// The grid step, or null for no grid.
	grid: number | null;
	// Whether edges and centres line up with other items.
	guides: boolean;
	// How near, in board units, counts as lined up.
	threshold: number;
}

// A line drawn while an item lines up with another, along x or along y.
export interface Guide {
	axis: "x" | "y";
	at: number;
	from: number;
	to: number;
}

const roundTo = (v: number, step: number) => Math.round(v / step) * step;

// The nearest line up along one axis, from any of the moving item's edges or
// centre against any of another item's.
function alignAxis(
	start: number,
	size: number,
	others: { start: number; size: number }[],
	threshold: number,
): { delta: number; at: number; index: number } | null {
	let best: { delta: number; at: number; index: number } | null = null;
	const ours = [0, size / 2, size];
	others.forEach((o, index) => {
		for (const theirs of [
			o.start,
			o.start + o.size / 2,
			o.start + o.size,
		]) {
			for (const offset of ours) {
				const delta = theirs - (start + offset);
				if (
					Math.abs(delta) <= threshold &&
					(!best || Math.abs(delta) < Math.abs(best.delta))
				)
					best = { delta, at: theirs, index };
			}
		}
	});
	return best;
}

// Where a moved item lands. Lining up with another item wins over the grid
// along each axis, so an edge the eye is matching is matched exactly.
export function snapMove(
	moving: Rect,
	others: Rect[],
	options: SnapOptions,
): { x: number; y: number; guides: Guide[] } {
	let { x, y } = moving;
	const guides: Guide[] = [];
	const ax = options.guides
		? alignAxis(
				x,
				moving.w,
				others.map((o) => ({ start: o.x, size: o.w })),
				options.threshold,
			)
		: null;
	const ay = options.guides
		? alignAxis(
				y,
				moving.h,
				others.map((o) => ({ start: o.y, size: o.h })),
				options.threshold,
			)
		: null;
	if (ax) x += ax.delta;
	else if (options.grid) x = roundTo(x, options.grid);
	if (ay) y += ay.delta;
	else if (options.grid) y = roundTo(y, options.grid);
	if (ax) {
		const o = others[ax.index];
		guides.push({
			axis: "x",
			at: ax.at,
			from: Math.min(y, o.y),
			to: Math.max(y + moving.h, o.y + o.h),
		});
	}
	if (ay) {
		const o = others[ay.index];
		guides.push({
			axis: "y",
			at: ay.at,
			from: Math.min(x, o.x),
			to: Math.max(x + moving.w, o.x + o.w),
		});
	}
	return { x, y, guides };
}

// Where a resized item's right and bottom edges land, by the same rules.
export function snapResize(
	resizing: Rect,
	others: Rect[],
	options: SnapOptions,
	least: { w: number; h: number },
): { w: number; h: number; guides: Guide[] } {
	const guides: Guide[] = [];
	const edge = (start: number, size: number, axis: "x" | "y") => {
		let end = start + size;
		const lines = others.flatMap((o, index) =>
			axis === "x"
				? [o.x, o.x + o.w / 2, o.x + o.w].map((at) => ({ at, index }))
				: [o.y, o.y + o.h / 2, o.y + o.h].map((at) => ({ at, index })),
		);
		const near = options.guides
			? lines
					.filter((l) => Math.abs(l.at - end) <= options.threshold)
					.sort(
						(p, q) => Math.abs(p.at - end) - Math.abs(q.at - end),
					)[0]
			: undefined;
		if (near) {
			end = near.at;
			const o = others[near.index];
			guides.push(
				axis === "x"
					? {
							axis: "x",
							at: end,
							from: Math.min(resizing.y, o.y),
							to: Math.max(resizing.y + resizing.h, o.y + o.h),
						}
					: {
							axis: "y",
							at: end,
							from: Math.min(resizing.x, o.x),
							to: Math.max(resizing.x + resizing.w, o.x + o.w),
						},
			);
		} else if (options.grid) end = roundTo(end, options.grid);
		return end - start;
	};
	return {
		w: Math.max(least.w, edge(resizing.x, resizing.w, "x")),
		h: Math.max(least.h, edge(resizing.y, resizing.h, "y")),
		guides,
	};
}
