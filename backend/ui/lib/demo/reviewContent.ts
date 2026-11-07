import { sql } from "../data/lakebase";
import { allActiveRules, tablesOf } from "../dataRules/store";
import { runOneRule } from "../dataRules/runner";
import { builtinTypes } from "../updates/model";
import { dropHeld } from "../updates/store";
import { localIdentityEmail } from "../runtime";

// Data rules, updates and goals for the demo, so those screens have something to look
// at. Each is written only into an empty table, so an existing demo picks it up on its next start
// and anything added by hand is left alone.

const salesSource = "sales_orders";
const ticketsSource = "support_tickets";
const daysOfHistory = 14;

interface RuleSeed {
	sourceKey: string;
	name: string;
	kind: string;
	params: Record<string, unknown>;
	severity: "warning" | "critical";
}

const ruleSeeds: RuleSeed[] = [
	{
		sourceKey: salesSource,
		name: "Every order ID appears once",
		kind: "unique",
		params: { columns: ["order_id"] },
		severity: "critical",
	},
	{
		sourceKey: salesSource,
		name: "Every order has a region",
		kind: "notBlank",
		params: { column: "region" },
		severity: "warning",
	},
	{
		sourceKey: salesSource,
		name: "Revenue is never negative",
		kind: "range",
		params: { column: "revenue", min: 0, max: null },
		severity: "critical",
	},
	// The sample orders also come through Wholesale, so this one fails on the data as it stands.
	{
		sourceKey: salesSource,
		name: "Orders come through a known channel",
		kind: "allowedValues",
		params: { column: "channel", values: ["Online", "Retail"] },
		severity: "warning",
	},
	{
		sourceKey: ticketsSource,
		name: "Every ticket has a priority",
		kind: "notBlank",
		params: { column: "priority" },
		severity: "warning",
	},
];

export async function seedDataRules(): Promise<void> {
	const existing = await sql(`SELECT 1 FROM data_rules LIMIT 1`);
	if (existing.length > 0) return;

	for (const seed of ruleSeeds) {
		const [table] = await tablesOf(seed.sourceKey);
		if (!table) continue;
		const [rule] = await sql<{ rule_id: string }>(
			`INSERT INTO data_rules
			   (source_key, table_name, name, kind, params, severity, owner_email,
			    schedule, created_by)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'daily', $7)
			 RETURNING rule_id::text AS rule_id`,
			[
				seed.sourceKey,
				table,
				seed.name,
				seed.kind,
				JSON.stringify(seed.params),
				seed.severity,
				localIdentityEmail.toLowerCase(),
			],
		);
		// Earlier days passing, so the history has a shape before today's real check.
		await sql(
			`INSERT INTO data_rule_runs (rule_id, run_on, status, failing, checked, duration_ms)
			 SELECT $1::uuid, now() - make_interval(days => d), 'pass', 0, 1000, 40
			 FROM generate_series(1, $2::int) AS d`,
			[rule.rule_id, daysOfHistory],
		);
	}
	// Today's result is the real check on the sample tables.
	for (const rule of await allActiveRules()) {
		await runOneRule(rule, null);
	}
}

const quietDelivery = {
	banner: false,
	popup: false,
	home: true,
	inbox: false,
	push: false,
	page: true,
};

export async function seedUpdates(): Promise<void> {
	const existing = await sql(`SELECT 1 FROM updates LIMIT 1`);
	if (existing.length > 0) return;
	const known = new Set(builtinTypes.map((type) => type.typeId));
	const about = JSON.stringify([{ kind: "source", id: salesSource }]);
	const entries = [
		{
			type: "dataChange",
			title: "Revenue now excludes cancelled orders",
			body: "Cancelled orders were counted until they were refunded. They now leave Revenue on the day they are cancelled.",
			impact: "notable",
			before: "Included until refunded",
			after: "Excluded when cancelled",
			postedDaysAgo: 2,
			startsInDays: null,
			incidentState: null,
		},
		{
			type: "reportChange",
			title: "Revenue Overview has a new Ranked chart",
			body: "The regions are now ranked beside the trend, so the largest shows first.",
			impact: "info",
			before: null,
			after: null,
			postedDaysAgo: 5,
			startsInDays: null,
			incidentState: null,
		},
		{
			type: "maintenance",
			title: "Sales warehouse maintenance",
			body: "Sales figures stop updating during this window and catch up afterwards.",
			impact: "notable",
			before: null,
			after: null,
			postedDaysAgo: 1,
			startsInDays: 3,
			incidentState: null,
		},
		{
			type: "incident",
			title: "Sales orders loaded late",
			body: "The overnight load finished four hours late. Every figure has caught up.",
			impact: "breaking",
			before: null,
			after: null,
			postedDaysAgo: 8,
			startsInDays: null,
			incidentState: "resolved",
		},
		{
			type: "announcement",
			title: "Scheduled pages can now include a PDF",
			body: "Open any page, choose Schedule, and tick Include a PDF of the whole page.",
			impact: "info",
			before: null,
			after: null,
			postedDaysAgo: 12,
			startsInDays: null,
			incidentState: null,
		},
	];
	for (const entry of entries) {
		if (!known.has(entry.type)) continue;
		await sql(
			`INSERT INTO updates
			   (type, title, body, impact, about, before_value, after_value, delivery,
			    posted_on, starts_on, ends_on, incident_state, created_by)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb,
			         now() - make_interval(days => $9::int),
			         now() + make_interval(days => $10::int),
			         now() + make_interval(days => $10::int, hours => 2),
			         $11, $12)`,
			[
				entry.type,
				entry.title,
				entry.body,
				entry.impact,
				about,
				entry.before,
				entry.after,
				JSON.stringify(quietDelivery),
				entry.postedDaysAgo,
				entry.startsInDays,
				entry.incidentState,
				localIdentityEmail.toLowerCase(),
			],
		);
	}
	// A reader may have asked while the demo was being written.
	dropHeld();
}

export async function seedGoals(colleagueEmail: string): Promise<void> {
	const [report] = await sql<{ report_id: string }>(
		`SELECT report_id::text FROM reports WHERE slug = 'revenue-overview'`,
	);
	if (!report) return;
	// A demo from before goals belonged to a report keeps them, on the report they were made for.
	await sql(`UPDATE goals SET report_id = $1::uuid WHERE report_id IS NULL`, [
		report.report_id,
	]);
	const existing = await sql(`SELECT 1 FROM goals LIMIT 1`);
	if (existing.length > 0) return;
	const [totals] = await sql<{ revenue: number; margin: number }>(
		`SELECT SUM(revenue)::float8 AS revenue,
		        SUM(revenue - cost)::float8 AS margin
		 FROM sales.orders WHERE region = 'North America'`,
	);
	const [allRevenue] = await sql<{ revenue: number }>(
		`SELECT SUM(revenue)::float8 AS revenue FROM sales.orders`,
	);
	const inDays = (days: number) =>
		new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
	const northAmerica = JSON.stringify([
		{ field: "Region", op: "eq", value: "North America" },
	]);
	const goals = [
		{
			title: "Reach this year's revenue",
			measure: "Revenue",
			filters: "[]",
			now: allRevenue.revenue,
			target: Math.round(allRevenue.revenue * 1.08),
			due: inDays(60),
			by: localIdentityEmail.toLowerCase(),
		},
		{
			title: "Grow North America margin",
			measure: "Gross Margin",
			filters: northAmerica,
			now: totals.margin,
			target: Math.round(totals.margin * 1.2),
			due: inDays(20),
			by: colleagueEmail,
		},
	];
	for (const goal of goals) {
		const [row] = await sql<{ goal_id: string }>(
			`INSERT INTO goals
			   (title, source_key, measure, filters, target, due_on, created_by, report_id)
			 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::uuid)
			 RETURNING goal_id::text AS goal_id`,
			[
				goal.title,
				salesSource,
				goal.measure,
				goal.filters,
				goal.target,
				goal.due,
				goal.by,
				report.report_id,
			],
		);
		// A climb to where the figure stands, so progress has a line to draw.
		await sql(
			`INSERT INTO goal_progress (goal_id, user_email, day, value)
			 SELECT $1::uuid, $2, CURRENT_DATE - d,
			        $3::float8 * (1 - 0.004 * d)
			 FROM generate_series(1, $4::int) AS d`,
			[
				row.goal_id,
				localIdentityEmail.toLowerCase(),
				goal.now,
				daysOfHistory,
			],
		);
	}
}
