import { getIdentityFromHeaders, type Identity } from "../auth/identity";
import { sql, withAdvisoryLock } from "../data/lakebase";
import { startThread } from "../messages/store";
import {
	addTemplatePage,
	createCategory,
	createReport,
} from "../platform/authoring";
import { assignRole, categoryRoleId } from "../platform/roles";
import { emailHeader, localIdentityEmail } from "../runtime";
import { loadRegistry } from "../semantic/registry";
import { createSheet } from "../sheets/store";
import {
	categories,
	groups,
	people,
	sampleSheet,
	type ReportSeed,
} from "./content";
import { sampleTables, sources } from "./datasets";

// Everything the demonstration shows, written into the local Postgres on
// start: sample tables standing in for the warehouse, the sources and fields
// that describe them, the people and groups, and categories and reports built
// from the same templates an author would use. What is written lives in
// lib/demo/datasets and lib/demo/content. This module writes it.
//
// Each part checks for itself before writing, so a restart leaves what is
// already there alone, including anything changed while presenting. Deleting
// the .demo folder starts again from nothing.
//
// The company, the people and every figure are invented.

// --- Warehouse stand-ins -----------------------------------------------------

// Objects that let Postgres run the Databricks SQL the platform composes. See
// lib/demo/dialect for the rewrites that happen before a query arrives.
const warehouseSupport = [
	// CAST(x AS STRING) is how Databricks spells a cast to text.
	`DO $$ BEGIN
		CREATE DOMAIN string AS text;
	 EXCEPTION WHEN duplicate_object THEN NULL;
	 END $$`,

	// approx_percentile(value, fraction, accuracy), answered exactly. The
	// fraction rides at the front of the collected values, since a final
	// function only receives the state.
	`CREATE OR REPLACE FUNCTION demo_percentile_step(
		state double precision[], value double precision,
		fraction double precision, accuracy integer)
	 RETURNS double precision[] LANGUAGE sql IMMUTABLE AS $$
		SELECT CASE WHEN value IS NULL THEN coalesce(state, ARRAY[fraction])
		            ELSE coalesce(state, ARRAY[fraction]) || value END
	 $$`,
	`CREATE OR REPLACE FUNCTION demo_percentile_final(state double precision[])
	 RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
		SELECT percentile_cont(state[1]) WITHIN GROUP (ORDER BY v)
		FROM unnest(state[2:]) AS v
	 $$`,
	`CREATE OR REPLACE AGGREGATE approx_percentile(
		double precision, double precision, integer) (
		SFUNC = demo_percentile_step,
		STYPE = double precision[],
		FINALFUNC = demo_percentile_final
	 )`,

	// Who is in which group, read by the two membership functions for the
	// person a query runs as. See lib/demo/warehouse.
	`CREATE TABLE IF NOT EXISTS demo_members (
		user_email TEXT NOT NULL,
		group_name TEXT NOT NULL,
		PRIMARY KEY (user_email, group_name)
	 )`,
	`CREATE OR REPLACE FUNCTION is_member(name text)
	 RETURNS boolean LANGUAGE sql STABLE AS $$
		SELECT EXISTS (SELECT 1 FROM demo_members
		               WHERE user_email = current_setting('demo.user', true)
		                 AND group_name = name)
	 $$`,
	`CREATE OR REPLACE FUNCTION is_account_group_member(name text)
	 RETURNS boolean LANGUAGE sql STABLE AS $$
		SELECT is_member(name)
	 $$`,
];

// --- Seeding -------------------------------------------------------------------

async function exists(schema: string, table: string): Promise<boolean> {
	const rows = await sql(
		`SELECT 1 FROM information_schema.tables
		 WHERE table_schema = $1 AND table_name = $2`,
		[schema, table],
	);
	return rows.length > 0;
}

async function runAll(statements: string[]): Promise<void> {
	for (const statement of statements) await sql(statement);
}

async function seedWarehouse(): Promise<void> {
	await runAll(warehouseSupport);
	for (const table of sampleTables) {
		if (!(await exists(table.schema, table.table))) {
			await runAll(table.statements);
		}
	}

	for (const person of people) {
		for (const group of person.groups) {
			await sql(
				`INSERT INTO demo_members (user_email, group_name) VALUES ($1, $2)
				 ON CONFLICT DO NOTHING`,
				[person.email, group],
			);
		}
	}

	// What signing in would have recorded, so a message sent to a group while
	// seeding reaches its members before any of them has signed in. See
	// knownMembers in lib/messages/store.
	for (const person of people) {
		await sql(
			`INSERT INTO member_groups (user_email, grants) VALUES ($1, $2::jsonb)
			 ON CONFLICT (user_email) DO NOTHING`,
			[person.email, JSON.stringify(person.groups)],
		);
	}
}

async function seedSources(catalog: string): Promise<void> {
	for (const source of sources) {
		await sql(
			`INSERT INTO data_sources
			   (source_key, title, description, catalog_name, schema_name,
			    object_name, kind, default_time_field, is_live, created_by,
			    modified_by)
			 VALUES ($1, $2, $3, $4, $5, $6, 'table', $7, $8, 'demo', 'demo')
			 ON CONFLICT (source_key) DO NOTHING`,
			[
				source.key,
				source.title,
				source.description,
				catalog,
				source.schema,
				source.object,
				source.timeField,
				source.live === true,
			],
		);
		for (const [i, field] of source.fields.entries()) {
			await sql(
				`INSERT INTO source_fields
				   (source_key, field_name, field_kind, sql_expr, data_type,
				    description, format_hint, sort_order, created_by, modified_by)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'demo', 'demo')
				 ON CONFLICT (source_key, field_name) DO NOTHING`,
				[
					source.key,
					field.name,
					field.kind,
					field.expr,
					field.type,
					field.description,
					field.format,
					i,
				],
			);
		}
	}
}

function identityOf(email: string): Identity {
	const identity = getIdentityFromHeaders(
		new Headers({ [emailHeader]: email }),
	);
	if (!identity) throw new Error(`No identity for ${email}`);
	return identity;
}

async function seedContent(): Promise<void> {
	const existing = await sql(`SELECT 1 FROM categories LIMIT 1`);
	if (existing.length > 0) return;

	const author = identityOf(localIdentityEmail);

	await assignRole(
		{
			roleId: "reader",
			subjectType: "group",
			subjectId: groups.everyone,
			scopeType: "global",
		},
		"demo",
	);

	for (const category of categories) {
		await createCategory(author, {
			categoryId: category.id,
			name: category.name,
			icon: category.icon,
			description: category.description,
		});
		for (const maintainer of category.maintainers) {
			await assignRole(
				{
					roleId: categoryRoleId(category.id),
					subjectType: maintainer.type,
					subjectId: maintainer.id,
					scopeType: "category",
					scopeId: category.id,
				},
				"demo",
			);
		}
		for (const report of category.reports) {
			await seedReport(author, category.id, report);
		}
	}

	for (const conversation of conversations) {
		await startThread(conversation).catch((error) => {
			console.warn("Demo conversation was not started:", error);
		});
	}
}

// The first page comes with the report and the rest are added to it. A page
// that cannot be built is reported and left out, so one template that does
// not fit its source costs that page rather than the report.
async function seedReport(
	author: Identity,
	categoryId: string,
	report: ReportSeed,
): Promise<void> {
	const [first, ...rest] = report.pages;
	let reportId: string;
	try {
		const created = await createReport(author, {
			title: report.title,
			description: report.description,
			categoryId,
			sourceKey: report.sourceKey,
			pageTitle: first.title,
			template: first.template,
			slots: first.slots,
		});
		reportId = created.reportId;
	} catch (error) {
		console.warn(`Demo report "${report.title}" was not built:`, error);
		return;
	}
	for (const page of rest) {
		try {
			await addTemplatePage(author, {
				reportId,
				title: page.title,
				sourceKey: report.sourceKey,
				template: page.template,
				slots: page.slots,
			});
		} catch (error) {
			console.warn(
				`Demo page "${report.title} / ${page.title}" was not built:`,
				error,
			);
		}
	}
}

// Questions already asked, so the inbox and the maintainers' side of a
// conversation have something in them.
const conversations = [
	{
		author: "casey.nguyen@example.com",
		categoryId: "sales",
		reportSlug: null,
		subject: "Does revenue include returns?",
		body: "The Europe figure on Revenue Overview looks higher than the finance summary. Are returns taken off before it is counted?",
		recipients: [
			{ type: "user" as const, id: "jamie.carter@example.com" },
			{ type: "group" as const, id: groups.sales },
		],
	},
	{
		author: "dalton.murray@example.com",
		categoryId: "operations",
		reportSlug: null,
		subject: "Oceanic on-time rate",
		body: "Oceanic is well under the other carriers on Delivery Performance. Is that the Singapore lane, or across the board?",
		recipients: [
			{ type: "user" as const, id: "taylor.brooks@example.com" },
			{ type: "group" as const, id: groups.operations },
		],
	},
	{
		author: "casey.nguyen@example.com",
		categoryId: "marketing",
		reportSlug: null,
		subject: "Holiday Gift Guide budget",
		body: "Holiday Gift Guide spends the most of any campaign. Is the return on it measured over the same window as the others?",
		recipients: [{ type: "group" as const, id: groups.marketing }],
	},
];

// Checked on its own rather than with the rest of the content, so a demo seeded
// before sheets were part of it gains one on its next start.
async function seedSheet(): Promise<void> {
	const existing = await sql(`SELECT 1 FROM sheets LIMIT 1`);
	if (existing.length > 0) return;
	await createSheet(
		identityOf(localIdentityEmail),
		sampleSheet.title,
		sampleSheet.definition,
	).catch((error) => {
		console.warn("Demo sheet was not created:", error);
	});
}

// Held while seeding. Startup and the first request each prepare the app, in
// separate module instances under the development server, and both seed.
// Whichever arrives second waits, then finds everything there.
const seedLockKey = 8577410;

// The catalogue the sample tables sit in is the database itself, so the
// three part names the platform writes resolve in Postgres.
//
// Runs before the registry is first loaded, because loading it is what builds
// the list of groups a sign-in is checked against, and a list built before the
// role assignments exist leaves every group out.
export async function seedDemo(): Promise<void> {
	await withAdvisoryLock(seedLockKey, async () => {
		const [{ catalog }] = await sql<{ catalog: string }>(
			`SELECT current_database() AS catalog`,
		);
		await seedWarehouse();
		await seedSources(catalog);
		await loadRegistry(true);
		await seedContent();
		await seedSheet();
	});
	await loadRegistry(true);
}
