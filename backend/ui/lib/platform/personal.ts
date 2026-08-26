import { sql, transaction } from "../data/lakebase";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { insertLog } from "../activityLog";
import { invalidateAccessCache } from "./access";
import { AuthoringError, createReport } from "./authoring";
import { invalidateDefinitions } from "./definitionCache";
import type { BuiltVisual } from "../visuals/templates";

// Pages somebody builds for themselves.
//
// The same tables curated reports live in, with is_personal set. Not a store of
// their own, because a second one would mean a second answer to every question
// already settled once: which query does this visual make, what does the page
// open with, what warms, what does a saved view overlay, what does the op log
// replay. Two of those have already drifted in this codebase and had to be
// pulled back into one place. A third would drift silently.
//
// What keeps a personal page personal is the ownership rule in
// lib/platform/accessRules: no global role reaches one and neither does
// catalogue reachability, so the only ways in are owning it and being named on
// it. Sharing is therefore an ordinary access policy row naming one person.

export interface PersonalPage {
	reportId: string;
	slug: string;
	title: string;
	description: string | null;
	sourceKey: string | null;
	ownerEmail: string;
	modifiedOn: string;
	// How many people it has been shared with. Only meaningful on your own.
	sharedWith: number;
}

interface Row {
	report_id: string;
	slug: string;
	title: string;
	description: string | null;
	source_key: string | null;
	owner_email: string;
	modified_on: string;
	shared_with: string;
}

function toPage(row: Row): PersonalPage {
	return {
		reportId: row.report_id,
		slug: row.slug,
		title: row.title,
		description: row.description,
		sourceKey: row.source_key,
		ownerEmail: row.owner_email,
		modifiedOn: row.modified_on,
		sharedWith: Number(row.shared_with),
	};
}

const selectColumns = `r.report_id::text AS report_id, r.slug, r.title,
	        r.description, r.source_key, r.owner_email, r.modified_on,
	        (SELECT count(*) FROM access_policies p
	          WHERE p.resource_type = 'report'
	            AND p.resource_id = r.report_id::text
	            AND p.is_active = TRUE)::text AS shared_with`;

export interface PersonalListing {
	mine: PersonalPage[];
	sharedWithMe: PersonalPage[];
	// Curated reports this person authored. Not personal pages: they live in a
	// category and everyone who can open that category sees them. Listed here
	// because somebody who made a report looks for it under their own things
	// first, and finding nothing reads as having lost it.
	authored: PersonalPage[];
}

// Yours, and the ones somebody named you on.
//
// Two queries rather than one with a union, because the second has to join the
// grant table and the first must not: a page of your own is yours whether or
// not anybody has been named on it.
export async function listPersonalPages(
	identity: Identity,
	policy: PolicyClass,
): Promise<PersonalListing> {
	const email = identity.email.toLowerCase();

	const [mine, shared, authored] = await Promise.all([
		sql<Row>(
			`SELECT ${selectColumns}
			 FROM reports r
			 WHERE r.is_active = TRUE AND r.is_personal = TRUE
			   AND lower(r.owner_email) = $1
			 ORDER BY r.modified_on DESC
			 LIMIT 200`,
			[email],
		),
		sql<Row>(
			`SELECT DISTINCT ${selectColumns}
			 FROM reports r
			 JOIN access_policies p
			   ON p.resource_type = 'report'
			  AND p.resource_id = r.report_id::text
			  AND p.is_active = TRUE
			 WHERE r.is_active = TRUE AND r.is_personal = TRUE
			   AND lower(r.owner_email) <> $1
			   AND (
			     (p.subject_type = 'user' AND lower(p.subject_id) = $1)
			     OR (p.subject_type = 'group' AND p.subject_id = ANY($2))
			   )
			 ORDER BY r.modified_on DESC
			 LIMIT 200`,
			[email, policy.degraded ? [] : policy.grants],
		),
		sql<Row>(
			`SELECT ${selectColumns}
			 FROM reports r
			 WHERE r.is_active = TRUE AND r.is_personal = FALSE
			   AND lower(r.owner_email) = $1
			 ORDER BY r.modified_on DESC
			 LIMIT 200`,
			[email],
		),
	]);

	return {
		mine: mine.map(toPage),
		sharedWithMe: shared.map(toPage),
		authored: authored.map(toPage),
	};
}

// A page of your own. No capability beyond being able to read the source, which
// is the same bar the explore page already sets: somebody who can ask a question
// of a dataset can keep the answer.
export async function createPersonalPage(
	identity: Identity,
	input: {
		title: string;
		sourceKey: string | null;
		template?: string | null;
		slots?: Record<string, string>;
		visuals?: BuiltVisual[];
	},
): Promise<{ reportId: string; slug: string; pageId: string }> {
	const created = await createReport(identity, {
		title: input.title,
		// A personal page belongs in nobody's category. That is also what keeps
		// it out of every category listing without those listings having to
		// know about it.
		categoryId: null,
		sourceKey: input.sourceKey,
		isPersonal: true,
		template: input.template,
		slots: input.slots,
		visuals: input.visuals,
	});

	return {
		reportId: created.reportId,
		slug: created.slug,
		pageId: created.pageId,
	};
}

// Copies a report somebody can already open into a page of their own.
//
// Structure and all, so the copy opens looking like what was copied and can
// then be changed without touching it. A reader who wants the standard revenue
// report broken down their way starts from the standard one instead of building
// it again.
//
// The caller must be able to view the original. Checked by the caller, which
// resolves access anyway.
export async function copyAsPersonalPage(
	identity: Identity,
	sourceReportId: string,
	title: string,
): Promise<{ reportId: string; slug: string }> {
	const name = title.trim();
	if (!name) throw new AuthoringError("A name is required.");

	const source = await sql<{ source_key: string | null; title: string }>(
		`SELECT source_key, title FROM reports
		 WHERE report_id = $1 AND is_active = TRUE`,
		[sourceReportId],
	);
	if (source.length === 0) throw new AuthoringError("That report is gone.");

	const created = await createReport(identity, {
		title: name,
		categoryId: null,
		sourceKey: source[0].source_key,
		isPersonal: true,
	});

	await transaction(async (client) => {
		const pages = await client.query<{
			page_id: string;
			slug: string;
			title: string;
			template: string | null;
			source_key: string | null;
			config: unknown;
			sort_order: number;
		}>(
			`SELECT page_id::text AS page_id, slug, title, template, source_key,
			        config, sort_order
			 FROM report_pages
			 WHERE report_id = $1 AND is_active = TRUE
			 ORDER BY sort_order`,
			[sourceReportId],
		);

		// createReport already made a first page. The copy replaces it, so the
		// result is the pages that were copied and not those plus an empty one.
		await client.query(`DELETE FROM report_pages WHERE report_id = $1`, [
			created.reportId,
		]);

		for (const page of pages.rows) {
			const inserted = await client.query<{ page_id: string }>(
				`INSERT INTO report_pages
				   (report_id, slug, title, template, source_key, config, sort_order)
				 VALUES ($1,$2,$3,$4,$5,$6,$7)
				 RETURNING page_id::text AS page_id`,
				[
					created.reportId,
					page.slug,
					page.title,
					page.template,
					page.source_key,
					JSON.stringify(page.config ?? {}),
					page.sort_order,
				],
			);

			await client.query(
				`INSERT INTO report_visuals
				   (page_id, visual_type, title, source_key, config,
				    layout_x, layout_y, layout_w, layout_h, sort_order)
				 SELECT $1, visual_type, title, source_key, config,
				        layout_x, layout_y, layout_w, layout_h, sort_order
				 FROM report_visuals
				 WHERE page_id = $2 AND is_active = TRUE`,
				[inserted.rows[0].page_id, page.page_id],
			);
		}
	});

	await insertLog({
		recordType: "report",
		recordId: created.reportId,
		action: "copy_report",
		changedBy: identity.email,
		oldValue: sourceReportId,
	});

	return { reportId: created.reportId, slug: created.slug };
}

// Ownership, checked in the WHERE rather than before it, so there is no window
// between deciding somebody owns a page and writing to it.
//
// An administrator passes without owning it. They can already open and edit any
// personal page, and a set of actions that stops short of removing one leaves
// them able to read somebody's page but not to act on what they find. The reads
// are recorded in lib/platform/reports; the writes here record themselves.
async function assertMayAct(
	identity: Identity,
	reportId: string,
	asAdministrator = false,
): Promise<void> {
	const rows = await sql<{ owner_email: string }>(
		`SELECT owner_email FROM reports
		 WHERE report_id = $1 AND is_active = TRUE AND is_personal = TRUE
		   AND (lower(owner_email) = $2 OR $3)`,
		[reportId, identity.email.toLowerCase(), asAdministrator],
	);
	if (rows.length === 0) {
		throw new AuthoringError("That is not one of your pages.");
	}
}

export interface Share {
	email: string;
	grantedOn: string;
}

export async function listShares(
	identity: Identity,
	reportId: string,
	asAdministrator = false,
): Promise<Share[]> {
	await assertMayAct(identity, reportId, asAdministrator);

	const rows = await sql<{ subject_id: string; granted_on: string }>(
		`SELECT subject_id, granted_on FROM access_policies
		 WHERE resource_type = 'report' AND resource_id = $1
		   AND subject_type = 'user' AND is_active = TRUE
		 ORDER BY granted_on DESC`,
		[reportId],
	);
	return rows.map((r) => ({ email: r.subject_id, grantedOn: r.granted_on }));
}

// Enough to catch a typed-in address that could never reach anybody. Not a
// claim that the person exists: the platform has no directory to ask, and a
// share to somebody who never signs in costs nothing.
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Names one person on a page.
//
// By email only. A group grant would make "shared with three colleagues"
// indistinguishable from "shared with everyone in Sales", and the promise a
// personal page makes is that it is seen by the people named on it.
export async function sharePage(
	identity: Identity,
	reportId: string,
	email: string,
	asAdministrator = false,
): Promise<void> {
	await assertMayAct(identity, reportId, asAdministrator);

	const target = email.trim();
	if (!emailPattern.test(target)) {
		throw new AuthoringError("That does not look like an email address.");
	}
	if (
		!asAdministrator &&
		target.toLowerCase() === identity.email.toLowerCase()
	) {
		throw new AuthoringError("You already have this page.");
	}

	// One row per person, so sharing twice does not leave two rows whose
	// combined meaning has to be worked out at read time, and re-sharing
	// something revoked makes it active again.
	//
	// Guarded by NOT EXISTS rather than ON CONFLICT: access_policies carries no
	// unique constraint over these four columns, so a conflict clause would
	// never fire and every re-share would add a row.
	const inserted = await sql<{ policy_id: string }>(
		`INSERT INTO access_policies
		   (subject_type, subject_id, resource_type, resource_id, permission,
		    granted_by)
		 SELECT 'user', $1, 'report', $2, 'view', $3
		 WHERE NOT EXISTS (
		   SELECT 1 FROM access_policies
		   WHERE resource_type = 'report' AND resource_id = $2
		     AND subject_type = 'user' AND lower(subject_id) = lower($1)
		 )
		 RETURNING policy_id`,
		[target, reportId, identity.email],
	);

	if (inserted.length === 0) {
		await sql(
			`UPDATE access_policies
			 SET is_active = TRUE, granted_by = $3, granted_on = now()
			 WHERE resource_type = 'report' AND resource_id = $2
			   AND subject_type = 'user' AND lower(subject_id) = lower($1)`,
			[target, reportId, identity.email],
		);
	}

	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "share_page",
		changedBy: identity.email,
		newValue: target,
	});
	invalidateAccessCache();
}

export async function unsharePage(
	identity: Identity,
	reportId: string,
	email: string,
	asAdministrator = false,
): Promise<void> {
	await assertMayAct(identity, reportId, asAdministrator);

	await sql(
		`UPDATE access_policies SET is_active = FALSE
		 WHERE resource_type = 'report' AND resource_id = $1
		   AND subject_type = 'user' AND lower(subject_id) = lower($2)`,
		[reportId, email.trim()],
	);

	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "unshare_page",
		changedBy: identity.email,
		oldValue: email.trim(),
	});
	invalidateAccessCache();
}

export async function deletePersonalPage(
	identity: Identity,
	reportId: string,
	asAdministrator = false,
): Promise<void> {
	await assertMayAct(identity, reportId, asAdministrator);

	// Deactivated rather than dropped, matching how a page or a visual is
	// removed, so the audit trail still resolves what it names.
	await sql(`UPDATE reports SET is_active = FALSE WHERE report_id = $1`, [
		reportId,
	]);
	await sql(
		`UPDATE access_policies SET is_active = FALSE
		 WHERE resource_type = 'report' AND resource_id = $1`,
		[reportId],
	);

	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "remove_page",
		changedBy: identity.email,
	});
	invalidateAccessCache();
	invalidateDefinitions("navigation:");
}

// --- Promotion --------------------------------------------------------------

export interface Promoted {
	slug: string;
	title: string;
}

// Moves somebody's page into a curated category.
//
// A column change rather than a copy. A copy would leave two definitions of one
// thing, drifting from the moment either is edited, and the reader who built it
// would keep tending a version nobody else reads.
//
// The shares made while it was personal are left in place. They granted view to
// people the owner named, and taking that away at the moment it becomes more
// widely readable is a downgrade nobody asked for. An administrator can revoke
// them from the access pane like any other grant.
export async function publishPage(
	identity: Identity,
	reportId: string,
	categoryId: string,
): Promise<Promoted> {
	const found = await sql<{
		title: string;
		slug: string;
		is_personal: boolean;
	}>(
		`SELECT title, slug, is_personal FROM reports
		 WHERE report_id = $1 AND is_active = TRUE`,
		[reportId],
	);
	const report = found[0];
	if (!report) throw new AuthoringError("That page does not exist.");
	if (!report.is_personal) {
		throw new AuthoringError("That report is already published.");
	}

	const category = await sql<{ category_id: string }>(
		`SELECT category_id FROM categories
		 WHERE category_id = $1 AND is_active = TRUE`,
		[categoryId],
	);
	if (category.length === 0) {
		throw new AuthoringError("That category does not exist.");
	}

	await sql(
		`UPDATE reports
		 SET category_id = $2, is_personal = FALSE, visibility = 'published',
		     modified_by = $3, modified_on = now()
		 WHERE report_id = $1`,
		[reportId, categoryId, identity.email],
	);

	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "publish_page",
		changedBy: identity.email,
		newValue: categoryId,
	});

	// The ownership rule no longer applies to it, so every cached answer about
	// who can reach it is now wrong in the direction of too narrow.
	invalidateAccessCache();
	invalidateDefinitions("navigation:");
	invalidateDefinitions(`report:${report.slug}`);

	return { slug: report.slug, title: report.title };
}

// Every personal page on the installation.
//
// For an administrator, who can reach one anyway and otherwise has no way to
// find it. Being able to open a page you cannot list is not the same as being
// able to answer for what the platform holds.
//
// Not filtered by anything. That is the point: an administrator asking what
// exists is asking a question about the installation rather than about
// themselves, and an answer that quietly left rows out would be the wrong
// answer to it.
export async function allPersonalPages(): Promise<PersonalPage[]> {
	const rows = await sql<Row>(
		`SELECT ${selectColumns}
		 FROM reports r
		 WHERE r.is_active = TRUE AND r.is_personal = TRUE
		 ORDER BY r.modified_on DESC
		 LIMIT 500`,
	);
	return rows.map(toPage);
}

// Personal pages an editor could publish: shared by their owner, so somebody
// has already decided the page is worth other people seeing.
//
// A page nobody has shared is not offered. Publishing somebody's private
// working page because an editor happened to see it in a list is exactly the
// surprise the ownership rule exists to prevent.
export async function publishablePages(): Promise<PersonalPage[]> {
	const rows = await sql<Row>(
		`SELECT DISTINCT ${selectColumns}
		 FROM reports r
		 JOIN access_policies p
		   ON p.resource_type = 'report'
		  AND p.resource_id = r.report_id::text
		  AND p.is_active = TRUE
		 WHERE r.is_active = TRUE AND r.is_personal = TRUE
		 ORDER BY r.modified_on DESC
		 LIMIT 100`,
	);
	return rows.map(toPage);
}

// --- Converting the questions saved before pages existed --------------------

interface ExplorationRow {
	exploration_id: string;
	owner_email: string;
	name: string;
	source_key: string;
	config: {
		visualType?: string;
		dimensions?: string[];
		measures?: string[];
		search?: unknown[];
		rowLimit?: number;
	};
}

// Turns each saved exploration into a personal page holding the same visual.
//
// Converted rather than moved: the explorations table is left exactly as it
// was, with a column recording which page each row became. A conversion that
// got something wrong can then be looked at rather than reconstructed, and
// running this twice does nothing the second time.
//
// Runs at startup and is expected to find nothing on almost every start.
export async function migrateExplorations(): Promise<number> {
	let rows: ExplorationRow[];
	try {
		rows = await sql<ExplorationRow>(
			`SELECT exploration_id::text AS exploration_id, owner_email, name,
			        source_key, config
			 FROM explorations
			 WHERE migrated_to IS NULL
			 LIMIT 500`,
		);
	} catch (error) {
		// The table may not exist on an installation that never ran the explore
		// build. Nothing to convert is the ordinary case, not a failure.
		console.warn("Could not read saved explorations to convert:", error);
		return 0;
	}

	if (rows.length === 0) return 0;

	let converted = 0;
	for (const row of rows) {
		try {
			const config = row.config ?? {};
			const measures = config.measures ?? [];

			const created = await createReport(
				// The owner is the person who saved it, not whoever happened to
				// start the process that runs this.
				{ email: row.owner_email } as Identity,
				{
					title: row.name,
					categoryId: null,
					sourceKey: row.source_key,
					isPersonal: true,
					visuals: [
						{
							visualType: config.visualType ?? "table",
							title: null,
							dimensions: config.dimensions ?? [],
							measures,
							filters: config.search ?? [],
							options: {
								topN: config.rowLimit ?? 20,
								topBy: measures[0],
							},
							layout: { x: 0, y: 0, w: 12, h: 8 },
						},
					],
				},
			);

			await sql(
				`UPDATE explorations SET migrated_to = $2
				 WHERE exploration_id = $1`,
				[row.exploration_id, created.reportId],
			);
			converted++;
		} catch (error) {
			// One that will not convert is left unmarked, so a later start
			// tries again once whatever blocked it is fixed. A source that has
			// since been unregistered is the likely reason, and that is not
			// something to lose the other conversions over.
			console.warn(
				`Could not convert saved exploration ${row.exploration_id}:`,
				error,
			);
		}
	}

	if (converted > 0) {
		console.log(`Converted ${converted} saved exploration(s) into pages.`);
		invalidateDefinitions("navigation:");
	}
	return converted;
}
