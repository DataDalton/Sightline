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
import { nextRun } from "../alerts/schedule";
import { exploreLink, previewAlert } from "../alerts/runner";
import { describeFirings, evaluate } from "../alerts/rule";
import { createAlert, nextCheck, wordingFor } from "../alerts/store";
import { createPageAlert, setSubscription } from "../alerts/pageStore";
import { resolvePolicyClass } from "../auth/policy";
import { notify } from "../notify/store";
import { createSheet } from "../sheets/store";
import { createBoard, updateBoard } from "../boards/store";
import type { BoardItem } from "../boards/definition";
import { demoBoard } from "./board";
import {
	categories,
	groups,
	people,
	sampleSheet,
	type ReportSeed,
} from "./content";
import { seedArrivals } from "./arrivals";
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
	if (report.forecast) {
		// The template's trend line over a date, set to forecast ahead.
		await sql(
			`UPDATE report_visuals v
			 SET config = coalesce(v.config, '{}'::jsonb) || jsonb_build_object(
			       'options',
			       coalesce(v.config->'options', '{}'::jsonb)
			         || '{"forecast": true}'::jsonb)
			 FROM report_pages p
			 WHERE p.page_id = v.page_id AND p.report_id = $1::uuid
			   AND v.visual_type = 'lineChart'
			   AND jsonb_array_length(coalesce(v.config->'dimensions', '[]'::jsonb)) = 1`,
			[reportId],
		);
	}
	if (report.targets) {
		await sql(
			`UPDATE report_visuals v
			 SET config = coalesce(v.config, '{}'::jsonb) || jsonb_build_object(
			       'options',
			       coalesce(v.config->'options', '{}'::jsonb)
			         || jsonb_build_object('targets', $2::jsonb))
			 FROM report_pages p
			 WHERE p.page_id = v.page_id AND p.report_id = $1::uuid
			   AND v.visual_type = 'kpiRow'`,
			[reportId, JSON.stringify(report.targets)],
		);
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
		author: "taylor.brooks@example.com",
		categoryId: "sales",
		reportSlug: null,
		subject: "Margin by region for the quarterly review",
		body: "Could the Regional margin sheet show last quarter beside this one? Finance wants the change per region for Thursday.",
		recipients: [
			{ type: "user" as const, id: "dalton.murray@example.com" },
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

// A board telling one quarter's story, so Boards opens on something to look
// at. Its visuals are copied from the seeded reports with their settings, as
// Add to board copies them.
async function seedBoard(): Promise<void> {
	const existing = await sql(`SELECT 1 FROM boards LIMIT 1`);
	if (existing.length > 0) return;
	const rows = await sql<{
		slug: string;
		report_id: string;
		report_title: string;
		visual_title: string | null;
		visual_type: string;
		source_key: string | null;
		config: Record<string, unknown>;
	}>(
		`SELECT r.slug, r.report_id::text AS report_id, r.title AS report_title,
		        v.title AS visual_title, v.visual_type,
		        coalesce(v.source_key, p.source_key, r.source_key) AS source_key,
		        v.config
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE v.is_active AND p.is_active AND r.is_active`,
	);
	const items = demoBoard.items.flatMap((item): BoardItem[] => {
		const { from, ...rest } = item;
		if (!from) return [rest];
		const row = rows.find(
			(r) =>
				r.slug === from.slug &&
				r.visual_title === from.title &&
				r.visual_type === from.visualType,
		);
		if (!row?.source_key) return [];
		return [
			{
				...rest,
				visual: {
					visualType: row.visual_type,
					title: row.visual_title,
					sourceKey: row.source_key,
					config: row.config,
				},
				origin: {
					reportId: row.report_id,
					slug: row.slug,
					title: row.report_title,
				},
			},
		];
	});
	const author = identityOf(localIdentityEmail);
	const board = await createBoard(author, demoBoard.title, []);
	await updateBoard(author, board.id, {
		definition: { items, links: demoBoard.links },
		baseVersion: board.version,
	});
}

// Two months of people reading the reports, so the usage a maintainer sees
// has something in it. Every report is opened, the first page far more than
// the rest, and only some visuals are ever expanded or clicked into, so the
// ones nobody uses stand out as they would in practice.
async function seedUsage(): Promise<void> {
	const existing = await sql(
		`SELECT 1 FROM usage_events WHERE session_id = 'demo-seed' LIMIT 1`,
	);
	if (existing.length > 0) return;

	const readers = people.map((p) => p.email);
	await sql(`SELECT setseed(0.61)`);
	await sql(
		`INSERT INTO usage_events
		   (occurred_on, user_email, policy_class, event_type, category_id,
		    report_id, session_id)
		 SELECT now() - random() * interval '60 days', reader, 'demo',
		        'page_view', r.category_id, r.report_id, 'demo-seed'
		 FROM reports r
		 CROSS JOIN unnest($1::text[]) AS reader
		 CROSS JOIN generate_series(1, 8) AS visit
		 WHERE r.is_active AND NOT r.is_personal AND random() < 0.45`,
		[readers],
	);
	await sql(
		`INSERT INTO usage_events
		   (occurred_on, user_email, policy_class, event_type, category_id,
		    report_id, page_id, session_id)
		 SELECT e.occurred_on, e.user_email, 'demo', 'page_open',
		        e.category_id, e.report_id, p.page_id, 'demo-seed'
		 FROM usage_events e
		 JOIN report_pages p ON p.report_id = e.report_id AND p.is_active
		 WHERE e.session_id = 'demo-seed' AND e.event_type = 'page_view'
		   AND random() < CASE WHEN p.sort_order = 0 THEN 1.0
		                       ELSE 0.5 / p.sort_order END`,
	);
	await sql(
		`INSERT INTO usage_events
		   (occurred_on, user_email, policy_class, event_type, category_id,
		    report_id, page_id, visual_id, action, session_id)
		 SELECT e.occurred_on + interval '20 seconds', e.user_email, 'demo',
		        'visual_action', e.category_id, e.report_id, e.page_id,
		        v.visual_id,
		        (ARRAY['expand', 'figures', 'select', 'select'])
		          [1 + floor(random() * 4)::int],
		        'demo-seed'
		 FROM usage_events e
		 JOIN report_visuals v ON v.page_id = e.page_id AND v.is_active
		 WHERE e.session_id = 'demo-seed' AND e.event_type = 'page_open'
		   AND v.visual_type NOT LIKE '%Filter' AND v.visual_type <> 'kpiRow'
		   AND abs(hashtext(v.visual_id::text)) % 3 <> 0
		   AND random() < 0.3`,
	);
}

// A page the signed-in person has asked to be sent every Monday morning, so
// the scheduled pages list has something in it.
async function seedDelivery(): Promise<void> {
	const existing = await sql(`SELECT 1 FROM deliveries LIMIT 1`);
	if (existing.length > 0) return;
	const [page] = await sql<{ report_id: string; page_id: string }>(
		`SELECT r.report_id::text, p.page_id::text
		 FROM reports r JOIN report_pages p ON p.report_id = r.report_id
		 WHERE r.slug = 'revenue-overview' AND p.is_active
		 ORDER BY p.sort_order LIMIT 1`,
	);
	if (!page) return;
	const schedule = {
		frequency: "weekly" as const,
		hour: 8,
		weekday: 1,
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
	await sql(
		`INSERT INTO deliveries
		   (owner_email, report_id, page_id, source_key, schedule, next_run_on,
		    access_confirmed_on)
		 VALUES ($1, $2::uuid, $3::uuid, 'sales_orders', $4, $5, now())
		 ON CONFLICT DO NOTHING`,
		[
			localIdentityEmail.toLowerCase(),
			page.report_id,
			page.page_id,
			JSON.stringify(schedule),
			nextRun(schedule, new Date()).toISOString(),
		],
	);
}

// An alert the signed-in person keeps, with its first firing already in the
// inbox, so the alerts screen and the unread count have something in them.
//
// Created the way the dialog creates one, then checked against the sample
// data once here rather than left for the scheduler, so the firing is there
// from the first page load and says what the data actually says.
// Alerts kept on a report page for readers to follow, so the page's Alerts
// button and the editor's Alerts panel have something in them. The demo
// reader and two colleagues follow the first.
async function seedPageAlerts(): Promise<void> {
	const existing = await sql(`SELECT 1 FROM page_alerts LIMIT 1`);
	if (existing.length > 0) return;
	const pages = await sql<{ page_id: string }>(
		`SELECT p.page_id::text AS page_id
		 FROM report_pages p JOIN reports r ON r.report_id = p.report_id
		 WHERE r.slug = 'revenue-overview' AND p.is_active
		 ORDER BY p.sort_order LIMIT 1`,
	);
	const pageId = pages[0]?.page_id;
	if (!pageId) return;

	const author = identityOf(localIdentityEmail);
	const policy = await resolvePolicyClass(author);
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const unusual = await createPageAlert(author, policy, pageId, {
		name: "Unusual daily revenue by region",
		sourceKey: "sales_orders",
		measure: "Revenue",
		groupBy: "Region",
		conditions: [],
		condition: "unusual",
		schedule: { frequency: "daily", hour: 8, weekday: 1, timeZone },
		notifyRecover: false,
		anomaly: {
			timeField: "Order Date",
			compareTo: "same_weekday",
			periods: 8,
			sensitivity: "medium",
			percent: null,
			direction: "either",
			minimum: null,
		},
	});
	await createPageAlert(author, policy, pageId, {
		name: "Weekly revenue drop",
		sourceKey: "sales_orders",
		measure: "Revenue",
		groupBy: null,
		conditions: [],
		condition: "falls_by",
		threshold: 10,
		schedule: { frequency: "weekly", hour: 8, weekday: 1, timeZone },
		notifyRecover: false,
	});
	for (const email of [
		localIdentityEmail,
		"jamie.carter@example.com",
		"casey.nguyen@example.com",
	]) {
		const reader = identityOf(email);
		await setSubscription(
			reader,
			await resolvePolicyClass(reader),
			unusual.id,
			{ subscribed: true },
		).catch(() => {});
	}
}

async function seedAlert(): Promise<void> {
	const existing = await sql(`SELECT 1 FROM alert_rules LIMIT 1`);
	if (existing.length > 0) return;
	const owner = identityOf(localIdentityEmail);
	const alert = await createAlert(owner, {
		name: "Regional revenue above target",
		sourceKey: "sales_orders",
		measure: "Revenue",
		groupBy: "Region",
		conditions: [],
		condition: "above",
		threshold: 2_000_000,
		schedule: {
			frequency: "weekly",
			hour: 8,
			weekday: 1,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		},
		notifyRecover: true,
	});
	const definition = alert.definition;
	const { readings } = await previewAlert(owner, definition);
	const { state, firings } = evaluate(definition, readings, {});
	const message = describeFirings(
		definition.name,
		wordingFor(definition),
		firings,
	);
	if (message) {
		await sql(
			`INSERT INTO alert_events (rule_id, title, body, firings)
			 VALUES ($1::uuid, $2, $3, $4)`,
			[alert.id, message.title, message.body, firings.length],
		);
		await notify(localIdentityEmail, {
			kind: "alert",
			title: message.title,
			body: message.body,
			link: exploreLink(definition),
			data: { ruleId: alert.id },
		});
	}
	// Recorded as checked, so the scheduler does not report the same crossing
	// a second time on its first tick.
	await sql(
		`UPDATE alert_rules SET state = $2, last_checked_on = now(),
		   next_check_on = $3
		 WHERE rule_id = $1::uuid`,
		[alert.id, JSON.stringify(state), nextCheck(definition).toISOString()],
	);
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
		await seedArrivals();
		await loadRegistry(true);
		await seedContent();
		await seedSheet();
		await seedBoard().catch((error) => {
			console.warn("Demo board was not created:", error);
		});
		await seedUsage();
		await seedDelivery();
		await seedAlert().catch((error) => {
			console.warn("Demo alert was not created:", error);
		});
		await seedPageAlerts().catch((error) => {
			console.warn("Demo page alerts were not created:", error);
		});
	});
	await loadRegistry(true);
}
