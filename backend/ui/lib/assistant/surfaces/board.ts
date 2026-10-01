import {
	cleanDefinition,
	colorNames,
	emptyBoard,
	type BoardDefinition,
	type BoardItem,
	type BoardLink,
	type BoardVisual,
	type ColorName,
	type NoteColor,
	type ShapeKind,
} from "../../boards/definition";
import { isPageControl } from "../../visuals/catalog";
import type { SemanticSource } from "../../semantic/types";
import { buildVisual, editableTypes } from "./editor";
import {
	asRecord,
	describeState,
	filterSchema,
	refusal,
	stringList,
	SurfaceRefused,
	text,
	type Surface,
	type SurfaceTool,
} from "./shared";

// Arranging a board, for the assistant.
//
// The model names what goes on the board and how it connects, and this turns
// that into board items. Each chart is checked against its dataset exactly as
// a chart added to a report page is, every colour and style is one the board
// offers, and anything placed without a position is laid out in rows below
// what is already there. The same building serves the board open on screen,
// whose draft the person sees and can undo, and a new board made from
// anywhere, which the agent saves.

// What each new kind of thing is called when the model asks for it.
type AskedKind = "chart" | "note" | "text" | "box";

const noteColorsAsked = ["yellow", "blue", "green", "pink", "grey"] as const;
const shapesAsked = ["rectangle", "rounded", "ellipse", "diamond"] as const;

// The widest a laid out row runs, and the space kept between things.
const rowWidth = 1880;
const gap = 40;

const sizes: Record<AskedKind, { w: number; h: number }> = {
	chart: { w: 600, h: 400 },
	note: { w: 300, h: 200 },
	text: { w: rowWidth, h: 80 },
	box: { w: 280, h: 140 },
};

const itemSchema = {
	type: "object",
	properties: {
		ref: {
			type: "string",
			description:
				"A short name for this item, used by connect to join it to others.",
		},
		kind: {
			type: "string",
			enum: ["chart", "note", "text", "box"],
			description:
				"chart is a live visual on a dataset. note is a sticky note. text is a heading that spans the board and starts a new row. box is a shape holding a few words, such as a decision or a step.",
		},
		visualType: {
			type: "string",
			enum: editableTypes,
			description: "For a chart.",
		},
		title: { type: "string", description: "For a chart." },
		sourceKey: { type: "string", description: "For a chart." },
		dimensions: { type: "array", items: { type: "string" } },
		measures: { type: "array", items: { type: "string" } },
		filters: { type: "array", items: filterSchema },
		sort: {
			type: "array",
			items: {
				type: "object",
				properties: {
					field: { type: "string" },
					direction: { type: "string", enum: ["asc", "desc"] },
				},
				required: ["field", "direction"],
			},
		},
		text: {
			type: "string",
			description: "What a note, heading or box says.",
		},
		color: {
			type: "string",
			enum: [...noteColorsAsked],
			description: "A note's colour.",
		},
		shape: { type: "string", enum: [...shapesAsked] },
		fill: {
			type: "string",
			enum: colorNames.filter((c) => c !== "none" && c !== "default"),
			description: "A box's colour.",
		},
	},
	required: ["kind"],
};

const linkSchema = {
	type: "object",
	properties: {
		from: {
			type: "string",
			description:
				"The ref of an item added in this call, or an id on the board.",
		},
		to: { type: "string" },
		route: { type: "string", enum: ["straight", "orthogonal", "curved"] },
		line: { type: "string", enum: ["solid", "dashed", "dotted"] },
		flow: {
			type: "boolean",
			description:
				"Dashes moving towards where it points, for a flow of work or money.",
		},
		label: { type: "string" },
	},
	required: ["from", "to"],
};

const contentProperties = {
	add: {
		type: "array",
		items: itemSchema,
		description:
			"Things to put on the board, in reading order. They are laid out in rows, three charts across, with each heading starting a new row.",
	},
	connect: {
		type: "array",
		items: linkSchema,
		description: "Arrows between items.",
	},
};

export const editBoardTool: SurfaceTool = {
	type: "function",
	function: {
		name: "edit_board",
		description:
			"Change the board open on screen. Additions go below what is there. The change is shown at once as one step the person can undo.",
		parameters: {
			type: "object",
			properties: {
				...contentProperties,
				remove: {
					type: "array",
					items: { type: "string" },
					description:
						"Ids of items on the board to take off, with their arrows.",
				},
				rewrite: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							text: { type: "string" },
						},
						required: ["id", "text"],
					},
					description:
						"New words for notes, headings or boxes already on the board.",
				},
			},
		},
	},
};

export const createBoardTool: SurfaceTool = {
	type: "function",
	function: {
		name: "create_board",
		description:
			"Make a new board for the person and save it. Only when they ask for a board, or to build or lay something out for them. Lay it out as a story: a heading, then the charts that answer it, with notes saying what to look at and arrows where one thing leads to another. Run the queries first, so each chart is one you know answers the question.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				...contentProperties,
			},
			required: ["title", "add"],
		},
	},
};

function newId(): string {
	return `i${Math.random().toString(36).slice(2, 10)}`;
}

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
): T | undefined {
	return allowed.includes(value as T) ? (value as T) : undefined;
}

// The lowest edge of what is on the board, which new rows start under.
function bottomOf(definition: BoardDefinition): { left: number; y: number } {
	if (definition.items.length === 0) return { left: 0, y: 0 };
	return {
		left: Math.min(...definition.items.map((i) => i.x)),
		y: Math.max(...definition.items.map((i) => i.y + i.h)) + gap * 2,
	};
}

function buildItem(
	raw: Record<string, unknown>,
	available: SemanticSource[],
	fallbackSource: string | null,
): BoardItem {
	const kind = raw.kind as AskedKind;
	if (!sizes[kind]) {
		throw new SurfaceRefused(
			`"${String(raw.kind ?? "")}" is not something a board holds. Use chart, note, text or box.`,
		);
	}
	const size = sizes[kind];
	if (kind === "chart") {
		const visualType = text(raw.visualType, 60);
		if (isPageControl(visualType)) {
			throw new SurfaceRefused(
				`${visualType} filters a report page and does nothing on a board. Put the filter on the chart instead.`,
			);
		}
		const built = buildVisual(raw, null, fallbackSource, available);
		if (!built.sourceKey) {
			throw new SurfaceRefused(
				"A chart on a board reads a dataset. Name one with sourceKey.",
			);
		}
		return {
			id: newId(),
			kind: "visual",
			x: 0,
			y: 0,
			...size,
			visual: {
				visualType: built.visualType,
				title: built.title,
				sourceKey: built.sourceKey,
				config: built.config as BoardVisual["config"],
			},
			origin: { reportId: null, slug: null, title: "From the assistant" },
		};
	}
	const words = text(raw.text, 2000);
	if (!words) {
		throw new SurfaceRefused(`A ${kind} needs text saying what it says.`);
	}
	if (kind === "note") {
		return {
			id: newId(),
			kind: "note",
			x: 0,
			y: 0,
			...size,
			text: words,
			color: (oneOf(raw.color, noteColorsAsked) ?? "yellow") as NoteColor,
		};
	}
	if (kind === "text") {
		return { id: newId(), kind: "text", x: 0, y: 0, ...size, text: words };
	}
	const fill = oneOf(raw.fill, colorNames) as ColorName | undefined;
	return {
		id: newId(),
		kind: "shape",
		x: 0,
		y: 0,
		...size,
		text: words,
		shape: (oneOf(raw.shape, shapesAsked) ?? "rounded") as ShapeKind,
		style: {
			...(fill ? { fill, stroke: fill } : {}),
			textSize: "medium",
			bold: true,
		},
	};
}

// New items in rows under the board's content. A heading takes a row of its
// own, and anything else fills a row left to right until it is full.
export function layOut(
	definition: BoardDefinition,
	added: BoardItem[],
): BoardItem[] {
	const { left } = bottomOf(definition);
	let { y } = bottomOf(definition);
	let x = left;
	let rowHeight = 0;
	const placed: BoardItem[] = [];
	const newRow = () => {
		if (rowHeight > 0) y += rowHeight + gap;
		x = left;
		rowHeight = 0;
	};
	for (const item of added) {
		if (item.kind === "text") {
			newRow();
			placed.push({ ...item, x, y, w: Math.min(item.w, rowWidth) });
			y += item.h + gap / 2;
			continue;
		}
		if (x > left && x + item.w > left + rowWidth) newRow();
		placed.push({ ...item, x, y });
		x += item.w + gap;
		rowHeight = Math.max(rowHeight, item.h);
	}
	return placed;
}

// A board with the asked for changes made, checked as a saved board is.
export function applyBoardEdit(
	current: BoardDefinition,
	args: Record<string, unknown>,
	available: SemanticSource[],
	fallbackSource: string | null,
): { definition: BoardDefinition; summary: string } {
	let items = [...current.items];
	let links = [...current.links];
	const said: string[] = [];

	const removing = new Set(stringList(args.remove, 200));
	if (removing.size) {
		const before = items.length;
		items = items.filter((i) => !removing.has(i.id));
		links = links.filter(
			(l) => !removing.has(l.from) && !removing.has(l.to),
		);
		if (items.length < before)
			said.push(`removed ${before - items.length}`);
	}

	for (const raw of (Array.isArray(args.rewrite) ? args.rewrite : []).map(
		asRecord,
	)) {
		const id = text(raw.id, 64);
		const target = items.find((i) => i.id === id);
		if (!target || target.kind === "visual") {
			throw new SurfaceRefused(
				`There is no note, heading or box with the id "${id}".`,
			);
		}
		items = items.map((i) =>
			i.id === id ? { ...i, text: text(raw.text, 2000) } : i,
		);
		said.push("rewrote one");
	}

	const refs = new Map<string, string>();
	const asked = (Array.isArray(args.add) ? args.add : [])
		.map(asRecord)
		.slice(0, 40);
	const built = asked.map((raw) => {
		const item = buildItem(raw, available, fallbackSource);
		const ref = text(raw.ref, 64);
		if (ref) refs.set(ref, item.id);
		return item;
	});
	const placed = layOut({ items, links }, built);
	items = [...items, ...placed];
	if (placed.length) said.push(`added ${placed.length}`);

	const ids = new Set(items.map((i) => i.id));
	const resolve = (name: string) =>
		refs.get(name) ?? (ids.has(name) ? name : null);
	for (const raw of (Array.isArray(args.connect) ? args.connect : [])
		.map(asRecord)
		.slice(0, 60)) {
		const from = resolve(text(raw.from, 64));
		const to = resolve(text(raw.to, 64));
		if (!from || !to) {
			throw new SurfaceRefused(
				`An arrow names "${text(raw.from, 64)}" to "${text(raw.to, 64)}", and one of them is not a ref in this call or an id on the board.`,
			);
		}
		const link: BoardLink = { id: newId(), from, to };
		const route = oneOf(raw.route, [
			"straight",
			"orthogonal",
			"curved",
		] as const);
		const line = oneOf(raw.line, ["solid", "dashed", "dotted"] as const);
		if (route) link.route = route;
		if (line) link.line = line;
		if (raw.flow === true) link.flow = true;
		const label = text(raw.label, 200);
		if (label) link.label = label;
		links.push(link);
	}
	const joined =
		links.length - current.links.filter((l) => links.includes(l)).length;
	if (joined) said.push(`joined ${joined} with arrows`);

	if (said.length === 0) {
		throw new SurfaceRefused("Nothing was asked of the board.");
	}
	return {
		definition: cleanDefinition({ items, links }),
		summary: said.join(", "),
	};
}

// What the board on screen holds, as the model reads it. Visuals are named
// by what they show rather than written out whole.
function describeBoard(definition: BoardDefinition): string {
	return describeState({
		items: definition.items.map((i) => ({
			id: i.id,
			kind: i.kind,
			at: [i.x, i.y, i.w, i.h],
			...(i.visual
				? {
						chart: `${i.visual.title ?? i.visual.visualType} on ${i.visual.sourceKey}`,
					}
				: { text: (i.text ?? "").slice(0, 200) }),
		})),
		arrows: definition.links.map((l) => ({ from: l.from, to: l.to })),
	});
}

export function boardSurface(
	raw: unknown,
	available: SemanticSource[],
): Surface {
	const state = asRecord(raw);
	const current = cleanDefinition(state.definition);
	const firstSource =
		current.items.find((i) => i.visual)?.visual?.sourceKey ?? null;
	return {
		kind: "board",
		instructions: [
			"The person has a board open: a canvas of live charts, notes, headings, boxes and arrows.",
			`It is called "${text(state.title, 160)}" and holds: ${describeBoard(current)}`,
			"To change it, call edit_board. Run queries first so each chart you add is one you know answers the question. Add charts with the same visual types and fields a report uses. Write notes that say what to look at, not what the chart already shows. Use arrows where one thing leads to another.",
		].join("\n"),
		tools: [editBoardTool],
		preferredSourceKey: firstSource,
		label: () => "Arranging the board",
		run: (_name, args) => {
			try {
				const { definition, summary } = applyBoardEdit(
					current,
					args,
					available,
					firstSource,
				);
				return {
					ok: true,
					summary: `Board ${summary}`,
					result: `Done: ${summary}. The board now holds ${definition.items.length} items.`,
					draft: definition,
				};
			} catch (error) {
				return refusal(error);
			}
		},
	};
}

// A new board's contents from what the model asked for.
export function buildNewBoard(
	args: Record<string, unknown>,
	available: SemanticSource[],
	fallbackSource: string | null,
): { title: string; definition: BoardDefinition } {
	const title = text(args.title, 160);
	if (!title) throw new SurfaceRefused("Give the board a title.");
	const { definition } = applyBoardEdit(
		emptyBoard(),
		args,
		available,
		fallbackSource,
	);
	return { title, definition };
}
