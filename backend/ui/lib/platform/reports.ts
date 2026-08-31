import { sql } from "../data/lakebase";
import { cachedDefinition } from "./definitionCache";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import {
	getAccessContext,
	resolveCategoryAccess,
	resolveReportAccess,
	type Permission,
} from "./access";
import { insertLog } from "../activityLog";

// Reading reports, pages and visuals, always filtered by what the caller may
// open. Access is applied here rather than in each route so there is one place
// that decides visibility, and no handler can forget to ask.

export interface ReportSummary {
	reportId: string;
	categoryId: string | null;
	slug: string;
	title: string;
	description: string | null;
	sourceKey: string | null;
	visibility: string;
	modifiedOn: string;
	// What the caller may do with it, so the client can hide edit affordances
	// it would be refused anyway.
	permission: Permission;
	// A page somebody built for themselves. The client renders sharing and
	// publishing for one of these and neither for a curated report.
	isPersonal: boolean;
	ownerEmail: string;
}

export interface VisualDefinition {
	visualId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: {
		slot?: string;
		dimensions?: string[];
		measures?: string[];
		filters?: unknown[];
		sort?: unknown[];
		options?: Record<string, unknown>;
	};
	layout: { x: number; y: number; w: number; h: number };
	sortOrder: number;
}

export interface PageDefinition {
	pageId: string;
	slug: string;
	title: string;
	template: string | null;
	sourceKey: string | null;
	// Page-level settings. `freshness.field` names the column the data-through
	// stamp takes a maximum of; unset falls back to the source's time field.
	config: {
		freshness?: { field?: string | null; label?: string | null };
		[key: string]: unknown;
	};
	sortOrder: number;
	// Locks an administrator has put on this page. Carried to the client so the
	// editor can show what is locked and stop offering what would be refused;
	// the refusal itself is the server's, in applyEdits.
	protectDelete: boolean;
	protectEdit: boolean;
	visuals: VisualDefinition[];
}

export interface ReportDetail extends ReportSummary {
	version: number;
	// Locks that apply to every page in the report. A page carries its own pair
	// as well, and the two combine.
	protectDelete: boolean;
	protectEdit: boolean;
	protectAddPage: boolean;
	pages: PageDefinition[];
}

interface ReportRow {
	report_id: string;
	category_id: string | null;
	slug: string;
	title: string;
	description: string | null;
	source_key: string | null;
	visibility: string;
	version: string | number;
	modified_on: string;
	// Read on every path that resolves access, because the ownership rule needs
	// both and a query that omits them would resolve a personal page as though
	// it were curated.
	is_personal: boolean;
	owner_email: string | null;
	// Locks that reach every page in the report, plus whether pages may be
	// added at all, which is the report's own business.
	protect_delete: boolean;
	protect_edit: boolean;
	protect_add_page: boolean;
}

// The columns every access decision about a report needs.
const reportColumns = `report_id, category_id, slug, title, description,
	        source_key, visibility, version, modified_on,
	        is_personal, owner_email, protect_delete, protect_edit,
	        protect_add_page`;

export async function listReports(
	policy: PolicyClass,
	identity: Identity,
	categoryId?: string,
): Promise<ReportSummary[]> {
	const context = await getAccessContext(policy, identity);

	// A curated listing. Personal pages are excluded here rather than left to
	// the resolver: they belong to nobody's category, so a category listing
	// that included them would be asking a question with no useful answer, and
	// the uncategorised listing is what the home page walks.
	const rows = categoryId
		? await sql<ReportRow>(
				`SELECT ${reportColumns}
				 FROM reports
				 WHERE is_active = TRUE AND is_personal = FALSE AND category_id = $1
				 ORDER BY sort_order, title`,
				[categoryId],
			)
		: await sql<ReportRow>(
				`SELECT ${reportColumns}
				 FROM reports
				 WHERE is_active = TRUE AND is_personal = FALSE
				 ORDER BY sort_order, title`,
			);

	const visible: ReportSummary[] = [];
	for (const row of rows) {
		const access = resolveReportAccess(
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
		if (!access.allowed || !access.permission) continue;
		visible.push({
			reportId: row.report_id,
			categoryId: row.category_id,
			slug: row.slug,
			title: row.title,
			description: row.description,
			sourceKey: row.source_key,
			visibility: row.visibility,
			modifiedOn: row.modified_on,
			permission: access.permission,
			isPersonal: row.is_personal,
			ownerEmail: row.owner_email ?? "",
		});
	}
	return visible;
}

export interface CategoryDetail {
	categoryId: string;
	name: string;
	description: string | null;
	reports: ReportSummary[];
}

export async function getCategory(
	policy: PolicyClass,
	identity: Identity,
	categoryId: string,
): Promise<CategoryDetail | null> {
	const context = await getAccessContext(policy, identity);
	if (
		!resolveCategoryAccess(
			context.grants,
			categoryId,
			"view",
			context.baseline,
		).allowed
	) {
		return null;
	}

	const rows = await sql<{
		category_id: string;
		name: string;
		description: string | null;
	}>(
		`SELECT category_id, name, description
		 FROM categories WHERE category_id = $1 AND is_active = TRUE`,
		[categoryId],
	);
	const category = rows[0];
	if (!category) return null;

	return {
		categoryId: category.category_id,
		name: category.name,
		description: category.description,
		reports: await listReports(policy, identity, categoryId),
	};
}

// Administrators reaching somebody's personal page, recorded.
//
// Opening a page built for one person is a privileged act rather than an
// ordinary read, and the trail is the thing that makes the access defensible:
// an administrator can answer for what the platform holds, and the record shows
// when they did.
//
// Deduplicated over a short window, per administrator and page. Without it a
// tab left open on somebody's page writes a row every time SWR revalidates, and
// an audit trail nobody can read through is one nobody reads.
const noticed = new Map<string, number>();
const noticeWindowMs = 5 * 60 * 1000;

function noteAdministrativeRead(
	email: string,
	reportId: string,
	ownerEmail: string | null,
): void {
	const key = `${email.toLowerCase()}|${reportId}`;
	const now = Date.now();
	const last = noticed.get(key);
	if (last && now - last < noticeWindowMs) return;
	noticed.set(key, now);

	// Swept on write rather than on a timer, so a module instance that stops
	// being asked stops doing work.
	if (noticed.size > 500) {
		for (const [held, at] of noticed) {
			if (now - at >= noticeWindowMs) noticed.delete(held);
		}
	}

	void insertLog({
		recordType: "report",
		recordId: reportId,
		action: "administer_personal_page",
		changedBy: email,
		notes: ownerEmail ? `owned by ${ownerEmail}` : null,
	});
}

export async function getReport(
	policy: PolicyClass,
	identity: Identity,
	slug: string,
): Promise<ReportDetail | null> {
	const context = await getAccessContext(policy, identity);

	// Fetched before the access check because the check needs the report id,
	// and cached because the answer does not vary by reader. The check itself
	// still runs per request, against this reader grants.
	const report = await cachedDefinition(`report:${slug}`, async () => {
		const rows = await sql<ReportRow>(
			`SELECT ${reportColumns}
			 FROM reports
			 WHERE slug = $1 AND is_active = TRUE`,
			[slug],
		);
		return rows[0] ?? null;
	});
	if (!report) return null;

	const access = resolveReportAccess(
		context.grants,
		{
			reportId: report.report_id,
			categoryId: report.category_id,
			isPersonal: report.is_personal,
			ownerEmail: report.owner_email,
		},
		context.email,
		"view",
		context.baseline,
	);
	if (!access.allowed || !access.permission) return null;

	if (access.viaAdministration) {
		noteAdministrativeRead(
			context.email,
			report.report_id,
			report.owner_email,
		);
	}

	// Two more round trips, and the same for every reader. Cached against the
	// report id rather than the slug, so a rename does not orphan the entry.
	const [pageRows, visualRows] = await cachedDefinition(
		`report-body:${report.report_id}`,
		async () =>
			await Promise.all([
				sql<{
					page_id: string;
					slug: string;
					title: string;
					template: string | null;
					source_key: string | null;
					config: PageDefinition["config"] | null;
					sort_order: number;
					protect_delete: boolean;
					protect_edit: boolean;
				}>(
					`SELECT page_id, slug, title, template, source_key, config, sort_order,
					        protect_delete, protect_edit
					 FROM report_pages
					 WHERE report_id = $1 AND is_active = TRUE
					 ORDER BY sort_order, title`,
					[report.report_id],
				),
				sql<{
					visual_id: string;
					page_id: string;
					visual_type: string;
					title: string | null;
					source_key: string | null;
					config: VisualDefinition["config"];
					layout_x: number;
					layout_y: number;
					layout_w: number;
					layout_h: number;
					sort_order: number;
				}>(
					`SELECT v.visual_id, v.page_id, v.visual_type, v.title, v.source_key,
					        v.config, v.layout_x, v.layout_y, v.layout_w, v.layout_h,
					        v.sort_order
					 FROM report_visuals v
					 JOIN report_pages p ON p.page_id = v.page_id
					 WHERE p.report_id = $1 AND v.is_active = TRUE
					 ORDER BY v.sort_order`,
					[report.report_id],
				),
			]),
	);

	// A visual with no source of its own reads the page's, and a page with none
	// reads the report's. That is what both columns are for, and resolving it
	// here means every consumer sees the same answer: the renderer, the editor,
	// the warmer and the version comparison all read this one definition.
	// Without it a visual carrying no key rendered as "No source configured"
	// on a page that plainly had one.
	const pageSource = new Map(
		pageRows.map((p) => [p.page_id, p.source_key ?? report.source_key]),
	);

	const visualsByPage = new Map<string, VisualDefinition[]>();
	for (const v of visualRows) {
		const list = visualsByPage.get(v.page_id) ?? [];
		list.push({
			visualId: v.visual_id,
			visualType: v.visual_type,
			title: v.title,
			sourceKey:
				v.source_key ?? pageSource.get(v.page_id) ?? report.source_key,
			config: v.config ?? {},
			layout: {
				x: v.layout_x,
				y: v.layout_y,
				w: v.layout_w,
				h: v.layout_h,
			},
			sortOrder: v.sort_order,
		});
		visualsByPage.set(v.page_id, list);
	}

	return {
		reportId: report.report_id,
		categoryId: report.category_id,
		slug: report.slug,
		title: report.title,
		description: report.description,
		sourceKey: report.source_key,
		isPersonal: report.is_personal,
		ownerEmail: report.owner_email ?? "",
		visibility: report.visibility,
		modifiedOn: report.modified_on,
		permission: access.permission,
		version: Number(report.version),
		protectDelete: report.protect_delete === true,
		protectEdit: report.protect_edit === true,
		protectAddPage: report.protect_add_page === true,
		pages: pageRows.map((p) => ({
			pageId: p.page_id,
			slug: p.slug,
			title: p.title,
			template: p.template,
			sourceKey: p.source_key ?? report.source_key,
			config: p.config ?? {},
			protectDelete: p.protect_delete === true,
			protectEdit: p.protect_edit === true,
			sortOrder: p.sort_order,
			visuals: visualsByPage.get(p.page_id) ?? [],
		})),
	};
}
