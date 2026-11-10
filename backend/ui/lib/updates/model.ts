// What an update is and the rules about when it shows and who to. Covers changes to data
// and reports, maintenance, incidents, deprecations, announcements, release notes and
// whatever types an administrator adds.
//
// Pure, so the rules can be tested and every view agrees on them.

import { displayNameFromEmail } from "../auth/names";

export type Impact = "info" | "notable" | "breaking";
export type UpdateStatus = "draft" | "published" | "retracted";
export type IncidentState = "investigating" | "identified" | "resolved";
export type RepeatEvery = "none" | "daily" | "weekly" | "monthly";

export interface AboutItem {
	kind: "source" | "table" | "field" | "category" | "report" | "page";
	id: string;
	// The source a field belongs to.
	sourceKey?: string;
}

export interface Audience {
	kind: "readers" | "everyone" | "groups" | "category" | "source" | "report";
	ids?: string[];
}

export interface Delivery {
	banner: boolean;
	popup: boolean;
	home: boolean;
	inbox: boolean;
	push: boolean;
	page: boolean;
}

export interface UpdateTypeDefinition {
	typeId: string;
	label: string;
	color: string;
	impact: Impact;
	delivery: Delivery;
	requires: string[];
	isBuiltin: boolean;
}

const quiet: Delivery = {
	banner: false,
	popup: false,
	home: true,
	inbox: false,
	push: false,
	page: true,
};

// Colours are read through the theme where one means something, so they hold in both.
export const builtinTypes: UpdateTypeDefinition[] = [
	{
		typeId: "dataChange",
		label: "Data change",
		color: "var(--brand)",
		impact: "notable",
		delivery: { ...quiet, inbox: true },
		requires: [],
		isBuiltin: true,
	},
	{
		typeId: "reportChange",
		label: "Report change",
		color: "var(--brand)",
		impact: "info",
		delivery: quiet,
		requires: [],
		isBuiltin: true,
	},
	{
		typeId: "maintenance",
		label: "Maintenance",
		color: "var(--warning)",
		impact: "notable",
		delivery: { ...quiet, banner: true, inbox: true },
		requires: ["startsOn", "endsOn"],
		isBuiltin: true,
	},
	{
		typeId: "incident",
		label: "Incident",
		color: "var(--danger)",
		impact: "breaking",
		delivery: { ...quiet, banner: true, inbox: true, push: true },
		requires: [],
		isBuiltin: true,
	},
	{
		typeId: "deprecation",
		label: "Deprecation",
		color: "var(--warning)",
		impact: "notable",
		delivery: { ...quiet, inbox: true },
		requires: ["effectiveOn"],
		isBuiltin: true,
	},
	{
		typeId: "announcement",
		label: "Announcement",
		color: "var(--success)",
		impact: "info",
		delivery: { ...quiet, inbox: true },
		requires: [],
		isBuiltin: true,
	},
	{
		typeId: "releaseNotes",
		label: "Release notes",
		color: "var(--success)",
		impact: "info",
		delivery: quiet,
		requires: [],
		isBuiltin: true,
	},
];

// Somebody credited with a change. An email names someone the app knows, a GitHub name is
// matched to them through the names an administrator sets, and a name alone stands as written.
export interface Author {
	name: string;
	email?: string;
	github?: string;
}

// Where an update about something long done sits on the timeline. At the top as news, or back
// at the date it happened.
export type Placement = "top" | "history";

export interface Update {
	updateId: string;
	type: string;
	title: string;
	body: string;
	impact: Impact;
	status: UpdateStatus;
	about: AboutItem[];
	before: string | null;
	after: string | null;
	links: { label: string; url: string }[];
	tags: string[];
	// Makes a retry from an automation land on one entry.
	reference: string | null;
	postedOn: string;
	effectiveOn: string | null;
	periodFrom: string | null;
	periodTo: string | null;
	startsOn: string | null;
	endsOn: string | null;
	repeat: RepeatEvery;
	incidentState: IncidentState | null;
	audience: Audience;
	delivery: Delivery;
	// Held back until then.
	showFrom: string | null;
	expiresOn: string | null;
	requireAck: boolean;
	automatic: boolean;
	reason: string | null;
	createdBy: string;
	correctedOn: string | null;
	authors: Author[];
	placement: Placement;
	// Whether anybody is told when it is published. Off, it is listed and shown on its pages
	// and nobody is sent anything.
	notify: boolean;
}

export class UpdateInputError extends Error {}

// How many days ahead of a deprecation people are reminded of it.
export const deprecationReminderDays = [30, 7, 1];

// Which reminder is owed now, in days ahead, or null. Only the nearest one reached goes out,
// so a check that was held up sends one reminder rather than a run of them. One already
// sent, or a post made inside the window, leaves nothing owed for that step.
export function deprecationReminderDue(
	effectiveOn: string | null,
	postedOn: string,
	lastRemindedDays: number | null,
	now: number,
): number | null {
	if (!effectiveOn) return null;
	const dayLength = 86_400_000;
	const effective = new Date(effectiveOn).getTime();
	if (effective <= now) return null;
	const daysLeft = (effective - now) / dayLength;
	const reached = deprecationReminderDays
		.filter((days) => daysLeft <= days)
		.sort((a, b) => a - b)[0];
	if (reached === undefined) return null;
	if (lastRemindedDays !== null && lastRemindedDays <= reached) return null;
	const noticeGiven = (effective - new Date(postedOn).getTime()) / dayLength;
	return noticeGiven > reached ? reached : null;
}

export function deprecationReminderTitle(
	title: string,
	daysAhead: number,
): string {
	return daysAhead === 1
		? `Tomorrow: ${title}`
		: `In ${daysAhead} days: ${title}`;
}

const impacts: Impact[] = ["info", "notable", "breaking"];
// Enough for any one change, and a cap on what an automation can fill a byline with.
const maxAuthors = 20;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const repeats: RepeatEvery[] = ["none", "daily", "weekly", "monthly"];
const aboutKinds = ["source", "table", "field", "category", "report", "page"];
const audienceKinds = [
	"readers",
	"everyone",
	"groups",
	"category",
	"source",
	"report",
];

function text(value: unknown, limit: number): string {
	return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function nullable(value: unknown, limit = 4000): string | null {
	return text(value, limit) || null;
}

function moment(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const at = new Date(value);
	if (Number.isNaN(at.getTime())) {
		throw new UpdateInputError(`"${value}" is not a date.`);
	}
	return at.toISOString();
}

export type UpdateInput = Omit<
	Update,
	| "updateId"
	| "postedOn"
	| "createdBy"
	| "correctedOn"
	| "automatic"
	| "status"
> & { status: "draft" | "published" };

// Authors as sent, each as an email, "github:name", a plain name, or the same as an object.
// Duplicates are dropped, by whichever of email, GitHub name or name each carries.
export function parseAuthors(raw: unknown): Author[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: Author[] = [];
	for (const entry of raw) {
		let author: Author | null = null;
		if (typeof entry === "string") {
			const value = entry.trim().slice(0, 200);
			if (!value) continue;
			if (/^github:/i.test(value)) {
				const login = value.slice("github:".length).trim();
				if (login) author = { name: login, github: login };
			} else if (emailPattern.test(value)) {
				const email = value.toLowerCase();
				author = { name: displayNameFromEmail(email), email };
			} else {
				author = { name: value };
			}
		} else if (entry && typeof entry === "object") {
			const held = entry as Record<string, unknown>;
			const email = text(held.email, 200).toLowerCase();
			const github = text(held.github, 100);
			const name =
				text(held.name, 200) ||
				(email ? displayNameFromEmail(email) : github);
			if (!name) continue;
			author = {
				name,
				...(email && emailPattern.test(email) ? { email } : {}),
				...(github ? { github } : {}),
			};
		}
		if (!author) continue;
		const key = (
			author.email ??
			(author.github ? `github:${author.github}` : author.name)
		).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(author);
		if (out.length === maxAuthors) break;
	}
	return out;
}

// A GitHub name or an automation's id, matched to a person or given a name an administrator set.
export interface PersonAlias {
	alias: string;
	kind: "github" | "principal";
	email: string | null;
	displayName: string | null;
}

// Each author as readers see them. A GitHub name matched since the update was posted takes
// that person's name and email, so a mapping set later reaches entries already made.
export function resolveAuthors(
	authors: Author[],
	aliases: PersonAlias[],
): (Author & { matched: boolean })[] {
	const byLogin = new Map(
		aliases
			.filter((alias) => alias.kind === "github")
			.map((alias) => [alias.alias.toLowerCase(), alias]),
	);
	return authors.map((author) => {
		if (author.email) return { ...author, matched: true };
		const alias = author.github
			? byLogin.get(author.github.toLowerCase())
			: undefined;
		if (!alias) return { ...author, matched: !author.github };
		const email = alias.email?.toLowerCase() ?? undefined;
		return {
			...author,
			name:
				alias.displayName ||
				(email ? displayNameFromEmail(email) : author.name),
			...(email ? { email } : {}),
			matched: true,
		};
	});
}

// Who posted it, in words. An automation shows the name an administrator gave it.
export function posterName(createdBy: string, aliases: PersonAlias[]): string {
	const named = aliases.find(
		(alias) =>
			alias.kind === "principal" &&
			alias.alias.toLowerCase() === createdBy.toLowerCase(),
	);
	if (named?.displayName) return named.displayName;
	return createdBy.includes("@")
		? displayNameFromEmail(createdBy)
		: createdBy;
}

// The date an update is placed at on the timeline.
export function timelineDate(
	update: Pick<Update, "placement" | "effectiveOn" | "postedOn">,
): string {
	return update.placement === "history" && update.effectiveOn
		? update.effectiveOn
		: update.postedOn;
}

// What is kept of what somebody sent, whoever they are.
export function cleanInput(
	raw: Record<string, unknown>,
	type: UpdateTypeDefinition | undefined,
): UpdateInput {
	if (!type) throw new UpdateInputError("That is not a type of update.");
	const title = text(raw.title, 300);
	if (!title) throw new UpdateInputError("An update needs a title.");

	const delivery = (raw.delivery ?? {}) as Partial<Delivery>;
	const audience = (raw.audience ?? {}) as Partial<Audience>;
	const effectiveOn = moment(raw.effectiveOn);
	// Back at its own date only when it has one, and only when that date has passed.
	const placement: Placement =
		raw.placement === "history" &&
		effectiveOn !== null &&
		new Date(effectiveOn).getTime() <= Date.now()
			? "history"
			: "top";
	const notify = raw.notify !== false;
	const input: UpdateInput = {
		type: type.typeId,
		title,
		body: typeof raw.body === "string" ? raw.body.slice(0, 20000) : "",
		impact: impacts.includes(raw.impact as Impact)
			? (raw.impact as Impact)
			: type.impact,
		status: raw.status === "draft" ? "draft" : "published",
		about: Array.isArray(raw.about)
			? raw.about.flatMap((item) => {
					const held = (item ?? {}) as Record<string, unknown>;
					const id = text(held.id, 300);
					if (!id || !aboutKinds.includes(String(held.kind)))
						return [];
					return [
						{
							kind: held.kind as AboutItem["kind"],
							id,
							...(held.sourceKey
								? { sourceKey: String(held.sourceKey) }
								: {}),
						},
					];
				})
			: [],
		before: nullable(raw.before),
		after: nullable(raw.after),
		links: Array.isArray(raw.links)
			? raw.links.flatMap((link) => {
					const held = (link ?? {}) as Record<string, unknown>;
					const url = text(held.url, 1000);
					// Only somewhere safe to send a reader.
					if (!/^(https?:\/\/|\/)/i.test(url)) return [];
					return [{ label: text(held.label, 200) || url, url }];
				})
			: [],
		tags: Array.isArray(raw.tags)
			? [
					...new Set(
						raw.tags
							.map((tag) => text(tag, 60).toLowerCase())
							.filter(Boolean),
					),
				]
			: [],
		reference: nullable(raw.reference, 300),
		effectiveOn,
		periodFrom: moment(raw.periodFrom),
		periodTo: moment(raw.periodTo),
		startsOn: moment(raw.startsOn),
		endsOn: moment(raw.endsOn),
		repeat: repeats.includes(raw.repeat as RepeatEvery)
			? (raw.repeat as RepeatEvery)
			: "none",
		incidentState:
			type.typeId === "incident"
				? raw.incidentState === "identified" ||
					raw.incidentState === "resolved"
					? raw.incidentState
					: "investigating"
				: null,
		audience: {
			kind: audienceKinds.includes(String(audience.kind))
				? (audience.kind as Audience["kind"])
				: "readers",
			...(Array.isArray(audience.ids)
				? { ids: audience.ids.map(String) }
				: {}),
		},
		// Not telling anyone takes away everything that interrupts, and an entry placed back in
		// history is no longer news for the home page or a banner.
		delivery: {
			banner:
				notify &&
				placement === "top" &&
				(delivery.banner ?? type.delivery.banner),
			popup:
				notify &&
				placement === "top" &&
				(delivery.popup ?? type.delivery.popup),
			home: placement === "top" && (delivery.home ?? type.delivery.home),
			inbox: notify && (delivery.inbox ?? type.delivery.inbox),
			push: notify && (delivery.push ?? type.delivery.push),
			page: delivery.page ?? type.delivery.page,
		},
		authors: parseAuthors(raw.authors),
		placement,
		notify,
		showFrom: moment(raw.showFrom),
		expiresOn: moment(raw.expiresOn),
		requireAck: raw.requireAck === true,
		reason: nullable(raw.reason),
	};

	for (const field of type.requires) {
		if (!input[field as keyof UpdateInput]) {
			throw new UpdateInputError(
				`A ${type.label} needs ${words(field)}.`,
			);
		}
	}
	if (input.startsOn && input.endsOn && input.startsOn > input.endsOn) {
		throw new UpdateInputError("It cannot end before it starts.");
	}
	return input;
}

function words(field: string): string {
	const names: Record<string, string> = {
		startsOn: "a start",
		endsOn: "an end",
		effectiveOn: "an effective date",
		body: "some details",
		reference: "a reference",
	};
	return names[field] ?? field;
}

// The sources it touches, a field's included.
export function sourcesOf(about: AboutItem[]): string[] {
	return [
		...new Set(
			about.flatMap((item) => {
				if (item.kind === "source") return [item.id];
				if (item.kind === "field" && item.sourceKey) {
					return [item.sourceKey];
				}
				return [];
			}),
		),
	];
}

// A published update inside its display window.
export function isShowing(
	update: Pick<Update, "status" | "showFrom" | "expiresOn">,
	now: number,
): boolean {
	if (update.status !== "published") return false;
	if (update.showFrom && new Date(update.showFrom).getTime() > now)
		return false;
	if (update.expiresOn && new Date(update.expiresOn).getTime() <= now) {
		return false;
	}
	return true;
}

function addRepeat(at: Date, repeat: RepeatEvery): Date {
	const next = new Date(at);
	if (repeat === "daily") next.setUTCDate(next.getUTCDate() + 1);
	if (repeat === "weekly") next.setUTCDate(next.getUTCDate() + 7);
	if (repeat === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
	return next;
}

// The maintenance window in force or next up, worked forward through its repeats.
export function currentWindow(
	update: Pick<Update, "startsOn" | "endsOn" | "repeat">,
	now: number,
): { start: number; end: number } | null {
	if (!update.startsOn || !update.endsOn) return null;
	let start = new Date(update.startsOn);
	let end = new Date(update.endsOn);
	if (update.repeat !== "none") {
		// Stops well past any date worth showing, so a bad date cannot spin forever.
		for (let hop = 0; hop < 5000 && end.getTime() <= now; hop += 1) {
			start = addRepeat(start, update.repeat);
			end = addRepeat(end, update.repeat);
		}
	}
	if (end.getTime() <= now) return null;
	return { start: start.getTime(), end: end.getTime() };
}

export function isUnderway(
	update: Pick<Update, "startsOn" | "endsOn" | "repeat">,
	now: number,
): boolean {
	const window = currentWindow(update, now);
	return window !== null && window.start <= now && now < window.end;
}

// Sources whose late data, rule failures and alerts are expected right now.
export function quietSources(
	updates: Pick<
		Update,
		"type" | "status" | "about" | "startsOn" | "endsOn" | "repeat"
	>[],
	now: number,
): Set<string> {
	const quietNow = new Set<string>();
	for (const update of updates) {
		if (update.type !== "maintenance" || update.status !== "published") {
			continue;
		}
		if (!isUnderway(update, now)) continue;
		for (const source of sourcesOf(update.about)) quietNow.add(source);
	}
	return quietNow;
}

export interface Reader {
	readableSources: Set<string> | null;
	groups: string[];
	categories: Set<string>;
	reports: Set<string>;
}

// Whether this update is meant for this person, without ever showing someone a source
// they cannot read.
export function reaches(
	update: Pick<Update, "audience" | "about">,
	reader: Reader,
): boolean {
	const sources = sourcesOf(update.about);
	const canRead = (key: string) =>
		!reader.readableSources || reader.readableSources.has(key);
	const ids = update.audience.ids ?? [];
	switch (update.audience.kind) {
		case "everyone":
			return true;
		case "groups": {
			const held = new Set(reader.groups.map((g) => g.toLowerCase()));
			return ids.some((id) => held.has(id.toLowerCase()));
		}
		case "category":
			return ids.some((id) => reader.categories.has(id));
		case "report":
			return ids.some((id) => reader.reports.has(id));
		case "source":
			return ids.some(canRead);
		default:
			// With no source named, it is about the platform, which everyone uses.
			return sources.length === 0 || sources.some(canRead);
	}
}

// Whether an update belongs on a page reading these things.
export function aboutPage(
	update: Pick<Update, "about">,
	page: {
		sourceKeys: string[];
		reportId: string;
		categoryId: string | null;
		pageId: string | null;
	},
): boolean {
	return update.about.some((item) => {
		if (item.kind === "report") return item.id === page.reportId;
		if (item.kind === "page") return item.id === page.pageId;
		if (item.kind === "category") return item.id === page.categoryId;
		return sourcesOf([item]).some((key) => page.sourceKeys.includes(key));
	});
}

export interface Follow {
	kind: "all" | "type" | "source" | "field";
	value: string;
	mode: "instant" | "digest";
}

export function followMatches(
	follow: Follow,
	update: Pick<Update, "type" | "about">,
): boolean {
	if (follow.kind === "all") return true;
	if (follow.kind === "type") return follow.value === update.type;
	if (follow.kind === "source") {
		return sourcesOf(update.about).includes(follow.value);
	}
	return update.about.some(
		(item) => item.kind === "field" && item.id === follow.value,
	);
}

// Which category on a time axis an update's effective date lands in, so a chart can
// mark it. The first category on or after that date, or nothing past the end.
export function markerCategory(
	categories: string[],
	effectiveOn: string,
): string | null {
	const at = new Date(effectiveOn).getTime();
	if (Number.isNaN(at)) return null;
	const times = categories.map((category) => new Date(category).getTime());
	// An axis of names, or one not running forwards in time, has nowhere to put it.
	if (times.some(Number.isNaN)) return null;
	if (times.some((time, index) => index > 0 && time < times[index - 1])) {
		return null;
	}
	const found = times.findIndex((time) => time >= at);
	return found < 0 ? null : categories[found];
}

export interface SyncDifferences {
	sourceKey: string;
	added: string[];
	newlyMissing: string[];
	renames: { from: string; to: string }[];
	redefined: { name: string; before: string | null; after: string | null }[];
}

export type AutomaticKind =
	| "fieldAdded"
	| "fieldRemoved"
	| "fieldRenamed"
	| "definitionChanged";

export interface AutomaticEntry {
	kind: AutomaticKind;
	title: string;
	reference: string;
	impact: Impact;
	about: AboutItem[];
	before: string | null;
	after: string | null;
}

// What a field sync found, as entries. The reference is what stops a second sync posting
// the same thing, and the day in it lets the same change happen again later.
export function automaticEntries(
	found: SyncDifferences,
	sourceTitle: string,
	enabled: Record<AutomaticKind, boolean>,
	day: string,
): AutomaticEntry[] {
	const { sourceKey } = found;
	const field = (id: string): AboutItem => ({ kind: "field", id, sourceKey });
	const renamed = new Set(found.renames.map((r) => r.from));
	const arrived = new Set(found.renames.map((r) => r.to));
	const out: AutomaticEntry[] = [];
	if (enabled.fieldAdded) {
		for (const name of found.added) {
			if (arrived.has(name)) continue;
			out.push({
				kind: "fieldAdded",
				title: `${name} was added to ${sourceTitle}`,
				reference: `auto:added:${sourceKey}:${name}:${day}`,
				impact: "info",
				about: [field(name)],
				before: null,
				after: null,
			});
		}
	}
	if (enabled.fieldRemoved) {
		for (const name of found.newlyMissing) {
			if (renamed.has(name)) continue;
			out.push({
				kind: "fieldRemoved",
				title: `${name} was removed from ${sourceTitle}`,
				reference: `auto:removed:${sourceKey}:${name}:${day}`,
				impact: "breaking",
				about: [field(name)],
				before: null,
				after: null,
			});
		}
	}
	if (enabled.fieldRenamed) {
		for (const { from, to } of found.renames) {
			out.push({
				kind: "fieldRenamed",
				title: `${from} looks to have been renamed to ${to} on ${sourceTitle}`,
				reference: `auto:renamed:${sourceKey}:${from}:${to}:${day}`,
				impact: "notable",
				about: [field(from), field(to)],
				before: from,
				after: to,
			});
		}
	}
	if (enabled.definitionChanged) {
		for (const { name, before, after } of found.redefined) {
			out.push({
				kind: "definitionChanged",
				title: `The definition of ${name} changed on ${sourceTitle}`,
				reference: `auto:redefined:${sourceKey}:${name}:${day}`,
				impact: "notable",
				about: [field(name)],
				before,
				after,
			});
		}
	}
	return out;
}
