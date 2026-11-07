import type { Snapshot, SnapshotPage, SnapshotVisual } from "./versionDiff";

// A report as it would stand if a suggestion were approved, worked out from a copy of it
// without touching anything. Pure, so what a reviewer is shown can be tested against what
// approving does.

interface PreviewOperation {
	type: string;
	visualId?: string;
	pageId?: string;
	pageIds?: string[];
	visualIds?: string[];
	visualType?: string;
	title?: string | null;
	description?: string | null;
	theme?: string;
	sourceKey?: string | null;
	slug?: string;
	config?: Record<string, unknown>;
	layout?: { x: number; y: number; w: number; h: number };
}

function same(
	left: string | undefined | null,
	right: string | undefined | null,
) {
	return (
		String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase()
	);
}

export function applyToSnapshot(
	snapshot: Snapshot,
	operations: PreviewOperation[],
): Snapshot {
	let visuals: SnapshotVisual[] = (snapshot.visuals ?? []).map((v) => ({
		...v,
	}));
	let pages: SnapshotPage[] = (snapshot.pages ?? []).map((p) => ({ ...p }));
	const report = { ...(snapshot.report ?? {}) };

	const placed = (
		op: PreviewOperation,
	): Pick<
		SnapshotVisual,
		"layout_x" | "layout_y" | "layout_w" | "layout_h"
	> =>
		op.layout
			? {
					layout_x: op.layout.x,
					layout_y: op.layout.y,
					layout_w: op.layout.w,
					layout_h: op.layout.h,
				}
			: {};

	for (const op of operations) {
		switch (op.type) {
			case "addVisual":
				visuals.push({
					visual_id: op.visualId ?? `new-${visuals.length}`,
					page_id: op.pageId,
					visual_type: op.visualType,
					title: op.title ?? null,
					source_key: op.sourceKey ?? null,
					config: op.config ?? {},
					sort_order: visuals.length,
					is_active: true,
					...placed(op),
				});
				break;
			case "updateVisual":
				visuals = visuals.map((visual) =>
					same(visual.visual_id, op.visualId)
						? {
								...visual,
								...(op.title !== undefined
									? { title: op.title }
									: {}),
								...(op.visualType
									? { visual_type: op.visualType }
									: {}),
								...(op.sourceKey !== undefined
									? { source_key: op.sourceKey }
									: {}),
								...(op.config ? { config: op.config } : {}),
								...placed(op),
							}
						: visual,
				);
				break;
			case "removeVisual":
				visuals = visuals.map((visual) =>
					same(visual.visual_id, op.visualId)
						? { ...visual, is_active: false }
						: visual,
				);
				break;
			case "reorderVisuals":
				(op.visualIds ?? []).forEach((id, order) => {
					visuals = visuals.map((visual) =>
						same(visual.visual_id, id)
							? { ...visual, sort_order: order }
							: visual,
					);
				});
				break;
			case "updateReport":
				if (op.title !== undefined) report.title = op.title;
				if (op.description !== undefined) {
					report.description = op.description;
				}
				if (op.theme !== undefined) report.theme = op.theme || null;
				break;
			case "updatePage":
				pages = pages.map((page) =>
					same(page.page_id, op.pageId)
						? {
								...page,
								...(op.title !== undefined
									? { title: op.title }
									: {}),
								...(op.config
									? {
											config: {
												...(page.config ?? {}),
												...op.config,
											},
										}
									: {}),
							}
						: page,
				);
				break;
			case "addPage":
				pages.push({
					page_id: op.pageId ?? `new-page-${pages.length}`,
					title: op.title ?? "",
					slug: op.slug ?? null,
					source_key: op.sourceKey ?? null,
					config: {},
					sort_order: pages.length,
					is_active: true,
				});
				break;
			case "removePage":
				pages = pages.map((page) =>
					same(page.page_id, op.pageId)
						? { ...page, is_active: false }
						: page,
				);
				break;
			case "reorderPages":
				(op.pageIds ?? []).forEach((id, order) => {
					pages = pages.map((page) =>
						same(page.page_id, id)
							? { ...page, sort_order: order }
							: page,
					);
				});
				break;
		}
	}
	return { visuals, pages, report };
}
