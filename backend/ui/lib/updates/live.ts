import {
	currentWindow,
	isUnderway,
	namesField,
	sourcesOf,
	type AboutItem,
	type Update,
} from "./model";

// What the surfaces across the app are sent, cut down from the whole changelog. Every page
// asks for the live slice, so it carries only the entries some surface can show today and
// only the parts those surfaces read. Chart markers and a Dictionary field ask for their
// own, smaller answers.

type Read = Update & { read?: boolean };

// One entry as the banner, pop-up, Home card, page notices, Data status and the
// maintenance calendar read it. The body is kept only where a pop-up shows it, and the
// about list keeps what a page notice or the calendar matches on, which leaves out tables.
export interface LiveUpdate extends Pick<
	Update,
	| "updateId"
	| "type"
	| "title"
	| "impact"
	| "incidentState"
	| "delivery"
	| "postedOn"
	| "effectiveOn"
	| "startsOn"
	| "endsOn"
	| "repeat"
	| "requireAck"
	| "about"
> {
	read: boolean;
	body: string | null;
}

// How many entries the Home card lists.
export const homeCardSize = 4;

function compactAbout(about: AboutItem[]): AboutItem[] {
	return about.flatMap((item): AboutItem[] => {
		if (item.kind === "table") return [];
		if (item.kind === "field") {
			return [{ kind: "field", id: item.id, sourceKey: item.sourceKey }];
		}
		return [{ kind: item.kind, id: item.id }];
	});
}

function isOpenIncident(update: Update): boolean {
	return update.type === "incident" && update.incidentState !== "resolved";
}

// Whether any surface would show this entry now. The Home card takes the first few in
// timeline order, so the caller passes whether this one is among them.
function shownSomewhere(
	update: Read,
	now: number,
	onHome: boolean,
	read: boolean,
): boolean {
	if (onHome) return true;
	if (update.delivery.banner) return true;
	if (update.delivery.popup && !read) return true;
	if (isOpenIncident(update)) return true;
	if (update.type === "maintenance" && currentWindow(update, now) !== null) {
		return true;
	}
	return (
		update.delivery.page &&
		(update.impact === "breaking" ||
			(update.type === "maintenance" && isUnderway(update, now)))
	);
}

// The live slice, in the order the updates came in. Whether the reader has read each entry
// comes from the entry, or from isRead for entries shared between readers.
export function liveSlice(
	updates: Read[],
	now: number,
	isRead: (update: Read) => boolean = (update) => update.read ?? false,
): LiveUpdate[] {
	const home = new Set(
		updates
			.filter((update) => update.delivery.home)
			.slice(0, homeCardSize)
			.map((update) => update.updateId),
	);
	return updates
		.filter((update) =>
			shownSomewhere(
				update,
				now,
				home.has(update.updateId),
				isRead(update),
			),
		)
		.map((update) => {
			const read = isRead(update);
			return {
				updateId: update.updateId,
				type: update.type,
				title: update.title,
				impact: update.impact,
				incidentState: update.incidentState,
				delivery: update.delivery,
				postedOn: update.postedOn,
				effectiveOn: update.effectiveOn,
				startsOn: update.startsOn,
				endsOn: update.endsOn,
				repeat: update.repeat,
				requireAck: update.requireAck,
				read,
				body: update.delivery.popup && !read ? update.body : null,
				about: compactAbout(update.about),
			};
		});
}

export interface UpdateMarker {
	sourceKeys: string[];
	at: string;
	label: string;
}

// Marks for the charts on a page, at the dates changes to the sources it reads took effect.
export function markerSlice(
	updates: Update[],
	sourceKeys: string[],
): UpdateMarker[] {
	const wanted = new Set(sourceKeys);
	return updates.flatMap((update) => {
		if (!update.effectiveOn) return [];
		const keys = sourcesOf(update.about).filter((key) => wanted.has(key));
		return keys.length > 0
			? [
					{
						sourceKeys: keys,
						at: update.effectiveOn,
						label: update.title,
					},
				]
			: [];
	});
}

// How many changes a Dictionary field lists.
export const fieldUpdateCount = 8;

// The latest changes naming one field, or its whole dataset, for the Dictionary.
export function fieldSlice(
	updates: Update[],
	sourceKey: string,
	field: string,
): Pick<Update, "updateId" | "title" | "postedOn">[] {
	return updates
		.filter((update) =>
			update.about.some(
				(item) =>
					namesField(item, sourceKey, field) ||
					(item.kind === "source" && item.id === sourceKey),
			),
		)
		.slice(0, fieldUpdateCount)
		.map(({ updateId, title, postedOn }) => ({
			updateId,
			title,
			postedOn,
		}));
}
