import { sql, transaction } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import { insertLog } from "../activityLog";
import { getSource } from "../semantic/registry";
import {
	buildPage,
	templateByKey,
	type BuiltVisual,
} from "../visuals/templates";
import {
	describeProblems,
	hasError,
	validateVisual,
} from "../visuals/validate";
import { invalidateDefinitions } from "./definitionCache";

// Creating the things the editor could only ever add to.
//
// The editor has always been able to add a page to a report and a visual to a
// page. It could not create the report, and nothing anywhere could create a
// category: there was no INSERT against either table in the whole application.
// Standing up a new subject area meant somebody writing SQL against the platform
// store by hand, which is the programming this removes.
//
// A page is created from a template rather than as an empty grid. See
// lib/visuals/templates: the shape is declared once with slots where the field
// names go, so filling two of them produces a laid-out page instead of a canvas
// and a series of decisions.

export class AuthoringError extends Error {}

// A slug is in a URL and has to stay stable, so it is derived once at creation
// and never re-derived from a title somebody edits later.
export function slugify(title: string): string {
	const base = title
		.toLowerCase()
		.normalize("NFKD")
		// Anything that is not a letter, a digit or a separator.
		.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return base || "report";
}

// The same, for a category id, which is chosen rather than generated but still
// has to survive being a path segment.
const categoryIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// A slug nothing else holds.
//
// Suffixed rather than refused: two reports called "Weekly summary" in different
// categories is an ordinary thing to want, and making the second one fail is
// making the author name it around a constraint they cannot see.
async function uniqueSlug(base: string): Promise<string> {
	const taken = await sql<{ slug: string }>(
		`SELECT slug FROM reports WHERE slug = $1 OR slug LIKE $2`,
		[base, `${base}-%`],
	);
	if (!taken.some((r) => r.slug === base)) return base;

	const held = new Set(taken.map((r) => r.slug));
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base}-${n}`;
		if (!held.has(candidate)) return candidate;
	}
	throw new AuthoringError(
		"Too many reports share that name. Give this one something more specific.",
	);
}

// --- Categories -------------------------------------------------------------

export interface CategoryInput {
	categoryId: string;
	name: string;
	description?: string | null;
	icon?: string | null;
}

export async function createCategory(
	identity: Identity,
	input: CategoryInput,
): Promise<string> {
	const categoryId = input.categoryId.trim().toLowerCase();
	if (!categoryIdPattern.test(categoryId)) {
		throw new AuthoringError(
			"An id is lower case letters, numbers and hyphens, up to 40 characters.",
		);
	}
	const name = input.name.trim();
	if (!name) throw new AuthoringError("A name is required.");

	// Reactivated rather than refused when the id was used before. A category
	// removed and then wanted back is the same category, and the reports that
	// pointed at it still do.
	const rows = await sql<{ category_id: string }>(
		`INSERT INTO categories (category_id, name, description, icon, sort_order)
		 VALUES ($1, $2, $3, $4,
		         (SELECT coalesce(max(sort_order), -1) + 1 FROM categories))
		 ON CONFLICT (category_id) DO UPDATE SET
		   name = EXCLUDED.name,
		   description = EXCLUDED.description,
		   icon = EXCLUDED.icon,
		   is_active = TRUE
		 RETURNING category_id`,
		[
			categoryId,
			name.slice(0, 120),
			input.description ?? null,
			input.icon ?? null,
		],
	);

	await insertLog({
		recordType: "category",
		recordId: categoryId,
		action: "create_category",
		changedBy: identity.email,
		newValue: name,
	});

	// Navigation is cached against a key of its own, and a category nobody can
	// see for thirty seconds reads as a create that did not work.
	invalidateDefinitions("navigation:");

	return rows[0].category_id;
}

export async function updateCategory(
	identity: Identity,
	categoryId: string,
	input: { name?: string; description?: string | null; icon?: string | null },
): Promise<void> {
	const name = input.name?.trim();
	if (name !== undefined && !name) {
		throw new AuthoringError("A name is required.");
	}

	await sql(
		`UPDATE categories SET
		   name = COALESCE($2, name),
		   description = COALESCE($3, description),
		   icon = COALESCE($4, icon)
		 WHERE category_id = $1`,
		[
			categoryId,
			name?.slice(0, 120) ?? null,
			input.description ?? null,
			input.icon ?? null,
		],
	);

	await insertLog({
		recordType: "category",
		recordId: categoryId,
		action: "update_category",
		changedBy: identity.email,
		newValue: name ?? null,
	});
	invalidateDefinitions("navigation:");
}

// Deactivated rather than deleted, so the reports that point at it keep a
// resolvable category and a restore is one flag.
export async function deactivateCategory(
	identity: Identity,
	categoryId: string,
): Promise<void> {
	const reports = await sql<{ count: string }>(
		`SELECT count(*)::text AS count FROM reports
		 WHERE category_id = $1 AND is_active = TRUE`,
		[categoryId],
	);
	if (Number(reports[0]?.count ?? 0) > 0) {
		throw new AuthoringError(
			"That category still holds reports. Move them somewhere else first.",
		);
	}

	await sql(
		`UPDATE categories SET is_active = FALSE WHERE category_id = $1`,
		[categoryId],
	);
	await insertLog({
		recordType: "category",
		recordId: categoryId,
		action: "remove_category",
		changedBy: identity.email,
	});
	invalidateDefinitions("navigation:");
}

export async function reorderCategories(
	identity: Identity,
	categoryIds: string[],
): Promise<void> {
	await transaction(async (client) => {
		for (let i = 0; i < categoryIds.length; i++) {
			await client.query(
				`UPDATE categories SET sort_order = $2 WHERE category_id = $1`,
				[categoryIds[i], i],
			);
		}
	});
	await insertLog({
		recordType: "category",
		recordId: "*",
		action: "reorder_categories",
		changedBy: identity.email,
		newValue: categoryIds.join(","),
	});
	invalidateDefinitions("navigation:");
}

// --- Pages built from a template --------------------------------------------

export interface TemplateChoice {
	// Absent means an empty page, which stays available because no set of
	// templates covers everything somebody wants to build.
	template?: string | null;
	slots?: Record<string, string>;
}

// Resolves a template into the visuals to store, and checks each one.
//
// The templates are tested against the catalogue, so a failure here means the
// semantic layer changed under a slot rather than that a template is wrong. It
// still refuses: storing a definition the catalogue says cannot be drawn is the
// thing lib/visuals/validate exists to stop, and a template is not an exemption.
function checkVisuals(
	visuals: BuiltVisual[],
	sourceKey: string | null,
): BuiltVisual[] {
	const source = sourceKey ? getSource(sourceKey) : null;
	const fields = source
		? {
				dimensions: source.dimensions.map((f) => f.name),
				measures: source.measures.map((f) => f.name),
			}
		: null;

	for (const visual of visuals) {
		const problems = validateVisual(
			visual.visualType,
			{
				dimensions: visual.dimensions,
				measures: visual.measures,
				options: visual.options,
			},
			fields,
		);
		if (hasError(problems)) {
			throw new AuthoringError(describeProblems(problems));
		}
	}
	return visuals;
}

function visualsFromTemplate(
	choice: TemplateChoice,
	sourceKey: string | null,
): { templateKey: string | null; visuals: BuiltVisual[] } {
	if (!choice.template) return { templateKey: null, visuals: [] };

	const template = templateByKey[choice.template];
	if (!template) {
		throw new AuthoringError(
			`There is no template called ${choice.template}.`,
		);
	}

	const page = buildPage(template, choice.slots ?? {});
	if (page.unfilled.length > 0) {
		const labels = page.unfilled
			.map(
				(key) =>
					template.slots.find((s) => s.key === key)?.label ?? key,
			)
			.join(", ");
		throw new AuthoringError(`Choose a field for: ${labels}.`);
	}

	try {
		checkVisuals(page.visuals, sourceKey);
	} catch (error) {
		// Named, because a template failing here means the source changed under
		// a slot rather than that the author did anything wrong.
		throw new AuthoringError(
			`${template.label} cannot be built on this source: ${
				error instanceof Error ? error.message : "the fields do not fit"
			}`,
		);
	}

	return { templateKey: template.key, visuals: page.visuals };
}

// --- Reports ----------------------------------------------------------------

export interface CreateReportInput extends TemplateChoice {
	title: string;
	// Null for a personal page, which belongs to nobody's category.
	categoryId: string | null;
	description?: string | null;
	sourceKey: string | null;
	// A page somebody built for themselves. Exempt from every implicit grant;
	// see the ownership rule in lib/platform/accessRules.
	isPersonal?: boolean;
	// The first page's title. Defaults to the report's, because a report with
	// one page should not make the author name the same thing twice.
	pageTitle?: string;
	// Visuals to place instead of a template's. Used where the author already
	// has one, which is what keeping an exploration is: the visual exists and
	// is being given somewhere to live.
	visuals?: BuiltVisual[];
}

export interface CreatedReport {
	reportId: string;
	slug: string;
	pageId: string;
	// What was placed. Returned so the caller can warm the queries this page
	// will make, which are known the moment it is built rather than the first
	// time somebody opens it.
	visuals: BuiltVisual[];
}

export async function createReport(
	identity: Identity,
	input: CreateReportInput,
): Promise<CreatedReport> {
	const title = input.title.trim();
	if (!title) throw new AuthoringError("A title is required.");

	if (input.sourceKey && !getSource(input.sourceKey)) {
		throw new AuthoringError(
			`There is no source called ${input.sourceKey}.`,
		);
	}

	if (input.categoryId) {
		const found = await sql<{ category_id: string }>(
			`SELECT category_id FROM categories
			 WHERE category_id = $1 AND is_active = TRUE`,
			[input.categoryId],
		);
		if (found.length === 0) {
			throw new AuthoringError("That category does not exist.");
		}
	}

	// Resolved before the transaction opens, so a template that cannot be built
	// is refused without having created a report to hang it off.
	const built = input.visuals
		? {
				templateKey: null,
				visuals: checkVisuals(input.visuals, input.sourceKey),
			}
		: visualsFromTemplate(input, input.sourceKey);

	const slug = await uniqueSlug(slugify(title));
	const pageTitle = (input.pageTitle ?? title).trim().slice(0, 200);

	const created = await transaction(async (client) => {
		const report = await client.query<{ report_id: string }>(
			`INSERT INTO reports
			   (category_id, slug, title, description, source_key, owner_email,
			    visibility, is_personal, created_by, modified_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6, $6)
			 RETURNING report_id::text AS report_id`,
			[
				input.categoryId,
				slug,
				title.slice(0, 200),
				input.description ?? null,
				input.sourceKey,
				identity.email,
				input.isPersonal ? "private" : "published",
				input.isPersonal === true,
			],
		);
		const reportId = report.rows[0].report_id;

		const page = await client.query<{ page_id: string }>(
			`INSERT INTO report_pages
			   (report_id, slug, title, template, source_key, sort_order)
			 VALUES ($1, $2, $3, $4, $5, 0)
			 RETURNING page_id::text AS page_id`,
			[reportId, "page-1", pageTitle, built.templateKey, input.sourceKey],
		);
		const pageId = page.rows[0].page_id;

		for (let i = 0; i < built.visuals.length; i++) {
			const visual = built.visuals[i];
			await client.query(
				`INSERT INTO report_visuals
				   (page_id, visual_type, title, source_key, config,
				    layout_x, layout_y, layout_w, layout_h, sort_order)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
				[
					pageId,
					visual.visualType,
					visual.title,
					input.sourceKey,
					JSON.stringify({
						dimensions: visual.dimensions,
						measures: visual.measures,
						filters: visual.filters ?? [],
						options: visual.options,
					}),
					visual.layout.x,
					visual.layout.y,
					visual.layout.w,
					visual.layout.h,
					i,
				],
			);
		}

		return { reportId, slug, pageId, visuals: built.visuals };
	});

	await insertLog({
		recordType: "report",
		recordId: created.reportId,
		action: "create_report",
		changedBy: identity.email,
		newValue: JSON.stringify({
			title,
			slug,
			categoryId: input.categoryId,
			template: built.templateKey,
			isPersonal: input.isPersonal === true,
		}),
	});

	invalidateDefinitions("navigation:");

	return created;
}

// Removes a report, curated or personal.
//
// Deactivated rather than dropped, matching how a page and a visual are
// removed, so an audit trail still resolves what it names and a restore is one
// flag rather than a reconstruction.
//
// Whether the caller may do this is decided before here, by the same access
// resolution that decides whether they may edit it: the ownership rule already
// gives a personal page's owner admin on it, and a curated report needs edit.
export async function removeReport(
	identity: Identity,
	reportId: string,
): Promise<void> {
	const rows = await sql<{ slug: string; title: string }>(
		`UPDATE reports SET is_active = FALSE, modified_by = $2, modified_on = now()
		 WHERE report_id = $1 AND is_active = TRUE
		 RETURNING slug, title`,
		[reportId, identity.email],
	);
	if (rows.length === 0) throw new AuthoringError("That report is gone.");

	// The shares made on it granted view to named people. Left active they
	// would keep granting it if the report were ever restored under different
	// ownership.
	await sql(
		`UPDATE access_policies SET is_active = FALSE
		 WHERE resource_type = 'report' AND resource_id = $1`,
		[reportId],
	);

	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "remove_report",
		changedBy: identity.email,
		oldValue: rows[0].title,
	});

	invalidateDefinitions("navigation:");
	invalidateDefinitions(`report:${rows[0].slug}`);
	invalidateDefinitions(`report-body:${reportId}`);
}

// --- A page added to a report that already exists ---------------------------

export interface AddPageInput extends TemplateChoice {
	reportId: string;
	title: string;
	sourceKey: string | null;
}

// The editor's own addPage op handles an empty page, because it has to: that op
// travels over the live change feed so every open session applies the same
// insert. A page built from a template is not that. It carries visuals, it is
// not something two editors race on, and putting it through the op log would
// mean encoding a template expansion as a dozen ops.
export async function addTemplatePage(
	identity: Identity,
	input: AddPageInput,
): Promise<{ pageId: string; visuals: BuiltVisual[] }> {
	const title = input.title.trim();
	if (!title) throw new AuthoringError("A title is required.");

	const built = visualsFromTemplate(input, input.sourceKey);

	const pageId = await transaction(async (client) => {
		// Locked for the same reason an edit locks it: two people adding a page
		// at once must not both take the same sort order or version.
		const current = await client.query<{ version: string }>(
			`SELECT version FROM reports WHERE report_id = $1 FOR UPDATE`,
			[input.reportId],
		);
		if (current.rows.length === 0) {
			throw new AuthoringError("Report not found.");
		}

		const next = await client.query<{ sort_order: number; count: string }>(
			`SELECT coalesce(max(sort_order), -1) + 1 AS sort_order,
			        count(*)::text AS count
			 FROM report_pages WHERE report_id = $1`,
			[input.reportId],
		);
		const order = next.rows[0]?.sort_order ?? 0;

		const page = await client.query<{ page_id: string }>(
			`INSERT INTO report_pages
			   (report_id, slug, title, template, source_key, sort_order)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING page_id::text AS page_id`,
			[
				input.reportId,
				`page-${Number(next.rows[0]?.count ?? 0) + 1}`,
				title.slice(0, 200),
				built.templateKey,
				input.sourceKey,
				order,
			],
		);
		const created = page.rows[0].page_id;

		for (let i = 0; i < built.visuals.length; i++) {
			const visual = built.visuals[i];
			await client.query(
				`INSERT INTO report_visuals
				   (page_id, visual_type, title, source_key, config,
				    layout_x, layout_y, layout_w, layout_h, sort_order)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
				[
					created,
					visual.visualType,
					visual.title,
					input.sourceKey,
					JSON.stringify({
						dimensions: visual.dimensions,
						measures: visual.measures,
						filters: visual.filters ?? [],
						options: visual.options,
					}),
					visual.layout.x,
					visual.layout.y,
					visual.layout.w,
					visual.layout.h,
					i,
				],
			);
		}

		// Bumped so an editor with the report open is told to reload rather than
		// saving over a page they cannot see.
		await client.query(
			`UPDATE reports SET version = version + 1, modified_by = $2,
			                    modified_on = now()
			 WHERE report_id = $1`,
			[input.reportId, identity.email],
		);

		return created;
	});

	await insertLog({
		recordType: "report",
		recordId: input.reportId,
		action: "add_page",
		changedBy: identity.email,
		newValue: JSON.stringify({ title, template: built.templateKey }),
	});

	invalidateDefinitions(`report-body:${input.reportId}`);

	return { pageId, visuals: built.visuals };
}
