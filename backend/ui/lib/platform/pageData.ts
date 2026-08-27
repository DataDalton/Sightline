import type { Identity } from "../auth/identity";
import { resolvePolicyClass, type PolicyClass } from "../auth/policy";
import { warmSourceAccess } from "../auth/sourceAccess";
import { warmForReader } from "../query/warm";
import { warmUserSession } from "../data/userSession";
import { getSource } from "../semantic/registry";
import type { SemanticField } from "../semantic/types";
import {
	getAccessContext,
	getExplicitContext,
	isAdmin,
	isEditor,
	resolveCategoryAccess,
	resolveReportAccess,
	type AccessContext,
	type Capability,
} from "./access";
import { cachedDefinition } from "./definitionCache";
import { sql } from "../data/lakebase";
import { listFavourites } from "./search";
import { getCategory, getReport } from "./reports";
import { bootstrapReadyAt, ensureReadyOrDegrade } from "./bootstrap";
import { appIdentity, isDatabricksApp } from "../runtime";
import { settings, settingsLoadedAt } from "../settings";
import { registryLoadedAt } from "../semantic/registry";

// What each page needs, answered once and used twice.
//
// A route handler and a server component are asking the same question, and
// until this existed only the route handler could answer it. That made every
// page a waterfall: the document arrived, the bundle arrived, React hydrated,
// and only then did the browser start asking what the page was supposed to
// contain. Four sequential trips before a reader saw a number, three of them
// spent discovering things the server already knew while it was rendering.
//
// Now the server component calls these and hands the answers down as SWR
// fallback data, so the first render has what it needs and the client fetch
// becomes a revalidation rather than the thing being waited on.

// How long a document render will wait for its own data.
//
// Seeding the page is an optimisation, and an optimisation must not be able to
// make things worse. A seed that lands costs nothing, because the render was
// going to happen anyway. A seed that times out costs the whole budget and then
// the client asks regardless, so the budget is really a bet on the work being
// quick, and it is set where a warm instance always wins and a slow one is cut
// off before a reader would notice a blank browser.
//
// Measured warm, the whole shell resolves in single digit milliseconds. What
// takes longer is a replica whose reachability probe has not landed yet, which
// is a handful of requests after a deploy.
const seedBudgetMs = 250;

export async function withinSeedBudget<T>(
	work: () => Promise<T>,
	fallback: T,
): Promise<T> {
	// Not ready on this instance means schema checks, a Lakebase token and a
	// first pool connection, which is a second or more. Started here and not
	// waited for: the client request that follows will wait for the same
	// promise, and it can do that behind a shell that has already drawn rather
	// than in front of a blank document.
	if (bootstrapReadyAt() === 0) {
		void ensureReadyOrDegrade();
		return fallback;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work(),
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(fallback), seedBudgetMs);
			}),
		]);
	} catch (error) {
		console.warn("Page data could not be resolved during render:", error);
		return fallback;
	} finally {
		// The work carries on when the timer won. It is filling the same caches
		// the client request is about to read, so it is not wasted.
		if (timer) clearTimeout(timer);
	}
}

export interface UserPayload {
	email: string;
	name: string;
	initials: string;
	authenticated: boolean;
	canQueryAsUser: boolean;
	policy: {
		id: string;
		grants: string[];
		degraded: boolean;
		stale: boolean;
	};
	canEdit: boolean;
	canAdminister: boolean;
	// The platform actions this caller holds somewhere, so the client can hide
	// a button it would be refused anyway. Names only, not scopes: a scoped
	// capability still shows the affordance, and the server decides when it is
	// used. Hiding a button is a courtesy, never the control.
	capabilities: Capability[];
}

export async function userPayload(
	identity: Identity,
	policy: PolicyClass,
): Promise<UserPayload> {
	const context = await getExplicitContext(policy, identity.email);

	return {
		email: identity.email,
		name: identity.name,
		initials: identity.initials,
		authenticated: identity.authenticated,
		// Tells the client whether on-behalf-of queries are possible at all.
		canQueryAsUser: identity.userToken !== null,
		policy: {
			id: policy.id,
			grants: policy.grants,
			degraded: policy.degraded,
			stale: policy.stale,
		},
		// Capabilities rather than group names, so the client renders the right
		// affordances without having to know how membership is decided.
		//
		// The configured groups are ORed in because they are the floor that
		// keeps an administrator from being locked out by the role tables they
		// would use to fix the role tables.
		canEdit:
			isEditor(policy) ||
			(context.baseline !== null && context.baseline !== "view"),
		canAdminister: isAdmin(policy) || context.baseline === "admin",
		capabilities: [...context.capabilities.keys()],
	};
}

export interface NavigationPayload {
	categories: {
		categoryId: string;
		name: string;
		icon: string | null;
		reportCount: number;
	}[];
	// Reports this reader marked, resolved to something openable. Carried with
	// navigation rather than fetched separately because it is drawn in the same
	// rail, and the seed that puts categories in the document should put these
	// there too.
	favourites: { reportId: string; slug: string; title: string }[];
	degraded: boolean;
}

interface CategoryRow {
	category_id: string;
	name: string;
	icon: string | null;
	sort_order: number;
}

interface ReportRow {
	report_id: string;
	category_id: string | null;
	slug: string;
	title: string;
}

// How many reports in each category this reader may open.
//
// Held apart from navigationPayload so the walk has one place to live and the
// memo above has something to call.
function visibleCounts(
	context: AccessContext,
	reportRows: ReportRow[],
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const report of reportRows) {
		if (!report.category_id) continue;
		const allowed = resolveReportAccess(
			context.grants,
			{
				reportId: report.report_id,
				categoryId: report.category_id,
				isPersonal: false,
				ownerEmail: null,
			},
			context.email,
			"view",
			context.baseline,
		).allowed;
		if (!allowed) continue;
		counts.set(
			report.category_id,
			(counts.get(report.category_id) ?? 0) + 1,
		);
	}
	return counts;
}

export async function navigationPayload(
	identity: Identity,
	policy: PolicyClass,
): Promise<NavigationPayload> {
	const context = await getAccessContext(policy, identity);

	// Ids rather than a count, because the count is per reader and the list is
	// not. Counting in SQL gave everybody the total, so a category read
	// "Sales (12)" and opened on the three reports that reader holds.
	//
	// Personal pages are excluded: they sit in no category, so they would add
	// nothing to a count here, and walking them for every reader on every
	// navigation load would grow with the number of people using the app.
	const [rows, reportRows] = await cachedDefinition(
		"navigation:categories",
		async () =>
			await Promise.all([
				sql<CategoryRow>(
					`SELECT category_id, name, icon, sort_order
					 FROM categories
					 WHERE is_active = TRUE
					 ORDER BY sort_order, name`,
				),
				sql<ReportRow>(
					`SELECT report_id::text AS report_id, category_id, slug, title
					 FROM reports
					 WHERE is_active = TRUE AND is_personal = FALSE`,
				),
			]),
	);

	// Resolved once per reader rather than on every render.
	//
	// The rows are the same for everybody and are cached above. Deciding which
	// of them this reader may open is not, and it was redone on every document
	// request: one resolveReportAccess per active report, per page load. At a
	// few dozen reports that is invisible and at a few thousand it is the most
	// expensive thing the shell does, multiplied by everyone arriving at once.
	//
	// Keyed by policy class and reader because a grant can name either, and
	// carried under the navigation prefix so publishing or removing a report
	// drops it along with the rows it was derived from.
	const visiblePerCategory = await cachedDefinition(
		`navigation:visible:${policy.id}|${context.email.toLowerCase()}`,
		async () => visibleCounts(context, reportRows),
	);

	// Marked reports, filtered through the same resolver as everything else.
	// A grant can be withdrawn after somebody marked a report, and the mark is
	// not a grant, so this is checked on every read rather than at the point it
	// was saved.
	const marked = await listFavourites(context.email).catch(
		() => [] as string[],
	);
	const byId = new Map(reportRows.map((row) => [row.report_id, row]));
	const favourites: NavigationPayload["favourites"] = [];
	for (const reportId of marked) {
		const report = byId.get(reportId);
		if (!report) continue;
		const allowed = resolveReportAccess(
			context.grants,
			{
				reportId: report.report_id,
				categoryId: report.category_id,
				isPersonal: false,
				ownerEmail: null,
			},
			context.email,
			"view",
			context.baseline,
		).allowed;
		if (!allowed) continue;
		favourites.push({
			reportId: report.report_id,
			slug: report.slug,
			title: report.title,
		});
	}

	return {
		categories: rows
			.filter(
				(row) =>
					resolveCategoryAccess(
						context.grants,
						row.category_id,
						"view",
						context.baseline,
					).allowed,
			)
			.map((row) => ({
				categoryId: row.category_id,
				name: row.name,
				icon: row.icon,
				reportCount: visiblePerCategory.get(row.category_id) ?? 0,
			})),
		favourites,
		degraded: policy.degraded,
	};
}

// Field metadata for every source a report reads, so the client can label and
// format values without a second round trip per visual.
function sourcesFor(report: {
	sourceKey: string | null;
	pages: {
		sourceKey: string | null;
		visuals: { sourceKey: string | null }[];
	}[];
}): Record<string, unknown> {
	const keys = new Set<string>();
	if (report.sourceKey) keys.add(report.sourceKey);
	for (const page of report.pages) {
		if (page.sourceKey) keys.add(page.sourceKey);
		for (const visual of page.visuals) {
			if (visual.sourceKey) keys.add(visual.sourceKey);
		}
	}

	const sources: Record<string, unknown> = {};
	for (const key of keys) {
		const source = getSource(key);
		if (!source) continue;
		const field = (f: SemanticField) => ({
			name: f.name,
			displayName: f.displayName,
			dataType: f.dataType,
			formatHint: f.formatHint,
			description: f.description,
			tags: f.tags,
		});
		sources[key] = {
			sourceKey: source.sourceKey,
			title: source.title,
			kind: source.kind,
			defaultTimeField: source.defaultTimeField,
			dimensions: source.dimensions.map(field),
			measures: source.measures.map(field),
		};
	}
	return sources;
}

export async function reportPayload(
	identity: Identity,
	policy: PolicyClass,
	slug: string,
): Promise<{ report: unknown; sources: Record<string, unknown> } | null> {
	const report = await getReport(policy, identity, slug);
	if (!report) return null;
	return { report, sources: sourcesFor(report) };
}

export interface InfoPayload {
	name: string;
	description: string;
	logo: string | null;
	instance: string;
	hosted: boolean;
	settingsLoadedAt: number | null;
	registryLoadedAt: number | null;
	// How long the server keeps an answer. The grid and the matrix hold their
	// own rows outside SWR and used a constant that mirrored this, which was
	// only ever right while both happened to be the same number.
	resultTtlSeconds: number;
}

// What the installation calls itself. No identity in it, but the header cannot
// draw without it, so it travels with the document rather than arriving a round
// trip later and renaming the page under the reader.
export function infoPayload(): InfoPayload {
	const current = settings();
	return {
		name: current.appName,
		description: current.appDescription,
		// Sanitised SVG markup, or null when no mark has been set and the
		// header shows the one built into it. Rebuilt from an allow-list when
		// it was stored, which is what makes it safe to put in the document.
		logo: current.appLogo || null,
		instance: appIdentity.name,
		hosted: isDatabricksApp,
		settingsLoadedAt: settingsLoadedAt() || null,
		registryLoadedAt: registryLoadedAt() || null,
		resultTtlSeconds: current.resultTtlSeconds,
	};
}

export async function categoryPayload(
	identity: Identity,
	policy: PolicyClass,
	categoryId: string,
): Promise<unknown | null> {
	return await getCategory(policy, identity, categoryId);
}

// Everything the shell needs, resolved once for a document request.
//
// The policy class is resolved here rather than in each payload, so a page
// costs one membership lookup rather than one per thing it renders. The
// reachability probe is started and not awaited: nothing on this page needs it,
// and the queries that do will find it warm.
export async function shellPayload(identity: Identity): Promise<{
	policy: PolicyClass;
	user: UserPayload;
	navigation: NavigationPayload;
	info: InfoPayload;
}> {
	const policy = await resolvePolicyClass(identity);

	// Both started and neither awaited. Nothing on this page needs either, and
	// the queries that do will find them ready instead of opening a warehouse
	// session and probing the catalogue after the page has already drawn.
	warmSourceAccess(identity);
	warmUserSession(identity.userToken, identity.email.toLowerCase());

	// Concurrent because both resolve the caller's access, and the second finds
	// the first already in flight rather than repeating it.
	const [user, navigation] = await Promise.all([
		userPayload(identity, policy),
		navigationPayload(identity, policy),
	]);

	// Warms the reports this reader is most likely to open next, which warming
	// did not previously reach: it ran only for the report somebody had already
	// asked for, so the second report of the morning was as cold as the first.
	//
	// Their marked reports first, then what they opened recently. Started and
	// not awaited, guarded inside so it runs once per policy class rather than
	// once per page load, and the answers it leaves serve everybody who sees
	// the same rows rather than only the reader who paid for them.
	warmForReader(
		identity,
		navigation.favourites.map((f) => ({
			reportId: f.reportId,
			slug: f.slug,
		})),
	);

	return { policy, user, navigation, info: infoPayload() };
}
