import {
	builtinTypes,
	checkAboutNames,
	cleanInput,
	type AboutChange,
	type AboutItem,
	type Follow,
	type Impact,
	type NamedDataset,
	type UpdateInput,
} from "../updates/model";
import {
	compileRule,
	type DataRule,
	type RuleKind,
	type RuleParams,
	type RuleSchedule,
	type Severity,
} from "../dataRules/rules";
import { cleanDeckInput, slideLayouts, type Deck } from "../visuals/deck";
import { sources } from "./datasets";

// The rows behind the demo's production sized volumes, built in memory without a
// database so every shape can be tested. lib/demo/scaleContent reads what the demo
// already holds, hands it to these builders and writes what comes back.
//
// Everything is drawn from a seeded generator, so the same seed and the same moment
// give the same rows. Names of tables, repositories and people are invented.

const dayMs = 86_400_000;
const hourMs = 3_600_000;

// --- Seeded generator --------------------------------------------------------------

export interface Random {
	// A number from zero up to but not including one.
	next(): number;
	// A whole number from min to max, both included.
	int(min: number, max: number): number;
	chance(probability: number): boolean;
	pick<T>(items: readonly T[]): T;
	// Picks by weight, each choice paired with how likely it is relative to the rest.
	weighted<T>(choices: readonly (readonly [T, number])[]): T;
	// Up to count items without repeats, in the order drawn.
	sample<T>(items: readonly T[], count: number): T[];
	// A version 4 shaped UUID drawn from this generator.
	uuid(): string;
	hex(length: number): string;
}

// Mulberry32, small and fast, which is all a demo needs from a generator.
export function makeRandom(seed: number): Random {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (min: number, max: number) =>
		min + Math.floor(next() * (max - min + 1));
	const hex = (length: number) => {
		let out = "";
		for (let i = 0; i < length; i += 1) out += int(0, 15).toString(16);
		return out;
	};
	return {
		next,
		int,
		chance: (probability) => next() < probability,
		pick: (items) => items[Math.floor(next() * items.length)],
		weighted: (choices) => {
			const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
			let roll = next() * total;
			for (const [value, weight] of choices) {
				roll -= weight;
				if (roll < 0) return value;
			}
			return choices[choices.length - 1][0];
		},
		sample: (items, count) => {
			const pool = [...items];
			const out: (typeof pool)[number][] = [];
			while (out.length < count && pool.length > 0) {
				const at = Math.floor(next() * pool.length);
				out.push(pool[at]);
				pool.splice(at, 1);
			}
			return out;
		},
		uuid: () =>
			`${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + int(0, 3)).toString(16)}${hex(3)}-${hex(12)}`,
		hex,
	};
}

// --- What the demo holds -------------------------------------------------------------

export interface ScaleReport {
	reportId: string;
	slug: string;
	title: string;
	categoryId: string | null;
	sourceKey: string | null;
}

export interface ScalePage {
	pageId: string;
	reportId: string;
	title: string;
	sourceKey: string | null;
}

export interface ScaleVisual {
	visualId: string;
	pageId: string;
	reportId: string;
	visualType: string;
	title: string | null;
}

// Every demo source with its field names, as an update checks the names it is sent.
export const demoDatasets: NamedDataset[] = sources.map((source) => ({
	sourceKey: source.key,
	title: source.title,
	fields: source.fields.map((field) => field.name),
}));

const datasetByKey = new Map(demoDatasets.map((d) => [d.sourceKey, d]));

// --- Updates ---------------------------------------------------------------------------

// Field names that no longer exist on any demo source, for removals and the old side of
// a rename.
const retiredFieldNames = [
	"Legacy Region Code",
	"Promo Flag",
	"Discount Band",
	"Source System",
	"Batch Number",
	"Load Timestamp",
	"Old Channel Group",
	"Internal Notes",
	"Territory Code",
	"Price Tier",
	"Ledger Code",
	"Cost Group",
	"Record Status",
	"Sync Marker",
	"Fiscal Week Label",
	"Account Owner Code",
];

function oldNameFor(random: Random, name: string): string {
	return random.pick([
		`Total ${name}`,
		`${name} Legacy`,
		name.toLowerCase().replace(/\s+/g, "_"),
		`${name} Old`,
	]);
}

const fieldChangeWeights: [AboutChange, number][] = [
	["added", 35],
	["changed", 35],
	["removed", 15],
	["renamed", 15],
];

// Between one and twelve fields over one to three demo datasets, fewer far more often
// than many. Added, changed and renamed fields carry a real name of their dataset.
export function fieldAbout(random: Random): AboutItem[] {
	const fieldCount = 1 + Math.floor(11 * random.next() ** 2.2);
	const datasetCount = Math.min(
		fieldCount,
		random.weighted([
			[1, 70],
			[2, 22],
			[3, 8],
		] as const),
	);
	const chosen = random.sample(demoDatasets, datasetCount);
	// One change most fields in the entry share, as a release usually does one thing.
	const usual = random.weighted(fieldChangeWeights);
	const unused = new Map(chosen.map((d) => [d.sourceKey, [...d.fields]]));
	const retired = new Map(
		chosen.map((d) => [d.sourceKey, [...retiredFieldNames]]),
	);
	const items: AboutItem[] = [];
	for (let i = 0; i < fieldCount; i += 1) {
		// Every chosen dataset gets one field before any gets a second.
		const dataset = i < chosen.length ? chosen[i] : random.pick(chosen);
		const sourceKey = dataset.sourceKey;
		const real = unused.get(sourceKey)!;
		const invented = retired.get(sourceKey)!;
		let change = random.chance(0.7)
			? usual
			: random.weighted(fieldChangeWeights);
		if (change !== "removed" && real.length === 0) change = "removed";
		if (change === "removed") {
			const at = random.int(0, invented.length - 1);
			const [id] = invented.splice(at, 1);
			items.push({ kind: "field", id, sourceKey, change });
			continue;
		}
		const [id] = real.splice(random.int(0, real.length - 1), 1);
		items.push(
			change === "renamed"
				? {
						kind: "field",
						id,
						sourceKey,
						change,
						from: oldNameFor(random, id),
					}
				: { kind: "field", id, sourceKey, change },
		);
	}
	return items;
}

const tableCatalog = "lake_prd";
const tableLayers = ["bronze", "silver", "gold"];
const tableDomains: Record<string, string[]> = {
	sales: [
		"order_lines",
		"order_headers",
		"quotes",
		"price_lists",
		"returns",
		"invoices",
		"discounts",
		"sales_targets",
		"shipments_planned",
		"order_status",
		"customer_orders",
		"order_payments",
	],
	crm: [
		"account_master",
		"contact_master",
		"opportunities",
		"leads",
		"activities",
		"account_hierarchy",
		"territories",
		"campaign_members",
		"cases",
		"account_owners",
		"consent",
		"segments",
	],
	finance: [
		"gl_entries",
		"cost_centres",
		"budgets",
		"forecasts",
		"exchange_rates",
		"accruals",
		"journal_lines",
		"chart_of_accounts",
		"payables",
		"receivables",
		"fixed_assets",
		"period_close",
	],
	supply: [
		"purchase_orders",
		"suppliers",
		"receipts",
		"stock_levels",
		"stock_moves",
		"warehouses",
		"bin_locations",
		"lead_times",
		"demand_plan",
		"safety_stock",
		"carriers",
		"freight_rates",
	],
	hr: [
		"employees",
		"positions",
		"departments",
		"requisitions",
		"hires",
		"exits",
		"survey_responses",
		"payroll_lines",
		"locations",
		"job_levels",
		"absences",
		"training",
	],
	web: [
		"sessions",
		"page_views",
		"events",
		"carts",
		"checkouts",
		"landing_pages",
		"devices",
		"referrers",
		"experiments",
		"search_terms",
		"product_views",
		"visitors",
	],
	marketing: [
		"campaigns",
		"ad_spend",
		"impressions",
		"clicks",
		"conversions",
		"audiences",
		"email_sends",
		"email_opens",
		"attribution",
		"channels",
		"creatives",
		"budgets_media",
	],
	support: [
		"tickets",
		"ticket_events",
		"agents",
		"queues",
		"sla_targets",
		"satisfaction",
		"macros",
		"escalations",
		"knowledge_articles",
		"chat_sessions",
		"call_logs",
		"ticket_tags",
	],
};
const tableSuffixes = ["", "_history", "_daily", "_snapshot", "_staging"];

// Every schema with every table name it holds, built once.
export const tableSchemas: { schema: string; tables: string[] }[] =
	Object.entries(tableDomains).flatMap(([domain, nouns]) =>
		tableLayers.map((layer) => ({
			schema: `${layer}_${domain}`,
			tables: nouns.flatMap((noun) =>
				tableSuffixes.map((suffix) => `${noun}${suffix}`),
			),
		})),
	);

function tableItems(
	random: Random,
	schemas: { schema: string; tables: string[] }[],
	count: number,
): AboutItem[] {
	const named = (schema: string, table: string): AboutItem => ({
		kind: "table",
		id: `${tableCatalog}.${schema}.${table}`,
	});
	// One table from each schema first, so every schema chosen is named.
	const items = schemas.map((s) => named(s.schema, random.pick(s.tables)));
	const taken = new Set(items.map((item) => item.id));
	const rest = schemas
		.flatMap((s) => s.tables.map((table) => named(s.schema, table)))
		.filter((item) => !taken.has(item.id));
	return [...items, ...random.sample(rest, count - items.length)];
}

// Most entries name a handful of tables in one or two schemas. A few are a migration or
// a reload naming a great many tables over many schemas.
export function tableAbout(random: Random, wide: boolean): AboutItem[] {
	if (wide) {
		const schemaCount = random.int(3, 12);
		const count = random.int(50, 150);
		return tableItems(
			random,
			random.sample(tableSchemas, schemaCount),
			count,
		);
	}
	const count = 1 + Math.floor(9 * random.next() ** 1.8);
	const schemaCount = Math.min(count, random.chance(0.7) ? 1 : 2);
	return tableItems(random, random.sample(tableSchemas, schemaCount), count);
}

export function sourceAbout(random: Random): AboutItem[] {
	const count = random.weighted([
		[1, 75],
		[2, 18],
		[3, 7],
	] as const);
	return random.sample(demoDatasets, count).map((dataset): AboutItem => {
		const change = random.weighted([
			[null, 55],
			["changed", 35],
			["added", 7],
			["removed", 3],
		] as const);
		return change
			? { kind: "source", id: dataset.sourceKey, change }
			: { kind: "source", id: dataset.sourceKey };
	});
}

export function reportAbout(
	random: Random,
	reports: ScaleReport[],
	pages: ScalePage[],
): AboutItem[] {
	const report = random.pick(reports);
	const own = pages.filter((page) => page.reportId === report.reportId);
	if (own.length > 0 && random.chance(0.4)) {
		return random.sample(own, random.int(1, Math.min(3, own.length))).map(
			(page): AboutItem => ({
				kind: "page",
				id: page.pageId,
			}),
		);
	}
	const others = random.sample(
		reports.filter((r) => r.reportId !== report.reportId),
		random.weighted([
			[0, 70],
			[1, 20],
			[2, 10],
		] as const),
	);
	return [report, ...others].map(
		(r): AboutItem => ({ kind: "report", id: r.reportId }),
	);
}

type AboutShape = "fields" | "tables" | "sources" | "reports" | "empty";

const aboutShapes: [AboutShape, number][] = [
	["fields", 40],
	["tables", 25],
	["sources", 15],
	["reports", 10],
	["empty", 10],
];

// Which type of entry fits what it is about, so a page change is not posted as an incident.
const typesFor: Record<AboutShape, [string, number][]> = {
	fields: [
		["dataChange", 75],
		["reportChange", 20],
		["deprecation", 5],
	],
	tables: [
		["dataChange", 75],
		["maintenance", 8],
		["incident", 8],
		["deprecation", 9],
	],
	sources: [
		["dataChange", 45],
		["reportChange", 25],
		["maintenance", 12],
		["incident", 10],
		["deprecation", 8],
	],
	reports: [
		["reportChange", 92],
		["deprecation", 8],
	],
	empty: [
		["announcement", 55],
		["releaseNotes", 25],
		["reportChange", 10],
		["maintenance", 5],
		["incident", 5],
	],
};

const githubNames = [
	"jcarter-data",
	"slee-dev",
	"jreyes",
	"cnguyen-analytics",
	"mellis",
	"rchen-finance",
	"tbrooks-ops",
	"apatel",
	"qharper",
	"pipeline-runner",
	"model-builder",
	"etl-maintainer",
];

// GitHub names an administrator has matched to a demo person. The rest stay unmatched,
// so the screen that asks for a match has some to show.
export function githubAliases(
	people: string[],
): { alias: string; email: string }[] {
	const owners: [string, string][] = [
		["jcarter-data", "jamie.carter@example.com"],
		["slee-dev", "sam.lee@example.com"],
		["jreyes", "jordan.reyes@example.com"],
		["rchen-finance", "riley.chen@example.com"],
		["tbrooks-ops", "taylor.brooks@example.com"],
	];
	return owners
		.filter(([, email]) => people.includes(email))
		.map(([alias, email]) => ({ alias, email }));
}

const announcementTitles = [
	"Reports now remember the last filters used",
	"Scheduled pages can go to a group",
	"Search now finds fields by their description",
	"New page template for comparing periods",
	"Sheets can now be shared with a whole category",
	"Alerts can wait for a second reading before firing",
	"Exports now keep number formats",
	"Dark theme follows the system setting",
	"Data rules show their history on the dataset page",
	"Boards can hold text and images beside visuals",
	"Goals can be set on any measure a report shows",
	"Walkthroughs can be offered once to new readers",
	"Value notes now appear in tooltips",
	"The assistant can explain a single figure",
	"Faster first load on large reports",
];

const reportChangeTitles = [
	(name: string) => `${name} has a new page`,
	(name: string) => `${name} filters were reorganised`,
	(name: string) => `${name} now opens on the last ninety days`,
	(name: string) => `${name} shows targets beside actuals`,
	(name: string) => `Charts on ${name} were redrawn as ranked bars`,
	(name: string) => `${name} has a new headline tile`,
	(name: string) => `${name} now reads from a faster table`,
];

const dataChangeSourceTitles = [
	(name: string) => `${name} now refreshes every hour`,
	(name: string) => `${name} history was backfilled`,
	(name: string) => `${name} now excludes test records`,
	(name: string) => `${name} moved to the new pipeline`,
	(name: string) => `${name} definitions were reviewed`,
	(name: string) => `Late corrections now reach ${name} the same day`,
];

const tableTitles = [
	(where: string, count: number) =>
		count === 1
			? `A table in ${where} was reloaded`
			: `${count} tables in ${where} were reloaded`,
	(where: string, count: number) =>
		count === 1
			? `Load schedule changed for a table in ${where}`
			: `Load schedule changed for ${count} tables in ${where}`,
	(where: string, count: number) =>
		count === 1
			? `A table in ${where} gained a column`
			: `${count} tables in ${where} gained columns`,
	(where: string, count: number) =>
		count === 1
			? `Duplicate rows removed from a table in ${where}`
			: `Duplicate rows removed from ${count} tables in ${where}`,
];

const bodies = [
	"Figures from before the change are restated, so comparisons with last year still line up.",
	"Nothing needs doing on reports that read these through a dataset.",
	"Saved views keep working. Exports taken before today will not match new ones.",
	"The change was tested against a month of history before it went live.",
	"Totals moved by less than a percent on the reports checked.",
	"Questions go to the data platform team through the usual channel.",
	"The previous behaviour stays available for a month under its old name.",
	"Readers will see the new figures after their next refresh.",
	"This brings the definition in line with the finance close.",
	"Older pages that pinned the old field show a warning until they are edited.",
];

const whatToDoLines = [
	"Refresh any exports saved before this change.",
	"Check saved filters that used the old field name.",
	"Edit any page that still shows a warning about a missing field.",
	"Compare one week against the previous figures before sharing them.",
	"Point any extract of your own at the new table.",
	"Acknowledge once your team's reports have been checked.",
];

const beforeAfterPairs: [string, string][] = [
	["Counted when ordered", "Counted when shipped"],
	["Includes cancelled records", "Excludes cancelled records"],
	["Local currency", "Reporting currency"],
	["Calendar month", "Fiscal month"],
	["Refreshed nightly", "Refreshed hourly"],
];

const tagChoices = [
	"pipeline",
	"semantic-layer",
	"reports",
	"backfill",
	"performance",
	"access",
	"definitions",
];

const quietDelivery = {
	banner: false,
	popup: false,
	home: true,
	inbox: false,
	push: false,
	page: true,
};

export interface ScaleUpdate {
	input: UpdateInput;
	postedOn: string;
	createdBy: string;
}

function at(now: number, daysAgo: number, hour: number): string {
	const day = new Date(now - daysAgo * dayMs);
	day.setUTCHours(hour, 0, 0, 0);
	return new Date(Math.min(day.getTime(), now - hourMs)).toISOString();
}

function sourceTitle(key: string): string {
	return datasetByKey.get(key)?.title ?? key;
}

function titleFor(
	random: Random,
	type: string,
	about: AboutItem[],
	reports: ScaleReport[],
	pages: ScalePage[],
): string {
	const fields = about.filter((item) => item.kind === "field");
	const tables = about.filter((item) => item.kind === "table");
	const datasets = about.filter((item) => item.kind === "source");
	const reportItems = about.filter(
		(item) => item.kind === "report" || item.kind === "page",
	);
	const firstReport = reportItems[0]
		? reportItems[0].kind === "report"
			? reports.find((r) => r.reportId === reportItems[0].id)?.title
			: pages.find((p) => p.pageId === reportItems[0].id)?.title
		: undefined;
	const thing = fields[0]
		? sourceTitle(fields[0].sourceKey ?? "")
		: datasets[0]
			? sourceTitle(datasets[0].id)
			: tables[0]
				? tables[0].id.split(".")[1]
				: (firstReport ?? "the platform");

	if (type === "maintenance") return `Planned maintenance on ${thing}`;
	if (type === "incident") {
		return random.pick([
			`${thing} loaded late`,
			`${thing} showed duplicate rows`,
			`${thing} was missing a day`,
			`Slow queries on ${thing}`,
		]);
	}
	if (type === "deprecation") {
		const named = fields[0]?.id ?? thing;
		return random.pick([
			`${named} will be retired`,
			`${named} is being replaced`,
		]);
	}
	if (type === "announcement") return random.pick(announcementTitles);
	if (type === "releaseNotes")
		return `Release notes, week ${random.int(1, 52)}`;
	if (fields.length === 1) {
		const field = fields[0];
		const where = sourceTitle(field.sourceKey ?? "");
		if (field.change === "added") return `${field.id} added to ${where}`;
		if (field.change === "removed")
			return `${field.id} removed from ${where}`;
		if (field.change === "renamed")
			return `${field.from} renamed to ${field.id} on ${where}`;
		return `${field.id} is calculated differently on ${where}`;
	}
	if (fields.length > 1) {
		const keys = new Set(fields.map((f) => f.sourceKey));
		return keys.size === 1
			? `${fields.length} fields updated on ${thing}`
			: `${fields.length} fields updated across ${keys.size} datasets`;
	}
	if (tables.length > 0) {
		const schemas = new Set(tables.map((t) => t.id.split(".")[1]));
		if (schemas.size > 2)
			return `${tables.length} tables across ${schemas.size} schemas moved to new storage`;
		return random.pick(tableTitles)(
			[...schemas].join(" and "),
			tables.length,
		);
	}
	if (datasets.length > 0)
		return random.pick(
			type === "reportChange"
				? reportChangeTitles
				: dataChangeSourceTitles,
		)(thing);
	if (firstReport) return random.pick(reportChangeTitles)(firstReport);
	return random.pick(reportChangeTitles)("Every report");
}

export interface UpdateWorld {
	now: number;
	people: string[];
	reports: ScaleReport[];
	pages: ScalePage[];
}

// The changelog a busy platform builds up over two years. Each entry is passed through
// the same cleaning and name checks a posted update goes through, so a shape the app
// would refuse fails here instead of reaching the table.
export function buildUpdates(
	random: Random,
	world: UpdateWorld,
	count: number,
): ScaleUpdate[] {
	const types = new Map(builtinTypes.map((type) => [type.typeId, type]));
	const out: ScaleUpdate[] = [];
	for (let index = 1; index <= count; index += 1) {
		const drawn = random.weighted(aboutShapes);
		// With no reports to name, an entry about reports names nothing instead.
		const shape =
			drawn === "reports" && world.reports.length === 0 ? "empty" : drawn;
		let about: AboutItem[] = [];
		if (shape === "fields") about = fieldAbout(random);
		if (shape === "tables") about = tableAbout(random, random.chance(0.1));
		if (shape === "sources") about = sourceAbout(random);
		if (shape === "reports")
			about = reportAbout(random, world.reports, world.pages);
		const type = random.weighted(typesFor[shape]);

		// More recent entries are more common, as a platform grows into its changelog.
		const daysAgo = Math.max(
			type === "maintenance" ? 2 : 0,
			Math.floor(730 * random.next() ** 1.3),
		);
		const hour = random.int(7, 18);
		const effectiveOn = at(world.now, daysAgo, hour);
		const backfilled =
			type !== "maintenance" && daysAgo > 14 && random.chance(0.35);
		let postedOn = backfilled
			? at(
					world.now,
					random.int(0, Math.min(45, daysAgo - 1)),
					random.int(7, 18),
				)
			: effectiveOn;

		const impact: Impact =
			type === "incident"
				? random.weighted([
						["breaking", 40],
						["notable", 60],
					] as const)
				: random.weighted([
						["info", 78],
						["notable", 18],
						["breaking", 4],
					] as const);

		const raw: Record<string, unknown> = {
			title: titleFor(random, type, about, world.reports, world.pages),
			body: random.sample(bodies, random.int(1, 3)).join(" "),
			impact,
			about,
			links: [
				{
					label: `Pull request #${1000 + index}`,
					url: `https://example.com/data-platform/pull/${1000 + index}`,
				},
				...(random.chance(0.5)
					? [
							(() => {
								const hash = `${index.toString(16).padStart(4, "0")}${random.hex(36)}`;
								return {
									label: `Commit ${hash.slice(0, 7)}`,
									url: `https://example.com/data-platform/commit/${hash}`,
								};
							})(),
						]
					: []),
			],
			tags: random.sample(
				tagChoices,
				random.weighted([
					[0, 50],
					[1, 35],
					[2, 15],
				] as const),
			),
			reference: `demo-scale-${index}`,
			authors: random.sample(
				[
					...world.people,
					...githubNames.map((name) => `github:${name}`),
				],
				random.weighted([
					[1, 60],
					[2, 30],
					[3, 10],
				] as const),
			),
			delivery: quietDelivery,
			requireAck: random.chance(0.03),
			whatToDo: random.chance(0.15) ? random.pick(whatToDoLines) : null,
		};
		if (backfilled) {
			raw.placement = "history";
			raw.effectiveOn = effectiveOn;
		} else if (type !== "announcement" && type !== "releaseNotes") {
			raw.effectiveOn = effectiveOn;
		}
		if (type === "maintenance") {
			const start = new Date(effectiveOn);
			start.setUTCHours(22, 0, 0, 0);
			raw.startsOn = start.toISOString();
			raw.endsOn = new Date(
				start.getTime() + random.int(2, 6) * hourMs,
			).toISOString();
			raw.effectiveOn = raw.startsOn;
			postedOn = new Date(
				start.getTime() - random.int(3, 7) * dayMs,
			).toISOString();
		}
		if (type === "incident") {
			raw.incidentState = "resolved";
			raw.periodFrom = effectiveOn;
			raw.periodTo = new Date(
				new Date(effectiveOn).getTime() + random.int(1, 8) * hourMs,
			).toISOString();
		}
		if (type === "deprecation" && !backfilled) {
			postedOn = new Date(
				new Date(effectiveOn).getTime() - random.int(14, 45) * dayMs,
			).toISOString();
		}
		if (
			about.length === 1 &&
			about[0].kind === "field" &&
			about[0].change === "changed" &&
			random.chance(0.5)
		) {
			const [before, after] = random.pick(beforeAfterPairs);
			raw.before = before;
			raw.after = after;
		}

		const input = cleanInput(raw, types.get(type));
		input.about = checkAboutNames(input.about, demoDatasets);
		out.push({ input, postedOn, createdBy: random.pick(world.people) });
	}
	return out;
}

export interface UpdateRead {
	index: number;
	email: string;
	readOn: string;
	ackedOn: string | null;
}

// Each person has read most of what was posted, the newest least of all, and has
// acknowledged most of what asked for it.
export function buildReads(
	random: Random,
	updates: ScaleUpdate[],
	people: string[],
	now: number,
): UpdateRead[] {
	const out: UpdateRead[] = [];
	updates.forEach((update, offset) => {
		const posted = new Date(update.postedOn).getTime();
		for (const email of people) {
			if (!random.chance(0.6)) continue;
			const readOn = new Date(
				Math.min(now - 60_000, posted + random.int(1, 96) * hourMs),
			).toISOString();
			out.push({
				index: offset + 1,
				email,
				readOn,
				ackedOn:
					update.input.requireAck && random.chance(0.85)
						? readOn
						: null,
			});
		}
	});
	return out;
}

const noteLines = [
	"Checked our team's pages and the totals match.",
	"Our weekly export picked this up without changes.",
	"Saved filters on two pages needed the new field name.",
	"Finance confirmed the restated months.",
	"Noticed a small difference in the first week, now explained.",
	"Updated the extract our team keeps.",
	"Told the regional leads.",
	"No impact on the board pack.",
];

export interface UpdateNote {
	index: number;
	email: string;
	at: string;
	note: string;
}

// Notes people added under a few of the entries, each by someone different.
export function buildNotes(
	random: Random,
	updates: ScaleUpdate[],
	people: string[],
	now: number,
): UpdateNote[] {
	const out: UpdateNote[] = [];
	updates.forEach((update, offset) => {
		if (!random.chance(0.05)) return;
		const posted = new Date(update.postedOn).getTime();
		const authors = random.sample(people, random.int(1, 4));
		authors.forEach((email, order) => {
			out.push({
				index: offset + 1,
				email,
				at: new Date(
					Math.min(
						now - 60_000,
						posted + (order + 1) * random.int(2, 30) * hourMs,
					),
				).toISOString(),
				note: random.pick(noteLines),
			});
		});
	});
	return out;
}

export interface FollowRow extends Follow {
	email: string;
}

// Two to five follows each, over everything, a type, a dataset or a field.
export function buildFollows(random: Random, people: string[]): FollowRow[] {
	const options: Pick<Follow, "kind" | "value">[] = [
		{ kind: "all", value: "" },
		...builtinTypes.map((type) => ({
			kind: "type" as const,
			value: type.typeId,
		})),
		...demoDatasets.map((d) => ({
			kind: "source" as const,
			value: d.sourceKey,
		})),
		...demoDatasets.flatMap((d) =>
			d.fields
				.slice(0, 3)
				.map((name) => ({ kind: "field" as const, value: name })),
		),
	];
	return people.flatMap((email) =>
		random.sample(options, random.int(2, 5)).map((follow) => ({
			...follow,
			email,
			mode: random.chance(0.7)
				? ("instant" as const)
				: ("digest" as const),
		})),
	);
}

// --- Data rules --------------------------------------------------------------------------

export interface RuleSpec {
	name: string;
	kind: RuleKind;
	params: RuleParams;
	severity: Severity;
	schedule: RuleSchedule;
	groupBy?: string;
	recentColumn?: string;
	recentDays?: number;
	allowFailing?: number;
	// For an allowed values rule, the column whose values today are the ones allowed.
	valuesFrom?: string;
}

const notBlank = (
	column: string,
	label: string,
	severity: Severity = "warning",
	groupBy?: string,
): RuleSpec => ({
	name: `Every row has a ${label}`,
	kind: "notBlank",
	params: { column },
	severity,
	schedule: "afterLoad",
	...(groupBy ? { groupBy } : {}),
});
const unique = (columns: string[], label: string): RuleSpec => ({
	name: `${label} appears once`,
	kind: "unique",
	params: { columns },
	severity: "critical",
	schedule: "afterLoad",
});
const range = (
	column: string,
	label: string,
	min: number | null,
	max: number | null,
	severity: Severity = "warning",
): RuleSpec => ({
	name: label,
	kind: "range",
	params: { column, min, max },
	severity,
	schedule: "afterLoad",
});
const allowed = (column: string, label: string): RuleSpec => ({
	name: `${label} is a known value`,
	kind: "allowedValues",
	params: { column, values: [] },
	severity: "warning",
	schedule: "daily",
	valuesFrom: column,
});
const crossField = (
	left: string,
	op: string,
	right: string,
	label: string,
): RuleSpec => ({
	name: label,
	kind: "crossField",
	params: { left, op, right },
	severity: "critical",
	schedule: "afterLoad",
});
const rowCount = (dateColumn: string, days: number): RuleSpec => ({
	name: "Row count holds steady",
	kind: "rowCountShift",
	params: { shiftPercent: 30 },
	severity: "warning",
	schedule: "daily",
	recentColumn: dateColumn,
	recentDays: days,
});
const spread = (column: string, label: string): RuleSpec => ({
	name: `${label} keeps its spread`,
	kind: "distributionShift",
	params: { column, shiftPercent: 25 },
	severity: "warning",
	schedule: "daily",
});

// Checks on each demo table, written against its real columns.
export const ruleSpecs: Record<string, RuleSpec[]> = {
	sales_orders: [
		notBlank("country", "country"),
		notBlank("product", "product", "critical"),
		notBlank("sales_rep", "sales rep", "warning", "region"),
		range("quantity", "Quantity is between one and five hundred", 1, 500),
		range("cost", "Cost is never negative", 0, null, "critical"),
		crossField("cost", "<=", "revenue", "Cost never exceeds revenue"),
		allowed("customer_segment", "Customer segment"),
		rowCount("order_date", 7),
		spread("product_category", "Product category"),
	],
	support_tickets: [
		unique(["ticket_id"], "Every ticket ID"),
		notBlank("team", "team"),
		allowed("priority", "Priority"),
		allowed("status", "Status"),
		range(
			"first_response_minutes",
			"First response within a week",
			0,
			10080,
		),
		range(
			"satisfaction",
			"Satisfaction is between one and five",
			1,
			5,
			"critical",
		),
		range("resolution_hours", "Resolution time is never negative", 0, null),
		rowCount("opened_on", 7),
		spread("channel", "Channel"),
	],
	marketing_campaigns: [
		notBlank("campaign", "campaign", "critical"),
		allowed("channel", "Channel"),
		range("spend", "Spend is never negative", 0, null, "critical"),
		crossField(
			"clicks",
			"<=",
			"impressions",
			"Clicks never exceed impressions",
		),
		crossField(
			"conversions",
			"<=",
			"clicks",
			"Conversions never exceed clicks",
		),
		range(
			"attributed_revenue",
			"Attributed revenue is never negative",
			0,
			null,
		),
		rowCount("day", 7),
		spread("audience", "Audience"),
	],
	finance_ledger: [
		unique(
			["month", "department", "account_group", "cost_center"],
			"Each month, department, account and cost centre",
		),
		notBlank("department", "department", "critical"),
		allowed("account_group", "Account group"),
		allowed("cost_center", "Cost centre"),
		range("actual", "Actual spend is never negative", 0, null),
		range("budget", "Budget is never negative", 0, null),
		range("forecast", "Forecast is never negative", 0, null),
		spread("department", "Department"),
	],
	operations_shipments: [
		unique(["shipment_id"], "Every shipment ID"),
		allowed("carrier", "Carrier"),
		allowed("service_level", "Service level"),
		range("actual_days", "Delivery takes under sixty days", 0, 60),
		range(
			"freight_cost",
			"Freight cost is never negative",
			0,
			null,
			"critical",
		),
		range("weight_kg", "Weight is within what a carrier takes", 0, 30000),
		notBlank(
			"destination_region",
			"destination region",
			"warning",
			"warehouse",
		),
		rowCount("ship_date", 7),
		spread("warehouse", "Warehouse"),
	],
	people_headcount: [
		unique(
			["month", "department", "location", "level"],
			"Each month, department, location and level",
		),
		notBlank("department", "department", "critical"),
		allowed("level", "Level"),
		allowed("location", "Location"),
		range("headcount", "Headcount is never negative", 0, null, "critical"),
		crossField(
			"exits",
			"<=",
			"headcount",
			"Leavers never exceed headcount",
		),
		range("engagement", "Engagement is between one and five", 1, 5),
		range("salary_cost", "Salary cost is never negative", 0, null),
	],
	web_sessions: [
		allowed("traffic_source", "Traffic source"),
		allowed("device", "Device"),
		crossField(
			"bounces",
			"<=",
			"sessions",
			"Bounces never exceed sessions",
		),
		crossField("orders", "<=", "sessions", "Orders never exceed sessions"),
		crossField(
			"add_to_carts",
			"<=",
			"sessions",
			"Add to carts never exceed sessions",
		),
		range("revenue", "Web revenue is never negative", 0, null, "critical"),
		notBlank("landing_page", "landing page"),
		rowCount("day", 7),
		spread("country", "Country"),
	],
};

export interface BuiltRule {
	sourceKey: string;
	table: string;
	spec: RuleSpec;
	owner: string;
}

// Every rule for every source the demo has a table for, with allowed values taken from
// what the table holds today. Each one is compiled as the runner would compile it, so a
// rule that names nothing sensible fails here.
export function buildRules(
	random: Random,
	tableOf: (sourceKey: string) => string | null,
	valuesOf: (sourceKey: string, column: string) => string[],
	people: string[],
): BuiltRule[] {
	return Object.entries(ruleSpecs).flatMap(([sourceKey, specs]) => {
		const table = tableOf(sourceKey);
		if (!table) return [];
		return specs.map((held) => {
			const spec: RuleSpec = held.valuesFrom
				? {
						...held,
						params: {
							...held.params,
							values: valuesOf(sourceKey, held.valuesFrom),
						},
					}
				: held;
			const rule: DataRule = {
				ruleId: "check",
				sourceKey,
				table,
				name: spec.name,
				kind: spec.kind,
				params: spec.params,
				severity: spec.severity,
				owner: null,
				groupBy: spec.groupBy ?? null,
				recentColumn: spec.recentColumn ?? null,
				recentDays: spec.recentDays ?? null,
				schedule: spec.schedule,
				budgetSeconds: 300,
				allowFailing: spec.allowFailing ?? 0,
				isActive: true,
			};
			compileRule(rule);
			return { sourceKey, table, spec, owner: random.pick(people) };
		});
	});
}

export interface RuleRun {
	ruleIndex: number;
	runOn: string;
	status: "pass" | "fail" | "error";
	failing: number | null;
	checked: number | null;
	groups: { label: string; failing: number; checked: number }[];
	measures: Record<string, number>;
	error: string | null;
	durationMs: number;
}

export interface RuleIncident {
	ruleIndex: number;
	severity: Severity;
	openedOn: string;
	resolvedOn: string | null;
}

// Which days a rule failed on, counted back from today. A few rules fail on a run of
// days now and then, and the ones listed in failingToday are failing as of today.
export function failureDays(
	random: Random,
	days: number,
	failingNow: boolean,
): Set<number> {
	const failed = new Set<number>();
	if (failingNow) {
		const length = random.int(1, 4);
		for (let d = 0; d < length; d += 1) failed.add(d);
	}
	if (random.chance(0.25)) {
		const streaks = random.int(1, 2);
		for (let s = 0; s < streaks; s += 1) {
			const start = random.int(6, days - 8);
			const length = random.int(2, 6);
			for (let d = start; d < start + length; d += 1) failed.add(d);
		}
	}
	return failed;
}

// A run a day for each rule over the period, today's included, and an incident for each
// run of failures, still open where it reaches today.
export function buildRuleRuns(
	random: Random,
	rules: {
		kind: RuleKind;
		severity: Severity;
		rowCount: number;
		groupLabels: string[];
	}[],
	days: number,
	now: number,
	failingToday: number[],
): { runs: RuleRun[]; incidents: RuleIncident[] } {
	const runs: RuleRun[] = [];
	const incidents: RuleIncident[] = [];
	rules.forEach((rule, ruleIndex) => {
		const failed = failureDays(
			random,
			days,
			failingToday.includes(ruleIndex),
		);
		let openSince: number | null = null;
		for (let d = days - 1; d >= 0; d -= 1) {
			const runOn = now - d * dayMs - random.int(5, 90) * 60_000;
			// The table grew over the period, so older runs checked fewer rows.
			const checked = Math.max(
				1,
				Math.round(rule.rowCount * (1 - (d / days) * 0.08)),
			);
			const error = !failed.has(d) && random.chance(0.004);
			const fail = failed.has(d);
			const failing = fail
				? random.int(1, Math.max(2, Math.round(checked * 0.01)))
				: 0;
			const shift =
				rule.kind === "rowCountShift" ||
				rule.kind === "distributionShift";
			const measures: Record<string, number> = shift
				? { checked: fail ? Math.round(checked * 0.6) : checked }
				: {};
			if (rule.kind === "distributionShift") {
				measures.distinctValues = Math.max(1, rule.groupLabels.length);
				measures.blankShare = fail ? random.int(5, 20) : 0;
			}
			runs.push({
				ruleIndex,
				runOn: new Date(runOn).toISOString(),
				status: error ? "error" : fail ? "fail" : "pass",
				failing: error ? null : shift ? (fail ? 1 : 0) : failing,
				checked: error ? null : checked,
				groups:
					fail && rule.groupLabels.length > 0 && !shift
						? random
								.sample(
									rule.groupLabels,
									random.int(
										1,
										Math.min(3, rule.groupLabels.length),
									),
								)
								.map((label) => ({
									label,
									failing: Math.max(
										1,
										Math.round(failing / 2),
									),
									checked: Math.round(
										checked / rule.groupLabels.length,
									),
								}))
						: [],
				measures,
				error: error ? "The warehouse did not answer in time." : null,
				durationMs: random.int(30, 2400),
			});
			if (fail && openSince === null) openSince = runOn;
			if (!fail && !error && openSince !== null) {
				incidents.push({
					ruleIndex,
					severity: rule.severity,
					openedOn: new Date(openSince).toISOString(),
					resolvedOn: new Date(runOn).toISOString(),
				});
				openSince = null;
			}
		}
		if (openSince !== null) {
			incidents.push({
				ruleIndex,
				severity: rule.severity,
				openedOn: new Date(openSince).toISOString(),
				resolvedOn: null,
			});
		}
	});
	return { runs, incidents };
}

// --- Goals -------------------------------------------------------------------------------

// Measures where less is the aim, so a goal on one sets its target below today.
const lowerIsBetterPattern =
	/(cost|minutes|hours|days|escalation|bounce|attrition|damage|variance|late|exits)/i;

export function lowerIsBetter(measure: string): boolean {
	return lowerIsBetterPattern.test(measure);
}

export interface GoalPlan {
	reportId: string;
	sourceKey: string;
	measure: string;
	title: string;
	createdBy: string;
	dueInDays: number;
	// How far the target sits from today's figure, as a share of it.
	stretch: number;
	lowerIsBetter: boolean;
	filter: { field: string; value: string } | null;
}

// Two to four goals on each report, each on a measure one of its pages shows.
export function buildGoals(
	random: Random,
	reports: {
		reportId: string;
		measures: { sourceKey: string; measure: string }[];
	}[],
	people: string[],
	filterChoices: (sourceKey: string) => { field: string; values: string[] }[],
): GoalPlan[] {
	return reports.flatMap((report) => {
		if (report.measures.length === 0) return [];
		const chosen = random.sample(report.measures, random.int(2, 4));
		return chosen.map((held) => {
			const lower = lowerIsBetter(held.measure);
			const choices = filterChoices(held.sourceKey).filter(
				(c) => c.values.length > 0,
			);
			const field =
				choices.length > 0 && random.chance(0.35)
					? random.pick(choices)
					: null;
			const filter = field
				? { field: field.field, value: random.pick(field.values) }
				: null;
			const verb = lower
				? random.pick(["Bring down", "Reduce", "Cut"])
				: random.pick(["Grow", "Lift", "Raise"]);
			return {
				reportId: report.reportId,
				sourceKey: held.sourceKey,
				measure: held.measure,
				title: `${verb} ${held.measure}${filter ? ` in ${filter.value}` : ""}`,
				createdBy: random.pick(people),
				dueInDays: random.int(14, 180),
				stretch: random.int(4, 20) / 100,
				lowerIsBetter: lower,
				filter,
			};
		});
	});
}

// A reader's daily reading of a goal's measure, walking toward where it stands today.
export function goalHistory(
	random: Random,
	current: number,
	days: number,
	lower: boolean,
): { daysAgo: number; value: number }[] {
	const drift = random.int(2, 12) / 1000;
	return Array.from({ length: days }, (_, i) => {
		const daysAgo = i + 1;
		const trend = lower
			? 1 + drift * daysAgo * 0.1
			: 1 - drift * daysAgo * 0.1;
		const noise = 1 + (random.next() - 0.5) * 0.02;
		return { daysAgo, value: current * trend * noise };
	});
}

// --- Decks -------------------------------------------------------------------------------

export interface DeckReport {
	reportId: string;
	title: string;
	pages: {
		pageId: string;
		title: string;
		visuals: { visualId: string; title: string | null }[];
	}[];
}

const stepLines = [
	"Start here for the headline figure.",
	"This shows how the period compares with the last one.",
	"The largest groups sit at the top.",
	"Look for the dip, which the note on this visual explains.",
	"Filters at the top change every visual on the page.",
	"Hover a bar to see the exact figure.",
	"This is where the target is set.",
	"The table underneath lists every row behind the chart.",
];

// A walkthrough or a set of slides over the report's own pages and visuals, kept as the
// server keeps one somebody saves.
export function buildDeck(
	random: Random,
	report: DeckReport,
	kind: Deck["kind"],
): Omit<Deck, "deckId" | "epoch"> {
	const pages = report.pages.filter((page) => page.visuals.length > 0);
	const steps =
		kind === "walkthrough"
			? pages.flatMap((page) =>
					random
						.sample(
							page.visuals,
							random.int(1, Math.min(3, page.visuals.length)),
						)
						.map((visual) => ({
							title: visual.title ?? page.title,
							text: random.pick(stepLines),
							pageId: page.pageId,
							visualId: visual.visualId,
							mark: random.chance(0.4)
								? random.pick(["highlight", "callout", "arrow"])
								: null,
						})),
				)
			: pages.map((page) => {
					const layout = random.pick(
						slideLayouts.filter(
							(l) =>
								l.rects.length > 0 &&
								l.rects.length <= page.visuals.length,
						),
					);
					return {
						title: page.title,
						text: random.pick(stepLines),
						pageId: page.pageId,
						layout: layout.id,
						visualIds: random
							.sample(page.visuals, layout.rects.length)
							.map((v) => v.visualId),
					};
				});
	return cleanDeckInput(
		{
			kind,
			title:
				kind === "walkthrough"
					? `A tour of ${report.title}`
					: `${report.title} for the monthly review`,
			steps,
			promptOnce: kind === "walkthrough" && random.chance(0.5),
		},
		() => random.uuid(),
	);
}

// --- Notes and conversations -------------------------------------------------------------

const valueNoteLines = [
	(value: string) =>
		`${value} was reorganised this quarter, so earlier months are not comparable.`,
	(value: string) =>
		`Figures for ${value} include a one off correction in the spring.`,
	(value: string) =>
		`${value} is being reviewed. Treat recent figures as provisional.`,
	(value: string) =>
		`${value} moved to a new system, which explains the gap in the history.`,
	(value: string) =>
		`Ask the regional lead before quoting ${value} externally.`,
	(value: string) =>
		`${value} had a promotion running, which lifted the totals.`,
];

const replyLines = [
	"Thanks, that explains the jump.",
	"Is there a date when this will be settled?",
	"Confirmed with the team.",
	"Added this to the monthly pack.",
	"Should this carry over into next year?",
];

export interface ValueNotePlan {
	sourceKey: string;
	field: string;
	value: string;
	body: string;
	author: string;
	createdDaysAgo: number;
	// Days from now, negative for a note that has already expired, or null for one that stays.
	expiresInDays: number | null;
	replies: { author: string; body: string; hoursAfter: number }[];
}

export function buildValueNotes(
	random: Random,
	choices: { sourceKey: string; field: string; values: string[] }[],
	people: string[],
	count: number,
): ValueNotePlan[] {
	const usable = choices.filter((c) => c.values.length > 0);
	if (usable.length === 0) return [];
	return Array.from({ length: count }, () => {
		const choice = random.pick(usable);
		const value = random.pick(choice.values);
		const author = random.pick(people);
		const createdDaysAgo = random.int(1, 300);
		const expiry = random.weighted([
			["none", 65],
			["past", 20],
			["future", 15],
		] as const);
		return {
			sourceKey: choice.sourceKey,
			field: choice.field,
			value,
			body: random.pick(valueNoteLines)(value),
			author,
			createdDaysAgo,
			expiresInDays:
				expiry === "none"
					? null
					: expiry === "past"
						? -random.int(1, Math.max(1, createdDaysAgo - 1))
						: random.int(7, 120),
			replies: random
				.sample(
					people.filter((p) => p !== author),
					random.weighted([
						[0, 35],
						[1, 30],
						[2, 20],
						[3, 10],
						[4, 5],
					] as const),
				)
				.map((who, i) => ({
					author: who,
					body: random.pick(replyLines),
					hoursAfter: (i + 1) * random.int(1, 48),
				})),
		};
	});
}

const visualNoteLines = [
	"The dip here is the warehouse move.",
	"This month includes a late batch of orders.",
	"Target changed at the start of the year.",
	"Numbers here exclude the pilot region.",
	"Spike is the holiday promotion.",
	"Restated after the correction to returns.",
	"Lower than usual because of the public holiday.",
];

export interface VisualNotePlan {
	visual: ScaleVisual;
	author: string;
	body: string;
	createdDaysAgo: number;
	anchoredDaysAgo: number | null;
}

export function buildVisualNotes(
	random: Random,
	visuals: ScaleVisual[],
	people: string[],
	count: number,
): VisualNotePlan[] {
	if (visuals.length === 0) return [];
	// Notes gather on some visuals rather than spreading evenly over all of them.
	const noted = random.sample(
		visuals,
		Math.max(1, Math.ceil(visuals.length / 4)),
	);
	return Array.from({ length: count }, () => {
		const createdDaysAgo = random.int(1, 365);
		return {
			visual: random.pick(noted),
			author: random.pick(people),
			body: random.pick(visualNoteLines),
			createdDaysAgo,
			anchoredDaysAgo: random.chance(0.4)
				? createdDaysAgo + random.int(0, 30)
				: null,
		};
	});
}

const threadSubjects = [
	(name: string) => `Question about ${name}`,
	(name: string) => `Totals on ${name} look different this week`,
	(name: string) => `Can ${name} show last quarter as well`,
	(name: string) => `Where does ${name} get its targets`,
	(name: string) => `Access to ${name} for a new starter`,
];

const threadLines = [
	"Could someone take a look when there is a moment?",
	"The figure in the headline tile does not match the table underneath.",
	"Looked into it. The difference is the late orders, which arrive overnight.",
	"That makes sense, thank you.",
	"Added a note on the visual so the next person sees it.",
	"Is this the same definition finance uses?",
	"Yes, it was aligned last month.",
	"Happy to walk through it on a call.",
];

export interface ThreadPlan {
	author: string;
	categoryId: string;
	reportSlug: string | null;
	subject: string;
	recipients: { type: "user" | "group"; id: string }[];
	startedDaysAgo: number;
	messages: { author: string; body: string; hoursAfter: number }[];
}

export function buildThreads(
	random: Random,
	categories: {
		id: string;
		maintainers: { type: "user" | "group"; id: string }[];
		reports: { slug: string; title: string }[];
	}[],
	people: string[],
	count: number,
): ThreadPlan[] {
	const usable = categories.filter(
		(c) => c.maintainers.length > 0 && c.reports.length > 0,
	);
	if (usable.length === 0) return [];
	return Array.from({ length: count }, () => {
		const category = random.pick(usable);
		const report = random.pick(category.reports);
		const author = random.pick(people);
		const recipients = category.maintainers
			.filter((m) => !(m.type === "user" && m.id === author))
			.slice(0, 3);
		const responders = recipients
			.filter((m) => m.type === "user")
			.map((m) => m.id);
		const voices = [
			author,
			...(responders.length > 0
				? responders
				: people.filter((p) => p !== author).slice(0, 1)),
		];
		const length = random.int(1, 6);
		return {
			author,
			categoryId: category.id,
			reportSlug: random.chance(0.7) ? report.slug : null,
			subject: random.pick(threadSubjects)(report.title),
			recipients,
			startedDaysAgo: random.int(1, 200),
			messages: Array.from({ length }, (_, i) => ({
				author: i === 0 ? author : random.pick(voices),
				body: random.pick(threadLines),
				hoursAfter: i * random.int(1, 30),
			})),
		};
	});
}
