import { visualByType, type VisualOption } from "../visuals/catalog";
import { textOf } from "../visuals/wordDiff";
import type { Snapshot, SnapshotPage, SnapshotVisual } from "./versionDiff";

// Two versions of a report set against each other, property by property.
//
// The history list already says what a save changed in a sentence. That answers
// "should this be rolled back" and stops short of "what exactly did it do to
// the sort order", which is the question that follows it. This is the second
// answer: the old value on one side, the new one on the other, one row per
// property, in the shape a diff is normally read in.
//
// Both sides are derived from the stored snapshots rather than from the
// operation log, for the reason the summary is. The snapshots say what the
// report became, they stay right for a change that arrived as a restore, and
// they cannot drift as the operation types grow.
//
// Every property a visual carries gets a row, including the ones that did not
// move. A reader who wants only the differences is the common case and gets
// them by default, but the unchanged rows are what make this readable as a
// straight side by side of two definitions.

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface FieldRow {
	label: string;
	// Already formatted for reading. An empty string means the property was
	// not set on that side, which is drawn as a blank cell rather than as the
	// word "none", because "none" is a value several of these can take.
	before: string;
	after: string;
	changed: boolean;
	// Prose rather than a setting: a title, a note, the body of a text panel.
	// Worth comparing word by word, which is the only way a reworded sentence
	// is legible as a change rather than as two paragraphs to read twice.
	prose?: boolean;
}

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

// One side's copy of a visual: the whole definition, not a description of it.
//
// The panel draws both versions of the page with the same renderer a reader
// gets, so what it needs is what a reader needs. Anything less and the picture
// would be an impression of the page rather than the page.
export interface VisualSide {
	visualId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: Record<string, unknown>;
	pageId: string;
	layout: Box;
	// A readable name and the catalogue's label for the type, for the badge
	// and the tooltip over it.
	name: string;
	type: string;
}

export interface VisualDiff {
	visualId: string;
	status: DiffStatus;
	before: VisualSide | null;
	after: VisualSide | null;
	fields: FieldRow[];
}

export interface PageDiff {
	pageId: string;
	// What to call it: the newer name, or the older one if the page has gone.
	title: string;
	// The name on each side, or null where the page is not on that side at
	// all. Two names that differ is a rename, and null on one side is the page
	// being created or deleted, which is the one thing two copies of a page
	// cannot show by themselves.
	titleBefore: string | null;
	titleAfter: string | null;
	status: DiffStatus;
	fields: FieldRow[];
	// How many visuals on this page are not unchanged, so a page nothing
	// happened on can be left out without walking the list again.
	touched: number;
}

export interface VersionDiff {
	// Null where the version being read is the first one there is.
	from: number | null;
	to: number;
	// Whether each snapshot recorded its pages at all. Snapshots written
	// before pages went into them carry only visuals, and a page missing from
	// one of those was not deleted, it was never written down. Saying a page
	// was created on that evidence would be a claim about a save that never
	// made one.
	pagesRecorded: { before: boolean; after: boolean };
	report: FieldRow[];
	pages: PageDiff[];
	visuals: VisualDiff[];
	counts: {
		added: number;
		removed: number;
		changed: number;
		unchanged: number;
	};
}

function spaced(key: string): string {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function titled(key: string): string {
	const words = spaced(key);
	return words.charAt(0).toUpperCase() + words.slice(1);
}

// A value that can stand on its own in a cell. Anything else returns an empty
// string and is left to summarise.
function scalar(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "on" : "off";
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(value) : "";
	}
	if (typeof value === "string") return value.trim();
	return "";
}

// An object or a list written out far enough to tell two of them apart. A list
// of names is named, a list of records is counted, and an object contributes
// whichever of its properties are scalars, which covers an axis or a legend
// setting without a formatter written for each one.
function summarise(value: unknown, unit?: [string, string]): string {
	const flat = scalar(value);
	if (flat !== "") return flat;

	if (Array.isArray(value)) {
		if (value.length === 0) return "";
		const plain = value.every(
			(entry) => typeof entry === "string" || typeof entry === "number",
		);
		if (plain) return value.map(String).join(", ");
		const [one, many] = unit ?? ["entry", "entries"];
		return value.length === 1 ? `1 ${one}` : `${value.length} ${many}`;
	}

	if (value && typeof value === "object") {
		const parts: string[] = [];
		for (const [key, inner] of Object.entries(value)) {
			const text = scalar(inner);
			if (text !== "") parts.push(`${spaced(key)} ${text}`);
		}
		return parts.join(", ");
	}

	return "";
}

function nameList(value: unknown): string {
	return Array.isArray(value) ? value.map(String).join(", ") : "";
}

function keysOf(value: unknown): string[] {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.keys(value)
		: [];
}

function valueAt(holder: unknown, key: string): unknown {
	if (!holder || typeof holder !== "object") return undefined;
	return (holder as Record<string, unknown>)[key];
}

function bothKeys(before: unknown, after: unknown): string[] {
	const seen = new Set<string>([...keysOf(before), ...keysOf(after)]);
	return [...seen].sort();
}

function typeLabel(type: string | null | undefined): string {
	if (!type) return "";
	return visualByType[type]?.label ?? titled(type);
}

function declaredOption(
	type: string | null | undefined,
	key: string,
): VisualOption | undefined {
	if (!type) return undefined;
	return visualByType[type]?.options?.find((option) => option.key === key);
}

// The label the option is offered under in the properties panel, so a row
// names the control the author actually moved. The rich text a panel holds is
// stored under a key that was never declared as an option, so it is named here
// rather than coming back as "Html".
const undeclaredLabels: Record<string, string> = {
	html: "Text",
	body: "Text",
	markdown: "Text",
	note: "Note",
};

function optionLabel(type: string | null | undefined, key: string): string {
	return (
		declaredOption(type, key)?.label ?? undeclaredLabels[key] ?? titled(key)
	);
}

function optionText(
	type: string | null | undefined,
	key: string,
	value: unknown,
): string {
	const declared = declaredOption(type, key);
	if (declared?.kind === "select" && typeof value === "string") {
		const choice = declared.choices.find((c) => c.value === value);
		if (choice) return choice.label;
	}
	// A text panel stores rich text, and a diff of the markup would report
	// changes in tags nobody typed. What it says is what changed.
	if (richText.has(key) && typeof value === "string") return textOf(value);
	return summarise(value);
}

// Options that hold prose rather than a setting. Two are stored under keys the
// catalogue does not declare, so neither can be recognised by its declaration.
const richText = new Set(["html", "body", "markdown"]);
const noteKeys = new Set(["note", "caption", "placeholder"]);

function isProse(type: string | null | undefined, key: string): boolean {
	if (richText.has(key) || noteKeys.has(key)) return true;
	return declaredOption(type, key)?.kind === "text";
}

const styleLabels: Record<string, string> = {
	palette: "Palette",
	series: "Series colours",
	conditions: "Conditional formatting",
	colorScales: "Colour scales",
	tooltip: "Tooltip",
	xAxis: "X axis",
	yAxis: "Y axis",
	rightAxis: "Right axis",
	legend: "Legend",
	cornerRadius: "Corner radius",
	stripedRows: "Striped rows",
	loadingAnimation: "Loading animation",
};

// What the records in a style list are called, so a count says what it counted
// rather than reporting two entries of something unnamed.
const styleUnits: Record<string, [string, string]> = {
	series: ["series", "series"],
	conditions: ["rule", "rules"],
	colorScales: ["scale", "scales"],
};

// One clause per line. A filter list read as a single run of text is the one
// place where the two columns stop being comparable at a glance.
function filterText(value: unknown): string {
	if (!Array.isArray(value) || value.length === 0) return "";
	return value
		.map((clause) => {
			if (!clause || typeof clause !== "object") return "";
			const parts = clause as {
				field?: unknown;
				op?: unknown;
				value?: unknown;
				values?: unknown;
			};
			const target = Array.isArray(parts.values)
				? parts.values.map(String).join(", ")
				: scalar(parts.value);
			return [scalar(parts.field), scalar(parts.op), target]
				.filter((part) => part !== "")
				.join(" ");
		})
		.filter((line) => line !== "")
		.join("\n");
}

function sortText(value: unknown): string {
	if (!Array.isArray(value) || value.length === 0) return "";
	return value
		.map((entry) => {
			const rule = entry as { field?: unknown; direction?: unknown };
			const field = scalar(rule?.field);
			if (field === "") return "";
			const way = rule?.direction === "desc" ? "descending" : "ascending";
			return `${field} ${way}`;
		})
		.filter((line) => line !== "")
		.join("\n");
}

function box(visual: SnapshotVisual | null): Box {
	return {
		x: visual?.layout_x ?? 0,
		y: visual?.layout_y ?? 0,
		w: visual?.layout_w ?? 6,
		h: visual?.layout_h ?? 4,
	};
}

function positionText(visual: SnapshotVisual | null): string {
	if (!visual) return "";
	const at = box(visual);
	return `column ${at.x + 1}, row ${at.y + 1}`;
}

function sizeText(visual: SnapshotVisual | null): string {
	if (!visual) return "";
	const at = box(visual);
	return `${at.w} wide by ${at.h} tall`;
}

function field(
	label: string,
	before: string,
	after: string,
	prose = false,
): FieldRow | null {
	// A property neither side sets is not a row. Reporting forty of those for
	// every visual would bury the ones carrying something.
	if (before === "" && after === "") return null;
	const row: FieldRow = { label, before, after, changed: before !== after };
	if (prose) row.prose = true;
	return row;
}

function activeVisuals(snapshot: Snapshot | null): Map<string, SnapshotVisual> {
	const map = new Map<string, SnapshotVisual>();
	for (const visual of snapshot?.visuals ?? []) {
		if (visual.is_active === false) continue;
		map.set(visual.visual_id, visual);
	}
	return map;
}

function activePages(snapshot: Snapshot | null): Map<string, SnapshotPage> {
	const map = new Map<string, SnapshotPage>();
	for (const page of snapshot?.pages ?? []) {
		if (page.is_active === false) continue;
		map.set(page.page_id, page);
	}
	return map;
}

function visualName(visual: SnapshotVisual | null): string {
	const title = visual?.title?.trim() ?? "";
	// Slot names carried over from the planning documents are not titles.
	// "table" tells a reader nothing, so the type stands in for it.
	if (title === "" || /^[a-z]+$/.test(title)) {
		return typeLabel(visual?.visual_type) || "A visual";
	}
	return title;
}

function sideOf(visual: SnapshotVisual | null): VisualSide | null {
	if (!visual) return null;
	return {
		visualId: visual.visual_id,
		visualType: visual.visual_type ?? "",
		title: visual.title ?? null,
		sourceKey: visual.source_key ?? null,
		config: visual.config ?? {},
		pageId: visual.page_id ?? "",
		layout: box(visual),
		name: visualName(visual),
		type: typeLabel(visual.visual_type),
	};
}

function pageTitle(page: SnapshotPage | null | undefined): string {
	const title = page?.title?.trim();
	return title ? title : "Untitled page";
}

function visualFields(
	was: SnapshotVisual | null,
	now: SnapshotVisual | null,
	pageName: (pageId: string | null | undefined) => string,
): FieldRow[] {
	const rows: (FieldRow | null)[] = [
		field("Title", scalar(was?.title), scalar(now?.title), true),
		field("Type", typeLabel(was?.visual_type), typeLabel(now?.visual_type)),
		field("Source", scalar(was?.source_key), scalar(now?.source_key)),
		field("Page", pageName(was?.page_id), pageName(now?.page_id)),
		field(
			"Dimensions",
			nameList(valueAt(was?.config, "dimensions")),
			nameList(valueAt(now?.config, "dimensions")),
		),
		field(
			"Measures",
			nameList(valueAt(was?.config, "measures")),
			nameList(valueAt(now?.config, "measures")),
		),
		field(
			"Filters",
			filterText(valueAt(was?.config, "filters")),
			filterText(valueAt(now?.config, "filters")),
		),
		field(
			"Sort",
			sortText(valueAt(was?.config, "sort")),
			sortText(valueAt(now?.config, "sort")),
		),
		field("Position", positionText(was), positionText(now)),
		field("Size", sizeText(was), sizeText(now)),
	];

	// Options and styling get a row each rather than one row saying they
	// changed. Which of forty settings moved is the reason for opening this,
	// and the catalogue already holds the label to name it by.
	const wasOptions = valueAt(was?.config, "options");
	const nowOptions = valueAt(now?.config, "options");
	for (const key of bothKeys(wasOptions, nowOptions)) {
		const type = now?.visual_type ?? was?.visual_type;
		rows.push(
			field(
				optionLabel(type, key),
				optionText(was?.visual_type, key, valueAt(wasOptions, key)),
				optionText(now?.visual_type, key, valueAt(nowOptions, key)),
				isProse(type, key),
			),
		);
	}

	const wasStyle = valueAt(was?.config, "style");
	const nowStyle = valueAt(now?.config, "style");
	for (const key of bothKeys(wasStyle, nowStyle)) {
		rows.push(
			field(
				styleLabels[key] ?? titled(key),
				summarise(valueAt(wasStyle, key), styleUnits[key]),
				summarise(valueAt(nowStyle, key), styleUnits[key]),
			),
		);
	}

	return rows.filter((row): row is FieldRow => row !== null);
}

function pageFields(
	was: SnapshotPage | null,
	now: SnapshotPage | null,
): FieldRow[] {
	const rows: (FieldRow | null)[] = [
		field("Title", scalar(was?.title), scalar(now?.title), true),
		field("Source", scalar(was?.source_key), scalar(now?.source_key)),
	];

	for (const key of bothKeys(was?.config, now?.config)) {
		const format = key === "filters" ? filterText : summarise;
		rows.push(
			field(
				key === "filters" ? "Filters" : titled(key),
				format(valueAt(was?.config, key)),
				format(valueAt(now?.config, key)),
			),
		);
	}

	return rows.filter((row): row is FieldRow => row !== null);
}

function statusOf(
	was: unknown | null,
	now: unknown | null,
	fields: FieldRow[],
): DiffStatus {
	if (!was) return "added";
	if (!now) return "removed";
	return fields.some((row) => row.changed) ? "changed" : "unchanged";
}

export function diffVersions(
	previous: Snapshot | null,
	next: Snapshot | null,
	from: number | null,
	to: number,
): VersionDiff {
	const before = activeVisuals(previous);
	const after = activeVisuals(next);
	const pagesBefore = activePages(previous);
	const pagesAfter = activePages(next);

	// The page a visual sits on is named by whichever snapshot still holds it,
	// so a visual on a deleted page still says where it used to be.
	// Neither snapshot recording the page means there is no name to give, and
	// an invented one would read as a real move to a page called that.
	const pageName = (pageId: string | null | undefined): string => {
		if (!pageId) return "";
		const page = pagesAfter.get(pageId) ?? pagesBefore.get(pageId);
		return page ? pageTitle(page) : "";
	};

	const visualIds = new Set<string>([...before.keys(), ...after.keys()]);
	const visuals: VisualDiff[] = [];

	for (const visualId of visualIds) {
		const was = before.get(visualId) ?? null;
		const now = after.get(visualId) ?? null;
		const fields = visualFields(was, now, pageName);
		visuals.push({
			visualId,
			status: statusOf(was, now, fields),
			before: sideOf(was),
			after: sideOf(now),
			fields,
		});
	}

	// Reading order is the order the page puts them in: whichever page the
	// visual is on now, or the one it was on if it has gone, then down and
	// across within that page.
	const pageOrder = new Map<string, number>();
	let rank = 0;
	for (const page of [...pagesAfter.values(), ...pagesBefore.values()]) {
		if (pageOrder.has(page.page_id)) continue;
		pageOrder.set(page.page_id, page.sort_order ?? rank);
		rank += 1;
	}
	const place = (entry: VisualDiff) => {
		const side = entry.after ?? entry.before;
		return {
			page: pageOrder.get(side?.pageId ?? "") ?? Number.MAX_SAFE_INTEGER,
			y: side?.layout.y ?? 0,
			x: side?.layout.x ?? 0,
		};
	};
	visuals.sort((a, b) => {
		const left = place(a);
		const right = place(b);
		return left.page - right.page || left.y - right.y || left.x - right.x;
	});

	const pageIds = new Set<string>([
		...pagesBefore.keys(),
		...pagesAfter.keys(),
	]);
	// A snapshot taken before pages were recorded carries visuals and nothing
	// else, and reports saved back then still have that in their history. The
	// visuals still belong to a page, so the page they name gets an entry with
	// nothing of its own in it rather than the visuals having nowhere to sit.
	for (const entry of visuals) {
		const pageId = entry.after?.pageId ?? entry.before?.pageId ?? "";
		if (pageId !== "") pageIds.add(pageId);
	}

	// Whether each side wrote its pages down at all, which decides whether a
	// page missing from one of them means anything.
	const pagesRecorded = {
		before: (previous?.pages ?? []).length > 0,
		after: (next?.pages ?? []).length > 0,
	};

	const pageStatus = (
		was: SnapshotPage | null,
		now: SnapshotPage | null,
		fields: FieldRow[],
	): DiffStatus => {
		if (!was && !now) return "unchanged";
		if (!was) return pagesRecorded.before ? "added" : "unchanged";
		if (!now) return pagesRecorded.after ? "removed" : "unchanged";
		return fields.some((row) => row.changed) ? "changed" : "unchanged";
	};

	const pages: PageDiff[] = [];
	for (const pageId of pageIds) {
		const was = pagesBefore.get(pageId) ?? null;
		const now = pagesAfter.get(pageId) ?? null;
		const fields = pageFields(was, now);
		// Neither snapshot describes it, so there is no title to show and
		// nothing about the page itself either changed or did not.
		const recorded = was !== null || now !== null;
		pages.push({
			pageId,
			title: recorded ? pageTitle(now ?? was) : "",
			titleBefore: was ? pageTitle(was) : null,
			titleAfter: now ? pageTitle(now) : null,
			status: pageStatus(was, now, fields),
			fields,
			touched: visuals.filter(
				(entry) =>
					(entry.after?.pageId ?? entry.before?.pageId) === pageId &&
					entry.status !== "unchanged",
			).length,
		});
	}
	pages.sort(
		(a, b) =>
			(pageOrder.get(a.pageId) ?? 0) - (pageOrder.get(b.pageId) ?? 0),
	);

	const reportBefore = previous?.report ?? null;
	const reportAfter = next?.report ?? null;
	const report = [
		field(
			"Title",
			scalar(reportBefore?.title),
			scalar(reportAfter?.title),
			true,
		),
		field(
			"Subtitle",
			scalar(reportBefore?.description),
			scalar(reportAfter?.description),
			true,
		),
	].filter((row): row is FieldRow => row !== null);

	const counts = {
		added: visuals.filter((v) => v.status === "added").length,
		removed: visuals.filter((v) => v.status === "removed").length,
		changed: visuals.filter((v) => v.status === "changed").length,
		unchanged: visuals.filter((v) => v.status === "unchanged").length,
	};

	return { from, to, pagesRecorded, report, pages, visuals, counts };
}
