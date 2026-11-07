import type { Rect } from "./layout";

// A block is a set of visuals saved once and placed in any number of reports. Each
// placed visual is an ordinary row carrying a reference back, so everything that
// reads a report keeps reading one place. Updating the block rewrites those rows.
//
// Pure, so what an update does to a page can be tested.

export interface BlockVisual {
	key: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: Record<string, unknown>;
	layout: Rect;
}

export interface BlockRef {
	blockId: string;
	key: string;
	// One drop of the block on a page, so a page holding it twice keeps both apart.
	placementId: string;
	// Where that drop started, for a visual the block gains later.
	origin: { x: number; y: number };
}

interface SourceVisual {
	visualType: string;
	title: string | null;
	sourceKey?: string | null;
	config: Record<string, unknown>;
	layout: Rect;
}

export function blockRefOf(config: unknown): BlockRef | null {
	const ref = (config as { blockRef?: Partial<BlockRef> } | null)?.blockRef;
	return ref && ref.blockId && ref.key && ref.placementId
		? (ref as BlockRef)
		: null;
}

export function withoutBlockRef(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const { blockRef: _dropped, ...rest } = config;
	return rest;
}

// The block's own copy of a selection, measured from its top left corner.
export function visualsToBlock(
	visuals: SourceVisual[],
	newKey: () => string,
): BlockVisual[] {
	const left = Math.min(...visuals.map((v) => v.layout.x));
	const top = Math.min(...visuals.map((v) => v.layout.y));
	return visuals.map((visual) => ({
		key: newKey(),
		visualType: visual.visualType,
		title: visual.title,
		sourceKey: visual.sourceKey ?? null,
		config: withoutBlockRef(visual.config),
		layout: {
			...visual.layout,
			x: visual.layout.x - left,
			y: visual.layout.y - top,
		},
	}));
}

// Dropping the block on a page, with each visual linked back to it.
export function placeBlock(
	blockId: string,
	visuals: BlockVisual[],
	origin: { x: number; y: number },
	ids: { placementId: string; visualId: () => string },
): {
	visualId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: Record<string, unknown>;
	layout: Rect;
}[] {
	return visuals.map((visual) => ({
		visualId: ids.visualId(),
		visualType: visual.visualType,
		title: visual.title,
		sourceKey: visual.sourceKey,
		config: {
			...visual.config,
			blockRef: {
				blockId,
				key: visual.key,
				placementId: ids.placementId,
				origin,
			} satisfies BlockRef,
		},
		layout: {
			...visual.layout,
			x: origin.x + visual.layout.x,
			y: origin.y + visual.layout.y,
		},
	}));
}

export interface PlacedVisual {
	visualId: string;
	pageId: string;
	config: unknown;
}

// What an updated block does to the visuals already placed from it. Where somebody
// has moved or resized a placed visual stays theirs, and the rest follows the block.
export function planBlockUpdate(
	blockId: string,
	visuals: BlockVisual[],
	placed: PlacedVisual[],
): {
	updates: { visualId: string; visual: BlockVisual; ref: BlockRef }[];
	removes: string[];
	inserts: {
		pageId: string;
		visual: BlockVisual;
		ref: BlockRef;
		layout: Rect;
	}[];
} {
	const byKey = new Map(visuals.map((visual) => [visual.key, visual]));
	const updates: {
		visualId: string;
		visual: BlockVisual;
		ref: BlockRef;
	}[] = [];
	const removes: string[] = [];
	const placements = new Map<
		string,
		{ pageId: string; origin: BlockRef["origin"]; keys: Set<string> }
	>();

	for (const row of placed) {
		const ref = blockRefOf(row.config);
		if (!ref || ref.blockId !== blockId) continue;
		const placement = placements.get(ref.placementId) ?? {
			pageId: row.pageId,
			origin: ref.origin ?? { x: 0, y: 0 },
			keys: new Set<string>(),
		};
		placement.keys.add(ref.key);
		placements.set(ref.placementId, placement);

		const visual = byKey.get(ref.key);
		if (visual) updates.push({ visualId: row.visualId, visual, ref });
		else removes.push(row.visualId);
	}

	const inserts: {
		pageId: string;
		visual: BlockVisual;
		ref: BlockRef;
		layout: Rect;
	}[] = [];
	for (const [placementId, placement] of placements) {
		for (const visual of visuals) {
			if (placement.keys.has(visual.key)) continue;
			inserts.push({
				pageId: placement.pageId,
				visual,
				ref: {
					blockId,
					key: visual.key,
					placementId,
					origin: placement.origin,
				},
				layout: {
					...visual.layout,
					x: placement.origin.x + visual.layout.x,
					y: placement.origin.y + visual.layout.y,
				},
			});
		}
	}
	return { updates, removes, inserts };
}
