// What changed between two saved versions of a report.
//
// Derived by comparing snapshots rather than by reading the operation log.
// The log says what was sent; the snapshots say what the report actually
// became, which is the question someone reading a history is asking. It also
// keeps working for a change that arrived some other way, such as a restore,
// and it cannot drift as the operation types grow.
//
// The wording is deliberately about the report rather than about the database:
// "Widened Contracts" rather than "layout_w 6 to 12". Someone opening a history
// wants to know whether to roll it back, not to read a changelog of columns.

export interface SnapshotVisual {
	visual_id: string;
	page_id?: string | null;
	visual_type?: string | null;
	title?: string | null;
	source_key?: string | null;
	config?: Record<string, unknown> | null;
	layout_x?: number | null;
	layout_y?: number | null;
	layout_w?: number | null;
	layout_h?: number | null;
	sort_order?: number | null;
	is_active?: boolean | null;
}

export interface SnapshotPage {
	page_id: string;
	title?: string | null;
	config?: Record<string, unknown> | null;
	is_active?: boolean | null;
}

export interface Snapshot {
	visuals?: SnapshotVisual[];
	pages?: SnapshotPage[];
	report?: { title?: string | null; description?: string | null } | null;
}

export interface Change {
	// Groups the entry in the UI and decides its icon.
	kind: "added" | "removed" | "changed" | "moved" | "renamed";
	// One line, written for a person.
	text: string;
	// Which visual it concerns, so the history can point at it.
	visualId?: string;
}

function label(visual: SnapshotVisual | undefined): string {
	if (!visual) return "a visual";
	const title = visual.title?.trim();
	// Slot names from the planning documents are not titles. "table" tells a
	// reader nothing, so the type is used instead.
	const looksLikeSlot = !title || /^[a-z]+$/.test(title);
	return looksLikeSlot ? readableType(visual.visual_type) : `"${title}"`;
}

function readableType(type: string | null | undefined): string {
	if (!type) return "a visual";
	const spaced = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	return `the ${spaced}`;
}

function fieldList(config: Record<string, unknown> | null | undefined, key: string): string[] {
	const value = config?.[key];
	return Array.isArray(value) ? value.map(String) : [];
}

function listPhrase(items: string[]): string {
	if (items.length === 1) return items[0];
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function activeVisuals(snapshot: Snapshot | null): Map<string, SnapshotVisual> {
	const map = new Map<string, SnapshotVisual>();
	for (const visual of snapshot?.visuals ?? []) {
		if (visual.is_active === false) continue;
		map.set(visual.visual_id, visual);
	}
	return map;
}

export function diffSnapshots(
	previous: Snapshot | null,
	next: Snapshot | null,
): Change[] {
	const before = activeVisuals(previous);
	const after = activeVisuals(next);
	const changes: Change[] = [];

	// The first version has nothing to compare against. Listing every visual
	// as an addition would be noise, so it is described as what it is.
	if (!previous) {
		return [{ kind: "added", text: "Created the report" }];
	}

	for (const [id, visual] of after) {
		if (!before.has(id)) {
			changes.push({
				kind: "added",
				text: `Added ${label(visual)}`,
				visualId: id,
			});
		}
	}

	for (const [id, visual] of before) {
		if (!after.has(id)) {
			changes.push({
				kind: "removed",
				text: `Removed ${label(visual)}`,
				visualId: id,
			});
		}
	}

	for (const [id, now] of after) {
		const was = before.get(id);
		if (!was) continue;

		if ((was.title ?? "") !== (now.title ?? "")) {
			changes.push({
				kind: "renamed",
				text: `Renamed ${label(was)} to ${label(now)}`,
				visualId: id,
			});
		}

		if ((was.visual_type ?? "") !== (now.visual_type ?? "")) {
			changes.push({
				kind: "changed",
				text: `Changed ${label(now)} from ${readableType(was.visual_type)} to ${readableType(now.visual_type)}`,
				visualId: id,
			});
		}

		if ((was.source_key ?? "") !== (now.source_key ?? "")) {
			changes.push({
				kind: "changed",
				text: `Pointed ${label(now)} at ${now.source_key ?? "no source"}`,
				visualId: id,
			});
		}

		for (const key of ["dimensions", "measures"] as const) {
			const wasFields = fieldList(was.config, key);
			const nowFields = fieldList(now.config, key);
			const added = nowFields.filter((f) => !wasFields.includes(f));
			const removed = wasFields.filter((f) => !nowFields.includes(f));

			if (added.length > 0) {
				changes.push({
					kind: "changed",
					text: `Added ${listPhrase(added)} to ${label(now)}`,
					visualId: id,
				});
			}
			if (removed.length > 0) {
				changes.push({
					kind: "changed",
					text: `Removed ${listPhrase(removed)} from ${label(now)}`,
					visualId: id,
				});
			}
			// Same fields in a different order is a real change to a table,
			// where the order is the column order.
			if (
				added.length === 0 &&
				removed.length === 0 &&
				wasFields.join("\u0000") !== nowFields.join("\u0000")
			) {
				changes.push({
					kind: "changed",
					text: `Reordered the ${key} on ${label(now)}`,
					visualId: id,
				});
			}
		}

		const movedTo =
			was.layout_x !== now.layout_x || was.layout_y !== now.layout_y;
		const resized =
			was.layout_w !== now.layout_w || was.layout_h !== now.layout_h;

		if (movedTo && resized) {
			changes.push({
				kind: "moved",
				text: `Moved and resized ${label(now)}`,
				visualId: id,
			});
		} else if (movedTo) {
			changes.push({ kind: "moved", text: `Moved ${label(now)}`, visualId: id });
		} else if (resized) {
			changes.push({
				kind: "moved",
				text: `Resized ${label(now)}`,
				visualId: id,
			});
		}

		// Styling is compared as a whole. Naming which of forty style
		// properties moved would be a worse summary than saying it was
		// restyled, and the version is there to be opened if someone needs the
		// detail.
		if (
			JSON.stringify(was.config?.style ?? null) !==
			JSON.stringify(now.config?.style ?? null)
		) {
			changes.push({
				kind: "changed",
				text: `Restyled ${label(now)}`,
				visualId: id,
			});
		}

		if (
			JSON.stringify(was.config?.options ?? null) !==
			JSON.stringify(now.config?.options ?? null)
		) {
			changes.push({
				kind: "changed",
				text: `Changed the options on ${label(now)}`,
				visualId: id,
			});
		}
	}

	// Page and report level changes.
	const pagesBefore = new Map(
		(previous?.pages ?? []).map((p) => [p.page_id, p]),
	);
	for (const page of next?.pages ?? []) {
		const was = pagesBefore.get(page.page_id);
		if (!was) continue;
		if ((was.title ?? "") !== (page.title ?? "")) {
			changes.push({
				kind: "renamed",
				text: `Renamed the page to "${page.title}"`,
			});
		}
		if (
			JSON.stringify(was.config ?? null) !== JSON.stringify(page.config ?? null)
		) {
			changes.push({ kind: "changed", text: "Changed the page settings" });
		}
	}

	const reportBefore = previous?.report;
	const reportAfter = next?.report;
	if (reportBefore && reportAfter) {
		if ((reportBefore.title ?? "") !== (reportAfter.title ?? "")) {
			changes.push({
				kind: "renamed",
				text: `Renamed the report to "${reportAfter.title}"`,
			});
		}
		if ((reportBefore.description ?? "") !== (reportAfter.description ?? "")) {
			changes.push({ kind: "changed", text: "Changed the subtitle" });
		}
	}

	// A save that produced no visible difference still happened, and saying so
	// is better than an entry with nothing under it.
	if (changes.length === 0) {
		return [{ kind: "changed", text: "Saved with no visible change" }];
	}

	return changes;
}
