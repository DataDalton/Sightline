// The work queue's rules, kept apart from storage so they can be read and
// tested on their own.
//
// What a team can change lives in its configuration, edited in
// Administration: the columns, the lists behind each field, who owns each
// domain, and the rules. Everything ships generic. Layer and domain lists
// start empty, because those are every team's own.
//
// Kept free of database and network imports so it can be tested on its own.

export interface ColumnDef {
	id: string;
	label: string;
	hidden?: boolean;
}

export interface Choice {
	id: string;
	label: string;
	hint?: string;
}

export interface EffortChoice extends Choice {
	// The span of working hours it means, for comparing estimates with what
	// work actually took.
	minHours: number;
	maxHours: number | null;
}

export interface WorkTypeChoice extends Choice {
	// What the request form asks for this kind of work.
	prompts: string[];
}

export interface WorkConfig {
	prefix: string;
	columns: ColumnDef[];
	workTypes: WorkTypeChoice[];
	priorities: Choice[];
	efforts: EffortChoice[];
	layers: Choice[];
	domains: Choice[];
	// Who a new request in a domain or layer goes to, by email or group name.
	owners: {
		domains: Record<string, string[]>;
		layers: Record<string, string[]>;
	};
	rules: {
		// Fields a request must have before it may move into a column.
		required: Record<string, RequiredField[]>;
		// Approval before In progress, for chosen sizes or types. Off unless
		// switched on.
		approval: { enabled: boolean; efforts: string[]; workTypes: string[] };
		// Moves allowed out of each column. Absent allows any move.
		allowedMoves: Record<string, string[]> | null;
		// New requests go to their domain's or layer's owners.
		autoAssign: boolean;
		// Only DevSecOps moves a request to Done.
		onlyDevSecOpsDeploys: boolean;
		// A DevSecOps sign-off before Ready to deploy, for chosen types.
		securityReview: { enabled: boolean; workTypes: string[] };
		// Days in a column before the people on it are reminded.
		ageingDays: Record<string, number>;
	};
}

export type RequiredField =
	| "workType"
	| "priority"
	| "effort"
	| "domain"
	| "layer"
	| "assignees"
	| "reviewer"
	| "approver"
	| "target"
	| "criteria";

export const closedStates = ["declined", "duplicate"] as const;
export type ClosedState = (typeof closedStates)[number];

export const defaultConfig: WorkConfig = {
	prefix: "WR",
	columns: [
		{ id: "new", label: "New" },
		{ id: "needsInfo", label: "Needs info" },
		{ id: "backlog", label: "Backlog" },
		{ id: "ready", label: "Ready" },
		{ id: "inProgress", label: "In progress" },
		{ id: "inReview", label: "In review" },
		{ id: "validating", label: "Validating" },
		{ id: "readyToDeploy", label: "Ready to deploy" },
		{ id: "done", label: "Done" },
	],
	workTypes: [
		{
			id: "newData",
			label: "New data",
			prompts: [
				"What data is needed, and where does it come from today?",
				"What will it be used for?",
			],
		},
		{
			id: "newField",
			label: "New field",
			prompts: [
				"Which dataset should it be on?",
				"What should it mean, exactly?",
			],
		},
		{
			id: "fixData",
			label: "Fix wrong data",
			prompts: [
				"Where does the wrong figure show?",
				"What did you expect to see, and why?",
			],
		},
		{
			id: "newReport",
			label: "New report",
			prompts: ["Who is it for, and what decisions will it support?"],
		},
		{
			id: "reportChange",
			label: "Report change",
			prompts: ["Which report, and what should change?"],
		},
		{
			id: "performance",
			label: "Performance",
			prompts: ["What is slow, and how slow?"],
		},
		{
			id: "deprecation",
			label: "Deprecation",
			prompts: ["What should be retired, and what replaces it?"],
		},
		{
			id: "investigation",
			label: "Investigation",
			prompts: ["What question needs answering?"],
		},
		{
			id: "techDebt",
			label: "Tech debt",
			prompts: [
				"What should be cleaned up, and what does it cost today?",
			],
		},
		{ id: "other", label: "Other", prompts: [] },
	],
	priorities: [
		{ id: "urgent", label: "Urgent" },
		{ id: "high", label: "High" },
		{ id: "medium", label: "Medium" },
		{ id: "low", label: "Low" },
	],
	efforts: [
		{
			id: "underHour",
			label: "Under an hour",
			hint: "A quick fix or a small change",
			minHours: 0,
			maxHours: 1,
		},
		{ id: "halfDay", label: "Half a day", minHours: 1, maxHours: 4 },
		{ id: "day", label: "A day", minHours: 4, maxHours: 8 },
		{
			id: "fewDays",
			label: "A few days",
			hint: "2 to 4 days",
			minHours: 16,
			maxHours: 32,
		},
		{ id: "weekOrTwo", label: "A week or two", minHours: 40, maxHours: 80 },
		{
			id: "fewWeeks",
			label: "A few weeks",
			hint: "2 to 4 weeks",
			minHours: 80,
			maxHours: 160,
		},
		{
			id: "overMonth",
			label: "Over a month",
			hint: "Should be split into sub-tasks",
			minHours: 160,
			maxHours: null,
		},
	],
	layers: [],
	domains: [],
	owners: { domains: {}, layers: {} },
	rules: {
		required: {},
		approval: { enabled: false, efforts: [], workTypes: [] },
		allowedMoves: null,
		autoAssign: false,
		onlyDevSecOpsDeploys: false,
		securityReview: { enabled: false, workTypes: [] },
		ageingDays: { inReview: 3, validating: 5, needsInfo: 7 },
	},
};

// A stored configuration over the defaults, so a key added later has a value.
export function withDefaults(
	stored: Partial<WorkConfig> | null | undefined,
): WorkConfig {
	const held = stored ?? {};
	return {
		...defaultConfig,
		...held,
		owners: { ...defaultConfig.owners, ...(held.owners ?? {}) },
		rules: {
			...defaultConfig.rules,
			...(held.rules ?? {}),
			approval: {
				...defaultConfig.rules.approval,
				...(held.rules?.approval ?? {}),
			},
			securityReview: {
				...defaultConfig.rules.securityReview,
				...(held.rules?.securityReview ?? {}),
			},
		},
	};
}

export function formatKey(prefix: string, number: number): string {
	return `${prefix}-${number}`;
}

// The number in a key such as "WR-142", whatever its prefix.
export function numberOfKey(key: string): number | null {
	const match = /^[A-Za-z][A-Za-z0-9]*-(\d+)$/.exec(key.trim());
	return match ? Number(match[1]) : null;
}

// --- Moving between columns -------------------------------------------------

export interface ItemFacts {
	status: string;
	workType: string | null;
	priority: string | null;
	effort: string | null;
	domain: string | null;
	layer: string | null;
	assignees: string[];
	reviewer: string | null;
	approver: string | null;
	approved: boolean;
	securityReviewed: boolean;
	target: string | null;
	criteria: number;
	closed: boolean;
}

export interface Mover {
	engineer: boolean;
	devSecOps: boolean;
}

const requiredWords: Record<RequiredField, string> = {
	workType: "a work type",
	priority: "a priority",
	effort: "an effort",
	domain: "a domain",
	layer: "a layer",
	assignees: "somebody assigned",
	reviewer: "a reviewer",
	approver: "an approver",
	target: "a target",
	criteria: "acceptance criteria",
};

function has(item: ItemFacts, field: RequiredField): boolean {
	switch (field) {
		case "assignees":
			return item.assignees.length > 0;
		case "criteria":
			return item.criteria > 0;
		case "target":
			return Boolean(item.target);
		default:
			return Boolean(item[field]);
	}
}

// Why a move is refused, or null when it is allowed.
export function refuseMove(
	item: ItemFacts,
	to: string,
	mover: Mover,
	config: WorkConfig,
): string | null {
	if (!config.columns.some((column) => column.id === to)) {
		return "That is not a column on this board.";
	}
	if (item.closed) return "Reopen it first.";
	if (!mover.engineer && !mover.devSecOps) {
		return "Only the engineers move requests.";
	}
	const allowed = config.rules.allowedMoves?.[item.status];
	if (allowed && !allowed.includes(to) && to !== item.status) {
		const label = (id: string) =>
			config.columns.find((column) => column.id === id)?.label ?? id;
		return `From ${label(item.status)} it can only move to ${allowed.map(label).join(", ")}.`;
	}
	const missing = (config.rules.required[to] ?? []).filter(
		(field) => !has(item, field),
	);
	if (missing.length > 0) {
		return `It needs ${missing.map((field) => requiredWords[field]).join(", ")} first.`;
	}
	const position = (id: string) =>
		config.columns.findIndex((column) => column.id === id);
	const { approval, securityReview } = config.rules;
	const needsApproval =
		approval.enabled &&
		((item.effort !== null && approval.efforts.includes(item.effort)) ||
			(item.workType !== null &&
				approval.workTypes.includes(item.workType)));
	if (
		needsApproval &&
		!item.approved &&
		position(to) >= position("inProgress") &&
		position("inProgress") >= 0
	) {
		return "It needs approval before work starts.";
	}
	const needsSecurity =
		securityReview.enabled &&
		item.workType !== null &&
		securityReview.workTypes.includes(item.workType);
	if (
		needsSecurity &&
		!item.securityReviewed &&
		position(to) >= position("readyToDeploy") &&
		position("readyToDeploy") >= 0
	) {
		return "It needs a security review first.";
	}
	if (
		to === "done" &&
		config.rules.onlyDevSecOpsDeploys &&
		!mover.devSecOps
	) {
		return "Only DevSecOps moves requests to Done.";
	}
	return null;
}

// Who a new request goes to under auto-assign: its domain's owners, else its
// layer's.
export function ownersFor(
	config: WorkConfig,
	domain: string | null,
	layer: string | null,
): string[] {
	if (!config.rules.autoAssign) return [];
	const fromDomain = domain ? (config.owners.domains[domain] ?? []) : [];
	if (fromDomain.length > 0) return fromDomain;
	return layer ? (config.owners.layers[layer] ?? []) : [];
}

// --- Changes, as the timeline records them ----------------------------------

export const trackedFields = [
	"title",
	"workType",
	"priority",
	"effort",
	"layer",
	"domain",
	"target",
	"assignees",
	"reviewer",
	"approver",
	"tags",
	"visibility",
	"parent",
	"release",
] as const;
export type TrackedField = (typeof trackedFields)[number];

export interface FieldChange {
	field: TrackedField;
	from: unknown;
	to: unknown;
}

function same(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b)) {
		return (
			a.length === b.length &&
			[...a].sort().join("\u0000") === [...b].sort().join("\u0000")
		);
	}
	return (a ?? null) === (b ?? null);
}

// Each tracked field that differs, from what to what.
export function changesBetween(
	before: Partial<Record<TrackedField, unknown>>,
	after: Partial<Record<TrackedField, unknown>>,
): FieldChange[] {
	const changes: FieldChange[] = [];
	for (const field of trackedFields) {
		if (!(field in after)) continue;
		if (same(before[field], after[field])) continue;
		changes.push({
			field,
			from: before[field] ?? null,
			to: after[field] ?? null,
		});
	}
	return changes;
}

// --- Duplicates ---------------------------------------------------------------

const stopWords = new Set(
	"a an and are as at be by for from has have in is it its of on or that the this to was were will with we our please can could would should need needs want".split(
		" ",
	),
);

export function wordsOf(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/<[^>]+>/g, " ")
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length > 2 && !stopWords.has(word)),
	);
}

// How alike two requests read, between 0 and 1: the overlap of their words,
// with the title counted twice since it says what the request is, and a lift
// when they name the same dataset.
export function likeness(
	a: { title: string; description: string; sources: string[] },
	b: { title: string; description: string; sources: string[] },
): number {
	const words = (item: typeof a) => {
		const title = [...wordsOf(item.title)];
		return new Set([
			...title,
			...title.map((w) => `t:${w}`),
			...wordsOf(item.description),
		]);
	};
	const left = words(a);
	const right = words(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const word of left) if (right.has(word)) shared++;
	const overlap = shared / (left.size + right.size - shared);
	const sameSource = a.sources.some((source) => b.sources.includes(source));
	return Math.min(1, overlap + (sameSource ? 0.15 : 0));
}

// The least likeness offered as a possible duplicate.
export const duplicateAt = 0.3;
