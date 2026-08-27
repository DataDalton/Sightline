import { sql } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { cachedDefinition } from "./definitionCache";
import {
	getAccessContext,
	resolveCategoryAccess,
	resolveReportAccess,
	type AccessContext,
} from "./access";
import type { Capability } from "./accessRules";

// What a person can navigate to, in one answer.
//
// Everything reachable in this app is reachable by walking the sidebar, and
// nothing is reachable any other way. That scales against the thing the
// platform is for: the estate grows and the only route to a report gets longer.
//
// This is the list the palette filters. Resolved server-side through the same
// resolver navigation uses, because a palette that offers a report the caller
// then cannot open is worse than no palette at all.

export type TargetKind =
	| "report"
	| "category"
	| "personal"
	| "shared"
	| "view"
	| "action";

export interface SearchTarget {
	id: string;
	kind: TargetKind;
	title: string;
	// Where it sits, shown beside the title so two reports with the same name
	// in different categories are told apart.
	context: string | null;
	href: string;
	// Matched against in addition to the title. Carries the description and
	// the slug, so searching a term that appears in neither the title nor the
	// category still finds it.
	keywords: string;
}

interface ReportRow {
	report_id: string;
	slug: string;
	title: string;
	description: string | null;
	category_id: string | null;
	is_personal: boolean;
	owner_email: string | null;
}

interface CategoryRow {
	category_id: string;
	name: string;
	description: string | null;
}

interface ViewRow {
	view_id: string;
	name: string;
	report_slug: string | null;
	page_id: string;
	report_title: string | null;
}

// Destinations that are not content. Listed so the palette can take somebody
// somewhere as well as to something, which is what makes it worth opening when
// you already know where you are going.
const actions: {
	id: string;
	title: string;
	href: string;
	keywords: string;
	capability?: Capability;
}[] = [
	{ id: "home", title: "Home", href: "/", keywords: "start overview" },
	{
		id: "mine",
		title: "My pages",
		href: "/mine",
		keywords: "personal shared with me saved questions",
	},
	{
		id: "admin",
		title: "Administration",
		href: "/admin",
		keywords: "settings usage security platform configuration",
		capability: "settings.manage",
	},
	{
		id: "admin-access",
		title: "Roles and access",
		href: "/admin?section=security",
		keywords: "permissions grants assignments who holds what",
		capability: "access.grant",
	},
	{
		id: "admin-sources",
		title: "Sources",
		href: "/admin?section=platform",
		keywords: "datasets catalogue sync register",
		capability: "semantic.sync",
	},
	{
		id: "admin-categories",
		title: "Categories",
		href: "/admin?section=platform",
		keywords: "navigation sections order",
		capability: "category.manage",
	},
];

export async function searchTargets(
	identity: Identity,
	policy: PolicyClass,
): Promise<SearchTarget[]> {
	const context = await getAccessContext(policy, identity);
	const email = context.email.toLowerCase();

	// The rows themselves are the same for everybody, so they are cached once
	// and filtered per caller below. Caching the filtered answer instead would
	// key the cache on the reader, which is a cache entry per person.
	const [reports, categories] = await cachedDefinition(
		"search:content",
		async () =>
			await Promise.all([
				sql<ReportRow>(
					`SELECT report_id::text AS report_id, slug, title, description,
					        category_id, is_personal, owner_email
					 FROM reports
					 WHERE is_active = TRUE`,
				),
				sql<CategoryRow>(
					`SELECT category_id, name, description
					 FROM categories
					 WHERE is_active = TRUE`,
				),
			]),
	);

	// Built once per reader rather than on every keystroke that reaches the
	// server.
	//
	// The rows are shared and cached above; deciding which of them this reader
	// may open is per reader and was redone on every search. That is one
	// resolver call per active report and category, per request, and search is
	// the one endpoint a person hits repeatedly in a few seconds.
	//
	// Carried under the search prefix so publishing or removing content drops
	// it with the rows it came from.
	return await cachedDefinition(
		`search:targets:${policy.id}|${email}`,
		async () => buildTargets(context, policy, email, reports, categories),
	);
}

async function buildTargets(
	context: AccessContext,
	policy: PolicyClass,
	email: string,
	reports: ReportRow[],
	categories: CategoryRow[],
): Promise<SearchTarget[]> {
	const categoryNames = new Map(
		categories.map((row) => [row.category_id, row.name]),
	);

	const targets: SearchTarget[] = [];

	for (const row of categories) {
		if (
			!resolveCategoryAccess(
				context.grants,
				row.category_id,
				"view",
				context.baseline,
			).allowed
		) {
			continue;
		}
		targets.push({
			id: `category:${row.category_id}`,
			kind: "category",
			title: row.name,
			context: null,
			href: `/c/${encodeURIComponent(row.category_id)}`,
			keywords: `${row.description ?? ""} ${row.category_id}`,
		});
	}

	for (const row of reports) {
		const check = resolveReportAccess(
			context.grants,
			{
				reportId: row.report_id,
				categoryId: row.category_id,
				isPersonal: row.is_personal,
				ownerEmail: row.owner_email,
			},
			context.email,
			"view",
			context.baseline,
		);
		if (!check.allowed) continue;

		// A personal page reached by an administrator is not one of their
		// things, and listing it beside their own would say it was. It stays
		// findable by name, marked as somebody else's.
		const own = row.is_personal && row.owner_email?.toLowerCase() === email;

		targets.push({
			id: `report:${row.report_id}`,
			kind: row.is_personal ? (own ? "personal" : "shared") : "report",
			title: row.title,
			context: row.is_personal
				? own
					? "My pages"
					: (row.owner_email ?? "Shared")
				: (categoryNames.get(row.category_id ?? "") ?? null),
			href: `/r/${row.slug}`,
			keywords: `${row.description ?? ""} ${row.slug}`,
		});
	}

	// Saved views are a destination people name themselves, which makes them
	// the thing most often searched for by a word that appears nowhere else.
	const views = await sql<ViewRow>(
		`SELECT v.view_id::text AS view_id, v.name, v.page_id::text AS page_id,
		        r.slug AS report_slug, r.title AS report_title
		 FROM saved_views v
		 LEFT JOIN reports r ON r.report_id = v.report_id
		 WHERE (lower(v.owner_email) = $1
		        OR (v.is_shared = TRUE AND v.shared_with && $2::text[]))
		   AND r.is_active = TRUE`,
		[email, policy.grants],
	).catch(() => [] as ViewRow[]);

	for (const row of views) {
		if (!row.report_slug) continue;
		targets.push({
			id: `view:${row.view_id}`,
			kind: "view",
			title: row.name,
			context: row.report_title,
			href: `/r/${row.report_slug}?view=${encodeURIComponent(row.view_id)}`,
			keywords: "saved view",
		});
	}

	for (const action of actions) {
		if (action.capability && !context.capabilities.has(action.capability)) {
			continue;
		}
		targets.push({
			id: `action:${action.id}`,
			kind: "action",
			title: action.title,
			context: null,
			href: action.href,
			keywords: action.keywords,
		});
	}

	return targets;
}

// --- Recents and favourites -------------------------------------------------

// The last reports this person opened, most recent first.
//
// Distinct on the report rather than a row per view, so opening one report
// twenty times this morning does not fill the list with it.
export async function recentReports(
	email: string,
	limit = 8,
): Promise<string[]> {
	const rows = await sql<{ report_id: string }>(
		`SELECT report_id::text AS report_id, max(occurred_on) AS seen
		 FROM usage_events
		 WHERE lower(user_email) = $1
		   AND event_type = 'page_view'
		   AND report_id IS NOT NULL
		 GROUP BY report_id
		 ORDER BY seen DESC
		 LIMIT $2`,
		[email.toLowerCase(), limit],
	).catch(() => [] as { report_id: string }[]);
	return rows.map((row) => row.report_id);
}

export async function listFavourites(email: string): Promise<string[]> {
	const rows = await sql<{ report_id: string }>(
		`SELECT report_id::text AS report_id
		 FROM favourites
		 WHERE lower(user_email) = $1
		 ORDER BY created_on DESC`,
		[email.toLowerCase()],
	).catch(() => [] as { report_id: string }[]);
	return rows.map((row) => row.report_id);
}

// Adding one twice is not an error. The button is a toggle and a double click
// on a slow connection should leave it on, not fail.
export async function addFavourite(
	email: string,
	reportId: string,
): Promise<void> {
	await sql(
		`INSERT INTO favourites (user_email, report_id)
		 VALUES ($1, $2)
		 ON CONFLICT (user_email, report_id) DO NOTHING`,
		[email.toLowerCase(), reportId],
	);
}

export async function removeFavourite(
	email: string,
	reportId: string,
): Promise<void> {
	await sql(
		`DELETE FROM favourites WHERE lower(user_email) = $1 AND report_id = $2`,
		[email.toLowerCase(), reportId],
	);
}

// The reports this person opened most recently, with the address each is at.
//
// Separate from recentReports, which answers with ids for the palette to match
// against a list it already holds. Warming has no such list and would otherwise
// resolve every id to a slug one query at a time.
export async function recentReportTargets(
	email: string,
	limit = 5,
): Promise<{ reportId: string; slug: string }[]> {
	const rows = await sql<{ report_id: string; slug: string }>(
		`SELECT r.report_id::text AS report_id, r.slug,
		        max(e.occurred_on) AS seen
		 FROM usage_events e
		 JOIN reports r ON r.report_id = e.report_id
		 WHERE lower(e.user_email) = $1
		   AND e.event_type = 'page_view'
		   AND r.is_active = TRUE
		 GROUP BY r.report_id, r.slug
		 ORDER BY seen DESC
		 LIMIT $2`,
		[email.toLowerCase(), limit],
	).catch(() => [] as { report_id: string; slug: string }[]);
	return rows.map((row) => ({ reportId: row.report_id, slug: row.slug }));
}
