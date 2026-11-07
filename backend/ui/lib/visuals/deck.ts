import type { Rect } from "./layout";
import { fieldParam, packClauses } from "./shareState";

// One engine behind walkthroughs and slides. Both are an
// ordered list of steps moved through with Next and Back. They differ in what a step
// draws, which is the real page or a chosen set of visuals.
//
// Pure, so the rules can be tested and the server can clean what it is sent.

export type DeckKind = "walkthrough" | "slides";

// A mark drawn on a visual, during a tour or kept on the page.
export type MarkKind = "highlight" | "callout" | "arrow";

export interface VisualMark {
	id: string;
	visualId: string;
	kind: MarkKind;
	text: string;
}

export interface DeckStep {
	id: string;
	title: string;
	text: string;
	// The page this step is on.
	pageId: string | null;
	// The visual a walkthrough spotlights.
	visualId: string | null;
	// What the page's filters are set to, by field.
	filters: Record<string, string[]>;
	mark: MarkKind | null;
	// What a slide shows, one for each place in its layout. An empty place is an empty string.
	visualIds: string[];
	// How a slide is arranged. Absent on a slide made before layouts, which arranges itself.
	layout?: string | null;
}

export interface Deck {
	deckId: string;
	kind: DeckKind;
	title: string;
	steps: DeckStep[];
	// Offered once to each reader on arriving at the report.
	promptOnce: boolean;
	// Raised to offer it to everybody again, as after republishing.
	epoch: number;
	// The field a viewer picks a record from, for a deck about one customer.
	recordField: string | null;
	recordSource: string | null;
	// Whether the slides wait until a record is chosen.
	requireRecord: boolean;
}

const markKinds: MarkKind[] = ["highlight", "callout", "arrow"];

function text(value: unknown, limit: number): string {
	return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function textOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanFilters(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object") return {};
	const out: Record<string, string[]> = {};
	for (const [field, values] of Object.entries(value)) {
		if (!Array.isArray(values)) continue;
		const kept = values.filter(
			(v): v is string => typeof v === "string" && v.trim() !== "",
		);
		if (kept.length > 0) out[field] = kept;
	}
	return out;
}

export function isMarkKind(value: unknown): value is MarkKind {
	return markKinds.includes(value as MarkKind);
}

export function cleanStep(value: unknown, newId: () => string): DeckStep {
	const raw = (value ?? {}) as Record<string, unknown>;
	return {
		id: textOrNull(raw.id) ?? newId(),
		title: text(raw.title, 200),
		text: text(raw.text, 2000),
		pageId: textOrNull(raw.pageId),
		visualId: textOrNull(raw.visualId),
		filters: cleanFilters(raw.filters),
		mark: isMarkKind(raw.mark) ? raw.mark : null,
		visualIds: Array.isArray(raw.visualIds)
			? raw.visualIds.filter((v): v is string => typeof v === "string")
			: [],
		layout: slideLayouts.some((held) => held.id === raw.layout)
			? (raw.layout as string)
			: null,
	};
}

// What the server keeps of a deck somebody sent, so nothing else has to doubt it.
export function cleanDeckInput(
	value: unknown,
	newId: () => string,
): Omit<Deck, "deckId" | "epoch"> {
	const raw = (value ?? {}) as Record<string, unknown>;
	return {
		kind: raw.kind === "slides" ? "slides" : "walkthrough",
		title: text(raw.title, 200) || "Untitled",
		steps: Array.isArray(raw.steps)
			? raw.steps.map((step) => cleanStep(step, newId))
			: [],
		promptOnce: raw.promptOnce === true,
		recordField: textOrNull(raw.recordField),
		recordSource: textOrNull(raw.recordSource),
		requireRecord: raw.requireRecord === true,
	};
}

// Moving through a deck stops at its ends rather than wrapping, so pressing Next too
// many times cannot land somebody back on the first step.
export function stepIndex(index: number, count: number): number {
	return Math.max(0, Math.min(index, count - 1));
}

// A step's filters as the parameters a link would carry, which is what the page
// already knows how to open on.
export function stepParams(filters: Record<string, string[]>): string {
	const params = new URLSearchParams();
	for (const [field, values] of Object.entries(filters)) {
		const packed = packClauses([{ field, op: "eq", values }]);
		if (packed) params.set(fieldParam(field), packed);
	}
	return params.toString();
}

// Whether to offer this deck to someone arriving at the report.
export function shouldOffer(
	deck: Pick<Deck, "promptOnce" | "epoch" | "steps">,
	seenEpoch: number | null | undefined,
): boolean {
	if (!deck.promptOnce || deck.steps.length === 0) return false;
	return (
		seenEpoch === null || seenEpoch === undefined || seenEpoch < deck.epoch
	);
}

// Slide visuals on a twelve column grid, filling the width with even rows.
export interface SlideLayout {
	id: string;
	label: string;
	// Where each place sits, on twelve columns and ten rows.
	rects: Rect[];
	// The slide's words sit beside what it shows rather than above it.
	textBeside?: boolean;
}

export const slideLayouts: SlideLayout[] = [
	{ id: "title", label: "Title only", rects: [] },
	{
		id: "one",
		label: "One visual",
		rects: [{ x: 0, y: 0, w: 12, h: 10 }],
	},
	{
		id: "textAndOne",
		label: "Words beside one visual",
		textBeside: true,
		rects: [{ x: 0, y: 0, w: 12, h: 10 }],
	},
	{
		id: "two",
		label: "Two side by side",
		rects: [
			{ x: 0, y: 0, w: 6, h: 10 },
			{ x: 6, y: 0, w: 6, h: 10 },
		],
	},
	{
		id: "oneOverTwo",
		label: "One above two",
		rects: [
			{ x: 0, y: 0, w: 12, h: 4 },
			{ x: 0, y: 4, w: 6, h: 6 },
			{ x: 6, y: 4, w: 6, h: 6 },
		],
	},
	{
		id: "three",
		label: "Three across",
		rects: [
			{ x: 0, y: 0, w: 4, h: 10 },
			{ x: 4, y: 0, w: 4, h: 10 },
			{ x: 8, y: 0, w: 4, h: 10 },
		],
	},
	{
		id: "four",
		label: "Four in a grid",
		rects: [
			{ x: 0, y: 0, w: 6, h: 5 },
			{ x: 6, y: 0, w: 6, h: 5 },
			{ x: 0, y: 5, w: 6, h: 5 },
			{ x: 6, y: 5, w: 6, h: 5 },
		],
	},
];

export function slideSlots(layout: string | null | undefined): number {
	return slideLayouts.find((held) => held.id === layout)?.rects.length ?? 0;
}

// What a slide draws, with empty places left out but holding their position. Laid out by its
// chosen layout, or by how many visuals it has if it has none.
export function placeSlide(step: {
	layout?: string | null;
	visualIds: string[];
}): { visualId: string; rect: Rect }[] {
	const layout = slideLayouts.find((held) => held.id === step.layout);
	if (!layout) {
		const chosen = step.visualIds.filter(Boolean);
		const rects = slideLayout(chosen.length);
		return chosen.map((visualId, index) => ({
			visualId,
			rect: rects[index],
		}));
	}
	return layout.rects.flatMap((rect, index) => {
		const visualId = step.visualIds[index];
		return visualId ? [{ visualId, rect }] : [];
	});
}

export function slideLayout(count: number): Rect[] {
	const columns = count <= 1 ? 1 : count <= 4 ? 2 : 3;
	const width = Math.floor(12 / columns);
	const height = count <= 2 ? 10 : 7;
	return Array.from({ length: count }, (_, index) => ({
		x: (index % columns) * width,
		y: Math.floor(index / columns) * height,
		w: width,
		h: height,
	}));
}

// Where a step's explanation sits: below the visual if there is room, else above,
// else over it, always kept on screen.
export function popoverPosition(
	target: { top: number; left: number; width: number; height: number } | null,
	popover: { width: number; height: number },
	viewport: { width: number; height: number },
	gap = 16,
): { top: number; left: number } {
	const clampLeft = (left: number) =>
		Math.max(gap, Math.min(left, viewport.width - popover.width - gap));
	const clampTop = (top: number) =>
		Math.max(gap, Math.min(top, viewport.height - popover.height - gap));

	if (!target) {
		return {
			top: clampTop((viewport.height - popover.height) / 2),
			left: clampLeft((viewport.width - popover.width) / 2),
		};
	}
	const below = target.top + target.height + gap;
	const above = target.top - popover.height - gap;
	const top =
		below + popover.height + gap <= viewport.height
			? below
			: above >= gap
				? above
				: clampTop(viewport.height - popover.height - gap);
	return { top, left: clampLeft(target.left) };
}

export interface DraftReport {
	title: string;
	description: string | null;
	pages: {
		pageId: string;
		title: string;
		visuals: {
			visualId: string;
			visualType: string;
			title: string | null;
			config: unknown;
		}[];
	}[];
}

// Pulls the steps out of an answer that may have words around them.
export function parseDraft(
	answer: string,
	report: DraftReport,
	newId: () => string,
): DeckStep[] {
	const start = answer.indexOf("[");
	const end = answer.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(answer.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const pageOf = new Map<string, string>();
	for (const page of report.pages) {
		for (const visual of page.visuals) {
			pageOf.set(visual.visualId, page.pageId);
		}
	}
	return parsed.flatMap((raw) => {
		const visualId = (raw as { visualId?: unknown })?.visualId;
		// Anything naming a visual the report does not have is dropped, so a
		// made up id cannot leave a step pointing at nothing.
		if (typeof visualId !== "string" || !pageOf.has(visualId)) return [];
		return [
			cleanStep(
				{
					title: (raw as { title?: unknown }).title,
					text: (raw as { text?: unknown }).text,
					visualId,
					pageId: pageOf.get(visualId),
				},
				newId,
			),
		];
	});
}
