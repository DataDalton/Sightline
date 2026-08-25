import { sql } from "../data/lakebase";
import { cachedDefinition } from "./definitionCache";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import {
	baselinePermission,
	getGrants,
	resolveCategoryAccess,
	resolveReportAccess,
	type Permission,
} from "./access";

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
	visuals: VisualDefinition[];
}

export interface ReportDetail extends ReportSummary {
	version: number;
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
}

export async function listReports(
	policy: PolicyClass,
	identity: Identity,
	categoryId?: string,
): Promise<ReportSummary[]> {
	const grants = await getGrants(policy, identity);
	// A central editor holds edit everywhere, so their baseline stands in when
	// no explicit grant names them.
	const baseline = baselinePermission(policy);

	const rows = categoryId
		? await sql<ReportRow>(
				`SELECT report_id, category_id, slug, title, description,
				        source_key, visibility, version, modified_on
				 FROM reports
				 WHERE is_active = TRUE AND category_id = $1
				 ORDER BY title`,
				[categoryId],
			)
		: await sql<ReportRow>(
				`SELECT report_id, category_id, slug, title, description,
				        source_key, visibility, version, modified_on
				 FROM reports
				 WHERE is_active = TRUE
				 ORDER BY title`,
			);

	const visible: ReportSummary[] = [];
	for (const row of rows) {
		const access = resolveReportAccess(
			grants,
			row.report_id,
			row.category_id,
			"view",
			baseline,
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
	const grants = await getGrants(policy, identity);
	const baseline = baselinePermission(policy);
	if (!resolveCategoryAccess(grants, categoryId, "view", baseline).allowed) {
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

export async function getReport(
	policy: PolicyClass,
	identity: Identity,
	slug: string,
): Promise<ReportDetail | null> {
	const grants = await getGrants(policy, identity);

	// Fetched before the access check because the check needs the report id,
	// and cached because the answer does not vary by reader. The check itself
	// still runs per request, against this reader grants.
	const report = await cachedDefinition(`report:${slug}`, async () => {
		const rows = await sql<ReportRow>(
			`SELECT report_id, category_id, slug, title, description,
			        source_key, visibility, version, modified_on
			 FROM reports
			 WHERE slug = $1 AND is_active = TRUE`,
			[slug],
		);
		return rows[0] ?? null;
	});
	if (!report) return null;

	const access = resolveReportAccess(
		grants,
		report.report_id,
		report.category_id,
		"view",
		baselinePermission(policy),
	);
	if (!access.allowed || !access.permission) return null;

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
				}>(
					`SELECT page_id, slug, title, template, source_key, config, sort_order
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

	const visualsByPage = new Map<string, VisualDefinition[]>();
	for (const v of visualRows) {
		const list = visualsByPage.get(v.page_id) ?? [];
		list.push({
			visualId: v.visual_id,
			visualType: v.visual_type,
			title: v.title,
			sourceKey: v.source_key,
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
		visibility: report.visibility,
		modifiedOn: report.modified_on,
		permission: access.permission,
		version: Number(report.version),
		pages: pageRows.map((p) => ({
			pageId: p.page_id,
			slug: p.slug,
			title: p.title,
			template: p.template,
			sourceKey: p.source_key,
			config: p.config ?? {},
			sortOrder: p.sort_order,
			visuals: visualsByPage.get(p.page_id) ?? [],
		})),
	};
}
