import { randomUUID } from "node:crypto";
import { insertLog } from "../activityLog";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import {
	cachedDefinition,
	invalidateDefinitions,
} from "../platform/definitionCache";
import { can, canOnReport, getExplicitContext } from "../platform/access";
import { getSource, listSources } from "../semantic/registry";
import { reachableSet } from "../platform/sources";
import {
	ruleKinds,
	sourceScore,
	type DataRule,
	type RuleKind,
	type RuleParams,
	type RuleResult,
	type RuleSchedule,
	type Severity,
	columnOfField,
	columnsOfRule,
} from "./rules";

// Saving rules and reading results back. Everything read back is limited to the sources
// the person can read, and a source with a row filter shows pass or fail without counts,
// because a count could reveal rows outside what their own filter lets them see.

export class DataRuleError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

interface RuleRow {
	rule_id: string;
	source_key: string;
	table_name: string;
	name: string;
	kind: RuleKind;
	params: RuleParams;
	severity: Severity;
	owner_email: string | null;
	group_by: string | null;
	recent_column: string | null;
	recent_days: number | null;
	schedule: RuleSchedule;
	budget_seconds: number;
	allow_failing: string;
	is_active: boolean;
}

const ruleColumns = `rule_id::text AS rule_id, source_key, table_name, name, kind, params,
	severity, owner_email, group_by, recent_column, recent_days, schedule,
	budget_seconds, allow_failing, is_active`;

function toRule(row: RuleRow): DataRule {
	return {
		ruleId: row.rule_id,
		sourceKey: row.source_key,
		table: row.table_name,
		name: row.name,
		kind: row.kind,
		params: row.params,
		severity: row.severity,
		owner: row.owner_email,
		groupBy: row.group_by,
		recentColumn: row.recent_column,
		recentDays: row.recent_days,
		schedule: row.schedule,
		budgetSeconds: row.budget_seconds,
		allowFailing: Number(row.allow_failing),
		isActive: row.is_active,
	};
}

export async function allActiveRules(): Promise<DataRule[]> {
	const rows = await sql<RuleRow>(
		`SELECT ${ruleColumns} FROM data_rules WHERE is_active = TRUE`,
	);
	return rows.map(toRule);
}

export async function ruleById(ruleId: string): Promise<DataRule | null> {
	const rows = await sql<RuleRow>(
		`SELECT ${ruleColumns} FROM data_rules
		 WHERE rule_id = $1 AND is_active = TRUE`,
		[ruleId],
	);
	return rows[0] ? toRule(rows[0]) : null;
}

// Rules for a source are looked after by administrators, and by Maintainers of a report
// built on it, who are the people affected when its data goes wrong.
export async function assertCanManage(
	policy: PolicyClass,
	email: string,
	sourceKey: string,
): Promise<void> {
	const context = await getExplicitContext(policy, email);
	if (can(context.capabilities, "rule.manage", null, context.denied)) return;
	const reports = await reportsReading(sourceKey);
	const allowed = reports.some((report) =>
		canOnReport(
			context.capabilities,
			"rule.manage",
			{
				reportId: report.report_id,
				categoryId: report.category_id,
				tags: report.tags,
			},
			context.denied,
		),
	);
	if (!allowed) {
		throw new DataRuleError(
			"Only an administrator or a Maintainer of a report on this source can do this.",
			403,
		);
	}
}

interface ReportReading {
	report_id: string;
	slug: string;
	title: string;
	category_id: string | null;
	tags: string[] | null;
}

export async function reportsReading(
	sourceKey: string,
): Promise<ReportReading[]> {
	return sql<ReportReading>(
		`SELECT DISTINCT r.report_id::text AS report_id, r.slug, r.title,
		        r.category_id, r.tags
		 FROM reports r
		 LEFT JOIN report_pages p ON p.report_id = r.report_id AND p.is_active
		 LEFT JOIN report_visuals v ON v.page_id = p.page_id AND v.is_active
		 WHERE r.is_active = TRUE AND r.is_personal = FALSE
		   AND (r.source_key = $1 OR p.source_key = $1 OR v.source_key = $1)
		 ORDER BY r.title`,
		[sourceKey],
	);
}

// What a rule and a template have in common, which is everything but where it runs.
function cleanShape(raw: Record<string, unknown>) {
	const kind = String(raw.kind ?? "") as RuleKind;
	if (!ruleKinds.includes(kind)) {
		throw new DataRuleError("That is not a kind of rule.");
	}
	const name = String(raw.name ?? "").trim();
	if (!name) throw new DataRuleError("A rule needs a name.");
	const schedule = (
		["afterLoad", "hourly", "daily"].includes(String(raw.schedule))
			? raw.schedule
			: "afterLoad"
	) as RuleSchedule;
	const text = (value: unknown) => {
		const held = String(value ?? "").trim();
		return held ? held : null;
	};
	return {
		kind,
		name: name.slice(0, 200),
		schedule,
		severity: (raw.severity === "critical"
			? "critical"
			: "warning") as Severity,
		owner: text(raw.owner),
		groupBy: text(raw.groupBy),
		recentColumn: text(raw.recentColumn),
		recentDays: Number(raw.recentDays) > 0 ? Number(raw.recentDays) : null,
		budgetSeconds:
			Number(raw.budgetSeconds) > 0 ? Number(raw.budgetSeconds) : 300,
		allowFailing:
			Number(raw.allowFailing) > 0 ? Number(raw.allowFailing) : 0,
		params: (raw.params && typeof raw.params === "object"
			? raw.params
			: {}) as RuleParams,
	};
}

function cleanInput(raw: Record<string, unknown>) {
	const table = String(raw.table ?? "").trim();
	if (!table) throw new DataRuleError("A rule needs a table to check.");
	return { ...cleanShape(raw), table };
}

export interface RuleTemplate {
	templateId: string;
	name: string;
	kind: RuleKind;
	params: RuleParams;
	severity: Severity;
	groupBy: string | null;
	recentColumn: string | null;
	recentDays: number | null;
	schedule: RuleSchedule;
	budgetSeconds: number;
	allowFailing: number;
	createdBy: string;
	canRemove: boolean;
}

type TemplateFields = Omit<
	RuleTemplate,
	"templateId" | "name" | "kind" | "createdBy" | "canRemove"
>;

export async function listRuleTemplates(
	policy: PolicyClass,
	identity: Identity,
): Promise<RuleTemplate[]> {
	const [rows, context] = await Promise.all([
		sql<{
			template_id: string;
			name: string;
			kind: RuleKind;
			fields: TemplateFields;
			created_by: string;
		}>(
			`SELECT template_id::text AS template_id, name, kind, fields, created_by
			 FROM data_rule_templates WHERE is_active = TRUE ORDER BY name`,
		),
		getExplicitContext(policy, identity.email),
	]);
	const canManageAll = can(
		context.capabilities,
		"rule.manage",
		null,
		context.denied,
	);
	return rows.map((row) => ({
		...row.fields,
		templateId: row.template_id,
		name: row.name,
		kind: row.kind,
		createdBy: row.created_by,
		canRemove:
			canManageAll ||
			row.created_by.toLowerCase() === identity.email.toLowerCase(),
	}));
}

// Anyone who can manage rules on the source it was shaped on can save one for everybody.
export async function saveRuleTemplate(
	policy: PolicyClass,
	identity: Identity,
	raw: Record<string, unknown>,
): Promise<void> {
	await assertCanManage(policy, identity.email, String(raw.sourceKey ?? ""));
	const { kind, name, owner: _owner, ...fields } = cleanShape(raw);
	const rows = await sql<{ template_id: string }>(
		`INSERT INTO data_rule_templates (name, kind, fields, created_by)
		 VALUES ($1, $2, $3::jsonb, $4)
		 RETURNING template_id::text AS template_id`,
		[name, kind, JSON.stringify(fields), identity.email],
	);
	await insertLog({
		recordType: "data_rule_template",
		recordId: rows[0].template_id,
		action: "create_data_rule_template",
		changedBy: identity.email,
		newValue: JSON.stringify({ name, kind }),
	});
}

export async function removeRuleTemplate(
	policy: PolicyClass,
	identity: Identity,
	templateId: string,
): Promise<void> {
	const held = await listRuleTemplates(policy, identity);
	const template = held.find((item) => item.templateId === templateId);
	if (!template) throw new DataRuleError("Not found", 404);
	if (!template.canRemove) {
		throw new DataRuleError(
			"Only whoever saved a template or an administrator can remove it.",
			403,
		);
	}
	await sql(
		`UPDATE data_rule_templates SET is_active = FALSE WHERE template_id = $1`,
		[templateId],
	);
	await insertLog({
		recordType: "data_rule_template",
		recordId: templateId,
		action: "remove_data_rule_template",
		changedBy: identity.email,
		newValue: template.name,
	});
}

export async function saveRule(
	policy: PolicyClass,
	identity: Identity,
	raw: Record<string, unknown>,
): Promise<DataRule> {
	const sourceKey = String(raw.sourceKey ?? "");
	if (!getSource(sourceKey)) throw new DataRuleError("Unknown source.");
	await assertCanManage(policy, identity.email, sourceKey);
	const input = cleanInput(raw);
	const ruleId = raw.ruleId ? String(raw.ruleId) : randomUUID();
	const rows = await sql<RuleRow>(
		`INSERT INTO data_rules
		   (rule_id, source_key, table_name, name, kind, params, severity,
		    owner_email, group_by, recent_column, recent_days, schedule,
		    budget_seconds, allow_failing, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		 ON CONFLICT (rule_id) DO UPDATE SET
		   table_name = EXCLUDED.table_name, name = EXCLUDED.name,
		   kind = EXCLUDED.kind, params = EXCLUDED.params,
		   severity = EXCLUDED.severity, owner_email = EXCLUDED.owner_email,
		   group_by = EXCLUDED.group_by, recent_column = EXCLUDED.recent_column,
		   recent_days = EXCLUDED.recent_days, schedule = EXCLUDED.schedule,
		   budget_seconds = EXCLUDED.budget_seconds,
		   allow_failing = EXCLUDED.allow_failing
		 RETURNING ${ruleColumns}`,
		[
			ruleId,
			sourceKey,
			input.table,
			input.name,
			input.kind,
			JSON.stringify(input.params),
			input.severity,
			input.owner ?? identity.email,
			input.groupBy,
			input.recentColumn,
			input.recentDays,
			input.schedule,
			input.budgetSeconds,
			input.allowFailing,
			identity.email,
		],
	);
	dropLatestResults();
	await insertLog({
		recordType: "data_rule",
		recordId: ruleId,
		action: raw.ruleId ? "update_data_rule" : "create_data_rule",
		changedBy: identity.email,
		newValue: JSON.stringify({
			sourceKey,
			name: input.name,
			kind: input.kind,
		}),
	});
	return toRule(rows[0]);
}

export async function removeRule(
	policy: PolicyClass,
	identity: Identity,
	ruleId: string,
): Promise<void> {
	const rule = await ruleById(ruleId);
	if (!rule) throw new DataRuleError("Not found", 404);
	await assertCanManage(policy, identity.email, rule.sourceKey);
	await sql(`UPDATE data_rules SET is_active = FALSE WHERE rule_id = $1`, [
		ruleId,
	]);
	dropLatestResults();
	await sql(
		`UPDATE data_incidents SET status = 'resolved', resolved_on = now()
		 WHERE rule_id = $1 AND status <> 'resolved'`,
		[ruleId],
	);
	await insertLog({
		recordType: "data_rule",
		recordId: ruleId,
		action: "remove_data_rule",
		changedBy: identity.email,
	});
}

// --- Results ------------------------------------------------------------------

// Where the latest result of each rule is held, by the sources asked about.
const latestResultsKey = "data-rules:latest:";

// Drops every held latest result, after anything that changes which rules exist or what
// they last found.
export function dropLatestResults(): void {
	invalidateDefinitions(latestResultsKey);
}

export async function recordRun(
	rule: DataRule,
	outcome:
		| { status: "error"; error: string; ms: number }
		| { status: "pass" | "fail"; result: RuleResult; ms: number },
): Promise<void> {
	const result = outcome.status === "error" ? null : outcome.result;
	await sql(
		`INSERT INTO data_rule_runs
		   (rule_id, status, failing, checked, groups, measures, detail, error,
		    duration_ms)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
		[
			rule.ruleId,
			outcome.status,
			result?.failing ?? null,
			result?.checked ?? null,
			JSON.stringify(result?.groups ?? []),
			JSON.stringify(result?.measures ?? {}),
			result?.detail ?? null,
			outcome.status === "error" ? outcome.error : null,
			outcome.ms,
		],
	);
	dropLatestResults();
}

export async function lastRuns(): Promise<
	Map<string, { at: number; measures: Record<string, number> | null }>
> {
	const rows = await sql<{
		rule_id: string;
		run_on: string;
		measures: Record<string, number> | null;
	}>(
		`SELECT DISTINCT ON (rule_id) rule_id::text AS rule_id, run_on, measures
		 FROM data_rule_runs
		 ORDER BY rule_id, run_on DESC`,
	);
	return new Map(
		rows.map((row) => [
			row.rule_id,
			{ at: new Date(row.run_on).getTime(), measures: row.measures },
		]),
	);
}

export interface RuleView {
	rule: DataRule;
	last: {
		status: "pass" | "fail" | "error";
		runOn: string;
		// Null on a source whose counts this person may not see.
		failing: number | null;
		checked: number | null;
		groups: { label: string; failing: number; checked: number }[];
		detail: string | null;
		error: string | null;
		durationMs: number;
	} | null;
	history: { runOn: string; status: string; failing: number | null }[];
	incident: {
		incidentId: string;
		status: "open" | "acknowledged";
		openedOn: string;
		acknowledgedBy: string | null;
		mutedUntil: string | null;
		note: string | null;
	} | null;
	// The last time somebody closed a failure on this rule, while nothing is open.
	lastResolved: {
		resolvedBy: string;
		resolvedOn: string;
		note: string | null;
	} | null;
}

export interface SourceQuality {
	sourceKey: string;
	title: string;
	protected: boolean;
	score: number | null;
	rules: RuleView[];
	affects: { slug: string; title: string }[];
	canManage: boolean;
	tables: string[];
}

// How many runs a rule shows, enough to see a pattern at a glance.
const historyShown = 20;

export async function qualityFor(
	policy: PolicyClass,
	identity: Identity,
	onlySource: string | null,
): Promise<SourceQuality[]> {
	const reachable = await reachableSet(identity);
	const rules = await allActiveRules();
	const visible = rules.filter(
		(rule) =>
			(!onlySource || rule.sourceKey === onlySource) &&
			(!reachable || reachable.has(rule.sourceKey)) &&
			getSource(rule.sourceKey),
	);
	const ruleIds = visible.map((rule) => rule.ruleId);

	const [runs, incidents, closed] = await Promise.all([
		ruleIds.length === 0
			? Promise.resolve([])
			: sql<{
					rule_id: string;
					run_on: string;
					status: "pass" | "fail" | "error";
					failing: string | null;
					checked: string | null;
					groups: {
						label: string;
						failing: number;
						checked: number;
					}[];
					detail: string | null;
					error: string | null;
					duration_ms: number;
				}>(
					`SELECT rule_id::text AS rule_id, run_on, status, failing, checked,
					        groups, detail, error, duration_ms
					 FROM (
					   SELECT *, row_number() OVER (
					     PARTITION BY rule_id ORDER BY run_on DESC
					   ) AS position
					   FROM data_rule_runs WHERE rule_id = ANY($1::uuid[])
					 ) ranked
					 WHERE position <= $2
					 ORDER BY run_on DESC`,
					[ruleIds, historyShown],
				),
		ruleIds.length === 0
			? Promise.resolve([])
			: sql<{
					incident_id: string;
					rule_id: string;
					status: "open" | "acknowledged";
					opened_on: string;
					acknowledged_by: string | null;
					muted_until: string | null;
					note: string | null;
				}>(
					`SELECT incident_id::text AS incident_id, rule_id::text AS rule_id,
					        status, opened_on, acknowledged_by, muted_until, note
					 FROM data_incidents
					 WHERE rule_id = ANY($1::uuid[]) AND status <> 'resolved'`,
					[ruleIds],
				),
		ruleIds.length === 0
			? Promise.resolve([])
			: sql<{
					rule_id: string;
					resolved_by: string;
					resolved_on: string;
					note: string | null;
				}>(
					`SELECT DISTINCT ON (rule_id) rule_id::text AS rule_id, resolved_by,
					        resolved_on, note
					 FROM data_incidents
					 WHERE rule_id = ANY($1::uuid[]) AND status = 'resolved'
					   AND resolved_by IS NOT NULL
					 ORDER BY rule_id, resolved_on DESC`,
					[ruleIds],
				),
	]);

	const keys = onlySource
		? [onlySource]
		: [...new Set(visible.map((rule) => rule.sourceKey))];
	const out: SourceQuality[] = [];
	for (const sourceKey of keys) {
		const source = getSource(sourceKey);
		if (!source) continue;
		if (reachable && !reachable.has(sourceKey)) continue;
		const hidden = source.hasRowFilter;

		const views: RuleView[] = visible
			.filter((rule) => rule.sourceKey === sourceKey)
			.map((rule) => {
				const own = runs.filter((run) => run.rule_id === rule.ruleId);
				const latest = own[0];
				const incident = incidents.find(
					(row) => row.rule_id === rule.ruleId,
				);
				return {
					rule,
					last: latest
						? {
								status: latest.status,
								runOn: latest.run_on,
								failing:
									hidden || latest.failing === null
										? null
										: Number(latest.failing),
								checked:
									hidden || latest.checked === null
										? null
										: Number(latest.checked),
								groups: hidden ? [] : latest.groups,
								detail: hidden ? null : latest.detail,
								error: latest.error,
								durationMs: latest.duration_ms,
							}
						: null,
					history: own.map((run) => ({
						runOn: run.run_on,
						status: run.status,
						failing:
							hidden || run.failing === null
								? null
								: Number(run.failing),
					})),
					incident: incident
						? {
								incidentId: incident.incident_id,
								status: incident.status,
								openedOn: incident.opened_on,
								acknowledgedBy: incident.acknowledged_by,
								mutedUntil: incident.muted_until,
								note: incident.note,
							}
						: null,
					lastResolved: (() => {
						const held = closed.find(
							(row) => row.rule_id === rule.ruleId,
						);
						return held && !incident
							? {
									resolvedBy: held.resolved_by,
									resolvedOn: held.resolved_on,
									note: held.note,
								}
							: null;
					})(),
				};
			});

		const affects = await reportsReading(sourceKey);
		let canManage = true;
		try {
			await assertCanManage(policy, identity.email, sourceKey);
		} catch {
			canManage = false;
		}
		const tables = await tablesOf(sourceKey);
		out.push({
			sourceKey,
			title: source.title,
			protected: hidden,
			score: sourceScore(
				views.flatMap((view) =>
					view.last
						? [
								{
									severity: view.rule.severity,
									status: view.last.status,
								},
							]
						: [],
				),
			),
			rules: views,
			affects: affects.map((report) => ({
				slug: report.slug,
				title: report.title,
			})),
			canManage,
			tables,
		});
	}
	return out;
}

// What the Dictionary shows, for every source this person can read. Whether they can add a rule
// comes from one read of which reports use what, rather than one read per source.
export async function dictionaryRules(
	policy: PolicyClass,
	identity: Identity,
): Promise<
	{
		sourceKey: string;
		canManage: boolean;
		rules: {
			ruleId: string;
			name: string;
			status: "pass" | "fail" | "error" | null;
			columns: string[];
		}[];
		fieldColumns: Record<string, string>;
	}[]
> {
	const reachable = await reachableSet(identity);
	const sources = listSources().filter(
		(source) => !reachable || reachable.has(source.sourceKey),
	);
	const context = await getExplicitContext(policy, identity.email);
	const everywhere = can(
		context.capabilities,
		"rule.manage",
		null,
		context.denied,
	);
	const [rules, latest, reading] = await Promise.all([
		allActiveRules(),
		sql<{ rule_id: string; status: "pass" | "fail" | "error" }>(
			`SELECT DISTINCT ON (rule_id) rule_id::text AS rule_id, status
			 FROM data_rule_runs ORDER BY rule_id, run_on DESC`,
		),
		everywhere
			? Promise.resolve([])
			: sql<{
					report_id: string;
					category_id: string | null;
					tags: string[] | null;
					source_key: string;
				}>(
					`SELECT DISTINCT r.report_id::text AS report_id, r.category_id, r.tags,
					        k.source_key
					 FROM reports r
					 LEFT JOIN report_pages p ON p.report_id = r.report_id AND p.is_active
					 LEFT JOIN report_visuals v ON v.page_id = p.page_id AND v.is_active
					 CROSS JOIN LATERAL unnest(
					   ARRAY[r.source_key, p.source_key, v.source_key]
					 ) AS k(source_key)
					 WHERE r.is_active = TRUE AND r.is_personal = FALSE
					   AND k.source_key IS NOT NULL`,
				),
	]);
	const statusOf = new Map(latest.map((run) => [run.rule_id, run.status]));
	const manageable = new Set(
		reading.flatMap((report) =>
			canOnReport(
				context.capabilities,
				"rule.manage",
				{
					reportId: report.report_id,
					categoryId: report.category_id,
					tags: report.tags,
				},
				context.denied,
			)
				? [report.source_key]
				: [],
		),
	);
	return sources.map((source) => ({
		sourceKey: source.sourceKey,
		canManage: everywhere || manageable.has(source.sourceKey),
		rules: rules
			.filter((rule) => rule.sourceKey === source.sourceKey)
			.map((rule) => ({
				ruleId: rule.ruleId,
				name: rule.name,
				status: statusOf.get(rule.ruleId) ?? null,
				columns: columnsOfRule(rule.params),
			})),
		fieldColumns: Object.fromEntries(
			[...source.dimensions, ...source.measures].flatMap((field) => {
				const column = columnOfField(field.sqlExpr ?? null);
				return column ? [[field.name, column]] : [];
			}),
		),
	}));
}

// What a rule on this source can check. A metric view hides duplicates, so its real
// tables are what get checked.
export async function tablesOf(sourceKey: string): Promise<string[]> {
	const source = getSource(sourceKey);
	if (!source) return [];
	const self = [source.catalog, source.schema, source.object]
		.filter(Boolean)
		.join(".");
	if (source.kind !== "metric_view") return [self];
	const rows = await sql<{ base_tables: string[] | null }>(
		`SELECT base_tables FROM data_sources WHERE source_key = $1`,
		[sourceKey],
	);
	return rows[0]?.base_tables ?? [];
}

// What a report page warns about. Failing rules on what the page reads, without counts.
export async function failingFor(
	identity: Identity,
	sourceKeys: string[],
): Promise<
	{
		sourceKey: string;
		sourceTitle: string;
		failing: { name: string; severity: Severity }[];
		score: number | null;
	}[]
> {
	const reachable = await reachableSet(identity);
	return rulesFailing(
		sourceKeys.filter((key) => !reachable || reachable.has(key)),
	);
}

// The latest result of each rule on these sources. Checks no reader, so a caller holds
// the check, as failingFor does and as a scheduled run does while its owner is away.
export async function rulesFailing(sourceKeys: string[]): Promise<
	{
		sourceKey: string;
		sourceTitle: string;
		failing: { name: string; severity: Severity }[];
		score: number | null;
	}[]
> {
	const keys = [
		...new Set(sourceKeys.filter((key) => getSource(key))),
	].sort();
	if (keys.length === 0) return [];
	// Every report page reading these sources asks this, and the answer changes only when
	// a rule runs, is saved or removed, so it is held until one of those.
	const rows = await cachedDefinition(
		`${latestResultsKey}${keys.join(",")}`,
		() =>
			sql<{
				source_key: string;
				name: string;
				severity: Severity;
				status: "pass" | "fail" | "error";
			}>(
				`SELECT DISTINCT ON (r.rule_id) r.source_key, r.name, r.severity, u.status
				 FROM data_rules r
				 JOIN data_rule_runs u ON u.rule_id = r.rule_id
				 WHERE r.is_active = TRUE AND r.source_key = ANY($1::text[])
				 ORDER BY r.rule_id, u.run_on DESC`,
				[keys],
			),
	);
	return keys.flatMap((sourceKey) => {
		const own = rows.filter((row) => row.source_key === sourceKey);
		if (own.length === 0) return [];
		return [
			{
				sourceKey,
				sourceTitle: getSource(sourceKey)?.title ?? sourceKey,
				failing: own
					.filter((row) => row.status === "fail")
					.map((row) => ({ name: row.name, severity: row.severity })),
				score: sourceScore(own),
			},
		];
	});
}

// --- Incidents ----------------------------------------------------------------

export async function changeIncident(
	policy: PolicyClass,
	identity: Identity,
	ruleId: string,
	action: "acknowledge" | "resolve" | "mute",
	muteDays?: number,
	note?: string | null,
): Promise<void> {
	const said = note?.trim().slice(0, 2000) || null;
	const rule = await ruleById(ruleId);
	if (!rule) throw new DataRuleError("Not found", 404);
	await assertCanManage(policy, identity.email, rule.sourceKey);

	if (action === "mute") {
		const days = muteDays && muteDays > 0 ? muteDays : 7;
		await sql(
			`UPDATE data_rules
			 SET muted_until = now() + make_interval(days => $2::int)
			 WHERE rule_id = $1`,
			[ruleId, days],
		);
		await sql(
			`UPDATE data_incidents
			 SET muted_until = now() + make_interval(days => $2::int),
			     note = coalesce($3, note)
			 WHERE rule_id = $1 AND status <> 'resolved'`,
			[ruleId, days, said],
		);
	} else if (action === "acknowledge") {
		await sql(
			`UPDATE data_incidents
			 SET status = 'acknowledged', acknowledged_by = $2, acknowledged_on = now(),
			     note = coalesce($3, note)
			 WHERE rule_id = $1 AND status = 'open'`,
			[ruleId, identity.email, said],
		);
	} else {
		await sql(
			`UPDATE data_incidents
			 SET status = 'resolved', resolved_by = $2, resolved_on = now(),
			     note = coalesce($3, note)
			 WHERE rule_id = $1 AND status <> 'resolved'`,
			[ruleId, identity.email, said],
		);
	}
	await insertLog({
		recordType: "data_rule",
		recordId: ruleId,
		action: `${action}_data_incident`,
		changedBy: identity.email,
		notes: said,
	});
}
