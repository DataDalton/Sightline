import { sql } from "../data/lakebase";
import { knownMembers } from "../messages/store";
import { categoryRoleId } from "./roles";
import {
	alertFields,
	allReferenced,
	exploreFields,
	pageFields,
	roleOf,
	savedViewFields,
	sheetFields,
	type FieldRole,
} from "./fieldRefs";

// Everything that names a field, found in one walk.
//
// Reports are only one of the places a field is stored by name. Alerts, page
// alerts, sheets, saved Explore views, saved views of a page, deliveries and
// the source's own default time field all name fields too, and each keeps them
// in a different JSON shape. The dictionary, the sync and the remap all need
// the same answer to "what depends on this field", so it is worked out here
// once and each of them reads it.
//
// Rows are narrowed in the database by a text search on the stored JSON, which
// is cheap and can only over-match, then confirmed by the pure readers in
// fieldRefs, which know where each kind of item keeps its fields.

export type DependentKind =
	| "visual"
	| "pageFreshness"
	| "savedView"
	| "exploration"
	| "exploreView"
	| "alert"
	| "pageAlert"
	| "delivery"
	| "sheet"
	| "sourceDefaultTime";

export interface DependentReport {
	reportId: string;
	slug: string;
	title: string;
	categoryId: string | null;
	isPersonal: boolean;
	ownerEmail: string | null;
}

export interface Dependent {
	kind: DependentKind;
	sourceKey: string;
	field: string;
	// The id of the item itself, which is a visual, page, view, rule, delivery
	// or sheet.
	id: string;
	name: string | null;
	// Whose item it is. For a visual, a page or a page alert, the report's
	// owner, and its maintainers are the ones told about a curated report.
	ownerEmail: string | null;
	report: DependentReport | null;
	pageId: string | null;
	pageTitle: string | null;
	visualType: string | null;
	// Which part of a visual names the field.
	usedAs: FieldRole | null;
	link: string | null;
}

interface ReportColumns {
	report_id: string;
	slug: string;
	report_title: string;
	category_id: string | null;
	is_personal: boolean;
	report_owner: string | null;
}

const reportColumns = `r.report_id::text AS report_id, r.slug,
	r.title AS report_title, r.category_id, r.is_personal,
	r.owner_email AS report_owner`;

function toReport(row: ReportColumns): DependentReport {
	return {
		reportId: row.report_id,
		slug: row.slug,
		title: row.report_title,
		categoryId: row.category_id,
		isPersonal: row.is_personal,
		ownerEmail: row.report_owner,
	};
}

function reportLink(slug: string): string {
	return `/r/${encodeURIComponent(slug)}/`;
}

// The source a visual reads: its own, or its page's, or its report's. The same
// inheritance the reader applies when it builds a query.
const effectiveSource = `coalesce(v.source_key, p.source_key, r.source_key)`;

// Narrows rows to those whose stored JSON mentions one of the names at all.
// $2 is always the list of names, or null for every row.
function mentions(column: string): string {
	return `($2::text[] IS NULL OR EXISTS (
		SELECT 1 FROM unnest($2::text[]) AS n(name)
		WHERE strpos(${column}::text, n.name) > 0))`;
}

// Only the names asked for, or all of them when none were named.
function wanted(fields: string[] | null) {
	const set = fields ? new Set(fields) : null;
	return (name: string) => set === null || set.has(name);
}

// Every item on the given sources that names one of the given fields, or any
// field at all when fields is null.
export async function collectDependents(
	sourceKeys: string[],
	fields: string[] | null = null,
): Promise<Dependent[]> {
	if (sourceKeys.length === 0) return [];
	if (fields && fields.length === 0) return [];
	const keep = wanted(fields);
	// Each name as written and as it appears inside stored JSON, where a quote
	// or a backslash in it is escaped.
	const searched = fields
		? [
				...new Set(
					fields.flatMap((name) => [
						name,
						JSON.stringify(name).slice(1, -1),
					]),
				),
			]
		: null;
	const params = [sourceKeys, searched];
	const out: Dependent[] = [];

	const [
		visuals,
		pages,
		views,
		explorations,
		exploreViews,
		alerts,
		pageAlerts,
		sheets,
		defaults,
		known,
	] = await Promise.all([
		sql<
			ReportColumns & {
				visual_id: string;
				title: string | null;
				visual_type: string;
				config: unknown;
				page_id: string;
				page_title: string | null;
				source_key: string;
			}
		>(
			`SELECT v.visual_id::text AS visual_id, v.title, v.visual_type,
				        v.config, p.page_id::text AS page_id,
				        p.title AS page_title, ${reportColumns},
				        ${effectiveSource} AS source_key
				 FROM report_visuals v
				 JOIN report_pages p ON p.page_id = v.page_id
				 JOIN reports r      ON r.report_id = p.report_id
				 WHERE v.is_active AND p.is_active AND r.is_active
				   AND ${effectiveSource} = ANY($1::text[])
				   AND ${mentions("v.config")}
				 ORDER BY r.title, p.sort_order, v.sort_order`,
			params,
		),
		sql<
			ReportColumns & {
				page_id: string;
				page_title: string | null;
				config: unknown;
				source_key: string;
			}
		>(
			`SELECT p.page_id::text AS page_id, p.title AS page_title,
				        p.config, ${reportColumns},
				        coalesce(p.source_key, r.source_key) AS source_key
				 FROM report_pages p
				 JOIN reports r ON r.report_id = p.report_id
				 WHERE p.is_active AND r.is_active
				   AND coalesce(p.source_key, r.source_key) = ANY($1::text[])
				   AND p.config ? 'freshness'
				   AND ${mentions("p.config")}`,
			params,
		),
		// A saved view belongs to a page, and a page can hold visuals on
		// several sources, so each source any of its visuals reads is one
		// the view may name fields of.
		sql<
			ReportColumns & {
				view_id: string;
				name: string;
				owner_email: string;
				config: unknown;
				page_id: string;
				page_title: string | null;
				source_keys: string[];
			}
		>(
			`SELECT s.view_id::text AS view_id, s.name, s.owner_email,
				        s.config, p.page_id::text AS page_id,
				        p.title AS page_title, ${reportColumns},
				        ARRAY(
				          SELECT DISTINCT ${effectiveSource}
				          FROM report_visuals v
				          WHERE v.page_id = p.page_id AND v.is_active
				        ) || ARRAY[coalesce(p.source_key, r.source_key)]
				          AS source_keys
				 FROM saved_views s
				 JOIN report_pages p ON p.page_id = s.page_id
				 JOIN reports r      ON r.report_id = p.report_id
				 WHERE p.is_active AND r.is_active
				   AND (coalesce(p.source_key, r.source_key) = ANY($1::text[])
				        OR EXISTS (
				          SELECT 1 FROM report_visuals v
				          WHERE v.page_id = p.page_id AND v.is_active
				            AND ${effectiveSource} = ANY($1::text[])))
				   AND ${mentions("s.config")}`,
			params,
		),
		sql<{
			exploration_id: string;
			name: string;
			owner_email: string;
			source_key: string;
			config: unknown;
		}>(
			`SELECT exploration_id::text AS exploration_id, name,
				        owner_email, source_key, config
				 FROM explorations
				 WHERE migrated_to IS NULL
				   AND source_key = ANY($1::text[])
				   AND ${mentions("config")}`,
			params,
		),
		sql<{
			view_id: string;
			name: string;
			owner_email: string;
			state: unknown;
			source_key: string;
		}>(
			`SELECT view_id::text AS view_id, name, owner_email, state,
				        state->>'sourceKey' AS source_key
				 FROM explore_views
				 WHERE state->>'sourceKey' = ANY($1::text[])
				   AND ${mentions("state")}`,
			params,
		),
		sql<{
			rule_id: string;
			name: string;
			owner_email: string;
			source_key: string;
			definition: unknown;
		}>(
			`SELECT rule_id::text AS rule_id, name, owner_email, source_key,
				        definition
				 FROM alert_rules
				 WHERE source_key = ANY($1::text[])
				   AND ${mentions("definition")}`,
			params,
		),
		// A page alert belongs to its page, and so to whoever looks after the
		// report, like the visuals beside it.
		sql<
			ReportColumns & {
				alert_id: string;
				name: string;
				source_key: string;
				definition: unknown;
				page_id: string;
				page_title: string | null;
			}
		>(
			`SELECT a.alert_id::text AS alert_id, a.name, a.source_key,
				        a.definition, p.page_id::text AS page_id,
				        p.title AS page_title, ${reportColumns}
				 FROM page_alerts a
				 JOIN report_pages p ON p.page_id = a.page_id
				 JOIN reports r      ON r.report_id = a.report_id
				 WHERE a.is_active AND p.is_active AND r.is_active
				   AND a.source_key = ANY($1::text[])
				   AND ${mentions("a.definition")}`,
			params,
		),
		sql<{
			sheet_id: string;
			title: string;
			owner_email: string;
			definition: unknown;
			source_key: string;
		}>(
			`SELECT sheet_id::text AS sheet_id, title, owner_email,
				        definition, definition->>'sourceKey' AS source_key
				 FROM sheets
				 WHERE definition->>'sourceKey' = ANY($1::text[])
				   AND ${mentions("definition")}`,
			params,
		),
		sql<{
			source_key: string;
			title: string;
			default_time_field: string;
		}>(
			`SELECT source_key, title, default_time_field
				 FROM data_sources
				 WHERE source_key = ANY($1::text[])
				   AND default_time_field IS NOT NULL`,
			[sourceKeys],
		),
		// Which names each source defines, in any state, so a saved view
		// on a page mixing sources is attributed to the one that owns the
		// field it names.
		sql<{ source_key: string; field_name: string }>(
			`SELECT source_key, field_name FROM source_fields
				 WHERE source_key = ANY($1::text[])`,
			[sourceKeys],
		),
	]);

	const requested = new Set(sourceKeys);
	const defines = new Set(
		known.map((row) => `${row.source_key}\u0000${row.field_name}`),
	);

	// kpiRow visuals per page, for deliveries below.
	const kpiByPage = new Map<string, Dependent[]>();

	for (const row of visuals) {
		for (const field of allReferenced(row.config)) {
			if (!keep(field)) continue;
			const dependent: Dependent = {
				kind: "visual",
				sourceKey: row.source_key,
				field,
				id: row.visual_id,
				name: row.title,
				ownerEmail: row.report_owner,
				report: toReport(row),
				pageId: row.page_id,
				pageTitle: row.page_title,
				visualType: row.visual_type,
				usedAs: roleOf(row.config, field),
				link: reportLink(row.slug),
			};
			out.push(dependent);
			if (row.visual_type === "kpiRow") {
				const held = kpiByPage.get(row.page_id) ?? [];
				held.push(dependent);
				kpiByPage.set(row.page_id, held);
			}
		}
	}

	for (const row of pages) {
		for (const field of pageFields(row.config)) {
			if (!keep(field)) continue;
			out.push({
				kind: "pageFreshness",
				sourceKey: row.source_key,
				field,
				id: row.page_id,
				name: row.page_title,
				ownerEmail: row.report_owner,
				report: toReport(row),
				pageId: row.page_id,
				pageTitle: row.page_title,
				visualType: null,
				usedAs: null,
				link: reportLink(row.slug),
			});
		}
	}

	for (const row of views) {
		const sources = [...new Set(row.source_keys.filter(Boolean))].filter(
			(key) => requested.has(key),
		);
		for (const field of savedViewFields(row.config)) {
			if (!keep(field)) continue;
			for (const sourceKey of sources) {
				if (!defines.has(`${sourceKey}\u0000${field}`)) continue;
				out.push({
					kind: "savedView",
					sourceKey,
					field,
					id: row.view_id,
					name: row.name,
					ownerEmail: row.owner_email,
					report: toReport(row),
					pageId: row.page_id,
					pageTitle: row.page_title,
					visualType: null,
					usedAs: null,
					link: reportLink(row.slug),
				});
			}
		}
	}

	const plain = (
		kind: DependentKind,
		sourceKey: string,
		id: string,
		name: string | null,
		ownerEmail: string | null,
		link: string | null,
		names: string[],
	) => {
		for (const field of names) {
			if (!keep(field)) continue;
			out.push({
				kind,
				sourceKey,
				field,
				id,
				name,
				ownerEmail,
				report: null,
				pageId: null,
				pageTitle: null,
				visualType: null,
				usedAs: null,
				link,
			});
		}
	};

	for (const row of explorations) {
		plain(
			"exploration",
			row.source_key,
			row.exploration_id,
			row.name,
			row.owner_email,
			"/explore/",
			allReferenced(row.config),
		);
	}
	for (const row of exploreViews) {
		plain(
			"exploreView",
			row.source_key,
			row.view_id,
			row.name,
			row.owner_email,
			"/explore/",
			exploreFields(row.state),
		);
	}
	for (const row of alerts) {
		plain(
			"alert",
			row.source_key,
			row.rule_id,
			row.name,
			row.owner_email,
			"/alerts/",
			alertFields(row.definition),
		);
	}
	for (const row of pageAlerts) {
		for (const field of alertFields(row.definition)) {
			if (!keep(field)) continue;
			out.push({
				kind: "pageAlert",
				sourceKey: row.source_key,
				field,
				id: row.alert_id,
				name: row.name,
				ownerEmail: row.report_owner,
				report: toReport(row),
				pageId: row.page_id,
				pageTitle: row.page_title,
				visualType: null,
				usedAs: null,
				link: reportLink(row.slug),
			});
		}
	}
	for (const row of sheets) {
		plain(
			"sheet",
			row.source_key,
			row.sheet_id,
			row.title,
			row.owner_email,
			`/sheets/${row.sheet_id}/`,
			sheetFields(row.definition),
		);
	}
	for (const row of defaults) {
		plain(
			"sourceDefaultTime",
			row.source_key,
			row.source_key,
			row.title,
			null,
			"/admin/",
			[row.default_time_field],
		);
	}

	// A delivery sends a page's scorecards, so it depends on whatever the
	// scorecard row on its page names.
	if (kpiByPage.size > 0) {
		const deliveries = await sql<{
			delivery_id: string;
			owner_email: string;
			page_id: string;
		}>(
			`SELECT delivery_id::text AS delivery_id, owner_email,
			        page_id::text AS page_id
			 FROM deliveries
			 WHERE page_id::text = ANY($1::text[])`,
			[[...kpiByPage.keys()]],
		);
		for (const row of deliveries) {
			const seen = new Set<string>();
			for (const visual of kpiByPage.get(row.page_id) ?? []) {
				const key = `${visual.sourceKey}\u0000${visual.field}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({
					kind: "delivery",
					sourceKey: visual.sourceKey,
					field: visual.field,
					id: row.delivery_id,
					name: visual.pageTitle,
					ownerEmail: row.owner_email,
					report: visual.report,
					pageId: row.page_id,
					pageTitle: visual.pageTitle,
					visualType: null,
					usedAs: null,
					link: "/deliveries/",
				});
			}
		}
	}

	return out;
}

// Everything that names one field on one source.
export function findDependents(
	sourceKey: string,
	fieldName: string,
): Promise<Dependent[]> {
	return collectDependents([sourceKey], [fieldName]);
}

// Source and field together, since a field name is only unique within a source.
export function dependentKey(sourceKey: string, fieldName: string): string {
	return `${sourceKey}\u0000${fieldName}`;
}

// How many items name each field, keyed by dependentKey.
export async function dependentCounts(
	sourceKeys: string[],
	fields: string[] | null = null,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const dependent of await collectDependents(sourceKeys, fields)) {
		const key = dependentKey(dependent.sourceKey, dependent.field);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

// The people who look after reports in the given categories, meaning the
// holders of each category's editor role and the holders of the catalogue sync
// capability everywhere, directly or through a group. The same people told when a
// source's data is late. See lookAfters in lib/freshness/lateness.
export async function maintainersFor(categoryIds: string[]): Promise<string[]> {
	const categoryRoles = [...new Set(categoryIds.filter(Boolean))].map(
		categoryRoleId,
	);
	const subjects = await sql<{ subject_type: string; subject_id: string }>(
		`SELECT DISTINCT a.subject_type, a.subject_id
		 FROM role_assignments a
		 LEFT JOIN role_capabilities c ON c.role_id = a.role_id
		 WHERE a.is_active
		   AND ((a.scope_type = 'global' AND c.capability = 'semantic.sync')
		        OR (a.scope_type = 'category' AND a.role_id = ANY($1::text[])))`,
		[categoryRoles],
	);

	const people = new Set(
		subjects
			.filter((s) => s.subject_type === "user")
			.map((s) => s.subject_id.toLowerCase()),
	);
	const groups = subjects
		.filter((s) => s.subject_type === "group")
		.map((s) => s.subject_id);
	for (const members of Object.values(await knownMembers(groups))) {
		for (const email of members) people.add(email.toLowerCase());
	}
	return [...people];
}
