// What a board holds, and the cleaning every change goes through.
//
// A board is a canvas of items placed in board coordinates: live visuals
// copied from reports with the filters they were showing, sticky notes, free
// text and shapes, with arrows from one item to another. Pure, so the
// cleaning can be tested on its own. Everything a client sends passes through
// cleanDefinition before it is stored.
//
// Colours are names rather than values. The page turns each name into a theme
// colour, so a board reads the same in light and dark and nobody can store a
// colour that only works on one of them.

export type ItemKind = "visual" | "note" | "text" | "shape";

export const noteColors = ["yellow", "blue", "green", "pink", "grey"] as const;
export type NoteColor = (typeof noteColors)[number];

// Every colour a shape, its border, its text or an arrow can take. None is
// for a fill or border that is not drawn, and default follows the theme's own
// text or border colour.
export const colorNames = [
	"none",
	"default",
	"grey",
	"blue",
	"teal",
	"green",
	"yellow",
	"orange",
	"red",
	"pink",
	"purple",
] as const;
export type ColorName = (typeof colorNames)[number];

export const shapeKinds = [
	"rectangle",
	"rounded",
	"ellipse",
	"diamond",
] as const;
export type ShapeKind = (typeof shapeKinds)[number];

export const lineStyles = ["solid", "dashed", "dotted"] as const;
export type LineStyle = (typeof lineStyles)[number];

export const textSizes = ["small", "medium", "large", "title"] as const;
export type TextSize = (typeof textSizes)[number];

export const horizontalAligns = ["left", "center", "right"] as const;
export const verticalAligns = ["top", "middle", "bottom"] as const;

// How a shape and the words in it look. Every key is optional, and a missing
// one takes the default for the kind of item.
export interface ItemStyle {
	fill?: ColorName;
	stroke?: ColorName;
	strokeWidth?: number;
	strokeStyle?: LineStyle;
	textColor?: ColorName;
	textSize?: TextSize;
	bold?: boolean;
	italic?: boolean;
	align?: (typeof horizontalAligns)[number];
	valign?: (typeof verticalAligns)[number];
}

export const arrowRoutes = ["straight", "orthogonal", "curved"] as const;
export type ArrowRoute = (typeof arrowRoutes)[number];

export const arrowEnds = ["end", "both", "none"] as const;
export type ArrowEnds = (typeof arrowEnds)[number];

// A visual as a report holds one, with the filters it was showing folded into
// its own, so it reads the same numbers wherever it is placed.
export interface BoardVisual {
	visualType: string;
	title: string | null;
	sourceKey: string;
	config: {
		dimensions?: string[];
		measures?: string[];
		filters?: unknown[];
		sort?: unknown[];
		transforms?: unknown[];
		options?: Record<string, unknown>;
		style?: object;
		limit?: number;
	};
}

// Where a visual came from, so the board can link back to it.
export interface BoardOrigin {
	reportId: string | null;
	slug: string | null;
	title: string;
}

export interface BoardItem {
	id: string;
	kind: ItemKind;
	x: number;
	y: number;
	w: number;
	h: number;
	visual?: BoardVisual;
	origin?: BoardOrigin;
	// What a note, text item or shape says.
	text?: string;
	color?: NoteColor;
	shape?: ShapeKind;
	style?: ItemStyle;
}

export interface BoardLink {
	id: string;
	from: string;
	to: string;
	route?: ArrowRoute;
	line?: LineStyle;
	ends?: ArrowEnds;
	color?: ColorName;
	width?: number;
	label?: string;
	// Dashes moving along the arrow towards where it points.
	flow?: boolean;
}

export interface BoardDefinition {
	items: BoardItem[];
	links: BoardLink[];
}

// The canvas is open in every direction, but a coordinate past this is a
// mistake rather than a place, and would leave an item nobody can reach.
const reach = 100_000;
// The smallest each kind can be made and still be read.
export const minSizes: Record<ItemKind, { w: number; h: number }> = {
	visual: { w: 200, h: 140 },
	note: { w: 120, h: 60 },
	text: { w: 60, h: 32 },
	shape: { w: 24, h: 24 },
};
const maxSize = { w: 4000, h: 3000 };
const maxLabel = 200;
// A note or text item, kept to what a person writes rather than a document.
export const maxText = 4000;
const maxTitle = 160;

export const defaultSizes: Record<ItemKind, { w: number; h: number }> = {
	visual: { w: 520, h: 340 },
	note: { w: 240, h: 200 },
	text: { w: 360, h: 80 },
	shape: { w: 200, h: 120 },
};

export function emptyBoard(): BoardDefinition {
	return { items: [], links: [] };
}

function number(value: unknown, fallback: number, min: number, max: number) {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.round(Math.min(Math.max(n, min), max));
}

function text(value: unknown, max: number): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function strings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((v): v is string => typeof v === "string").slice(0, 60);
}

function list(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value.slice(0, 200) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

// An item id, made here when one is missing so two items cannot share one.
function idOf(value: unknown, taken: Set<string>): string {
	let id =
		typeof value === "string" && /^[\w-]{1,64}$/.test(value) ? value : "";
	while (!id || taken.has(id)) {
		id = `i${Math.random().toString(36).slice(2, 10)}`;
	}
	taken.add(id);
	return id;
}

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
): T | undefined {
	return allowed.includes(value as T) ? (value as T) : undefined;
}

// Only the keys that were set and are allowed, so a style sent with something
// unknown in it keeps the rest.
function cleanStyle(raw: unknown): ItemStyle | undefined {
	const r = record(raw);
	if (!r) return undefined;
	const style: ItemStyle = {
		fill: oneOf(r.fill, colorNames),
		stroke: oneOf(r.stroke, colorNames),
		strokeStyle: oneOf(r.strokeStyle, lineStyles),
		textColor: oneOf(r.textColor, colorNames),
		textSize: oneOf(r.textSize, textSizes),
		align: oneOf(r.align, horizontalAligns),
		valign: oneOf(r.valign, verticalAligns),
	};
	if (r.strokeWidth !== undefined)
		style.strokeWidth = number(r.strokeWidth, 2, 0, 12);
	if (typeof r.bold === "boolean") style.bold = r.bold;
	if (typeof r.italic === "boolean") style.italic = r.italic;
	for (const key of Object.keys(style) as (keyof ItemStyle)[]) {
		if (style[key] === undefined) delete style[key];
	}
	return Object.keys(style).length ? style : undefined;
}

function cleanVisual(raw: unknown): BoardVisual | null {
	const r = record(raw);
	const sourceKey = text(r?.sourceKey, 200).trim();
	const visualType = text(r?.visualType, 60).trim();
	if (!r || !sourceKey || !visualType) return null;
	const c = record(r.config) ?? {};
	const config: BoardVisual["config"] = {};
	const dimensions = strings(c.dimensions);
	const measures = strings(c.measures);
	if (dimensions) config.dimensions = dimensions;
	if (measures) config.measures = measures;
	for (const key of ["filters", "sort", "transforms"] as const) {
		const value = list(c[key]);
		if (value) config[key] = value;
	}
	const options = record(c.options);
	const style = record(c.style);
	if (options) config.options = options;
	if (style) config.style = style;
	if (typeof c.limit === "number" && Number.isFinite(c.limit))
		config.limit = Math.max(1, Math.round(c.limit));
	const title = text(r.title, maxTitle).trim();
	return { visualType, title: title || null, sourceKey, config };
}

function cleanOrigin(raw: unknown): BoardOrigin | undefined {
	const r = record(raw);
	if (!r) return undefined;
	const reportId = text(r.reportId, 64);
	const slug = text(r.slug, 200);
	return {
		reportId: /^[0-9a-f-]{36}$/i.test(reportId) ? reportId : null,
		slug: /^[\w-]+$/.test(slug) ? slug : null,
		title: text(r.title, maxTitle),
	};
}

export function cleanItem(raw: unknown, taken: Set<string>): BoardItem | null {
	const r = record(raw);
	if (!r) return null;
	const kind = r.kind;
	if (
		kind !== "visual" &&
		kind !== "note" &&
		kind !== "text" &&
		kind !== "shape"
	)
		return null;
	const size = defaultSizes[kind];
	const least = minSizes[kind];
	const item: BoardItem = {
		id: idOf(r.id, taken),
		kind,
		x: number(r.x, 0, -reach, reach),
		y: number(r.y, 0, -reach, reach),
		w: number(r.w, size.w, least.w, maxSize.w),
		h: number(r.h, size.h, least.h, maxSize.h),
	};
	if (kind === "visual") {
		const visual = cleanVisual(r.visual);
		if (!visual) return null;
		item.visual = visual;
		const origin = cleanOrigin(r.origin);
		if (origin) item.origin = origin;
	} else {
		item.text = text(r.text, maxText);
		if (kind === "note") {
			item.color = noteColors.includes(r.color as NoteColor)
				? (r.color as NoteColor)
				: "yellow";
		}
		if (kind === "shape")
			item.shape = oneOf(r.shape, shapeKinds) ?? "rectangle";
		const style = cleanStyle(r.style);
		if (style) item.style = style;
	}
	return item;
}

export function cleanDefinition(raw: unknown): BoardDefinition {
	const r = record(raw);
	const taken = new Set<string>();
	const items = (Array.isArray(r?.items) ? r.items : [])
		.map((item) => cleanItem(item, taken))
		.filter((item): item is BoardItem => item !== null);
	const ids = new Set(items.map((i) => i.id));
	const seen = new Set<string>();
	const links = (Array.isArray(r?.links) ? r.links : [])
		.map((link) => record(link))
		.filter((link): link is Record<string, unknown> => Boolean(link))
		.map((link) => {
			const clean: BoardLink = {
				from: text(link.from, 64),
				to: text(link.to, 64),
				id: text(link.id, 64),
				route: oneOf(link.route, arrowRoutes),
				line: oneOf(link.line, lineStyles),
				ends: oneOf(link.ends, arrowEnds),
				color: oneOf(link.color, colorNames),
			};
			if (link.width !== undefined)
				clean.width = number(link.width, 2, 1, 8);
			const label = text(link.label, maxLabel).trim();
			if (label) clean.label = label;
			if (link.flow === true) clean.flow = true;
			for (const key of Object.keys(clean) as (keyof BoardLink)[]) {
				if (clean[key] === undefined) delete clean[key];
			}
			return clean;
		})
		// An arrow between two items still on the board, once each way.
		.filter((link) => {
			if (
				!ids.has(link.from) ||
				!ids.has(link.to) ||
				link.from === link.to
			)
				return false;
			const key = `${link.from}>${link.to}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((link) => ({ ...link, id: idOf(link.id, taken) }));
	return { items, links };
}

// Where new items go when they are added from elsewhere, which is below everything
// already on the board, at its left edge, so nothing is covered.
export function placeBelow(
	definition: BoardDefinition,
	incoming: { w: number; h: number }[],
	gap = 32,
): { x: number; y: number }[] {
	const left = definition.items.length
		? Math.min(...definition.items.map((i) => i.x))
		: 0;
	let y = definition.items.length
		? Math.max(...definition.items.map((i) => i.y + i.h)) + gap
		: 0;
	return incoming.map((size) => {
		const at = { x: left, y };
		y += size.h + gap;
		return at;
	});
}

export function cleanTitle(value: unknown): string {
	return text(value, maxTitle).trim();
}
