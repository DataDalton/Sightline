import { asApp } from "../alerts/runner";
import { sql } from "../data/lakebase";
import { claimRun } from "../freshness/claim";
import { routineLooksAllowed } from "../freshness/warehouse";
import { notify } from "../notify/store";
import { maintainersFor } from "../platform/dependents";
import { sourcesInMaintenance } from "../updates/store";
import { getSource } from "../semantic/registry";
import {
	compileRule,
	isDue,
	judge,
	nextIncident,
	RuleError,
	type DataRule,
	type RuleResult,
} from "./rules";
import { allActiveRules, lastRuns, recordRun, reportsReading } from "./store";

// Running data rules, with nobody signed in.
//
// This is the one place a check on data runs as the app. It keeps counts only, and only
// people who can read the source are shown them. Failing rows are never read here. See
// lib/dataRules/rules.

const claimName = "data-rules";
// Long enough that the replica holding the claim finishes before another takes it.
const claimSeconds = 55;
// Rules started on one tick, so a pile of them due together spreads out across ticks
// rather than pressing on the warehouse all at once.
const rulesPerPass = 5;

class OverBudget extends Error {}

export async function runOneRule(
	rule: DataRule,
	previous: Record<string, number> | null,
): Promise<void> {
	const startedAt = Date.now();
	let result: RuleResult;
	try {
		const check = compileRule(rule);
		const budget = new Promise<never>((_, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new OverBudget(
							`Took longer than its ${rule.budgetSeconds} second budget.`,
						),
					),
				rule.budgetSeconds * 1000,
			);
			timer.unref?.();
		});
		const rows = await Promise.race([
			asApp(check.sql, check.params),
			budget,
		]);
		result = judge(rule, rows as Record<string, unknown>[], previous);
	} catch (error) {
		await recordRun(rule, {
			status: "error",
			error:
				error instanceof RuleError || error instanceof OverBudget
					? error.message
					: "The check could not run. Its query was refused or failed.",
			ms: Date.now() - startedAt,
		});
		if (!(error instanceof RuleError) && !(error instanceof OverBudget)) {
			console.warn(`Data rule ${rule.ruleId} failed to run:`, error);
		}
		return;
	}

	await recordRun(rule, {
		status: result.status,
		result,
		ms: Date.now() - startedAt,
	});
	await applyIncident(rule, result);
}

async function applyIncident(
	rule: DataRule,
	result: RuleResult,
): Promise<void> {
	const held = await sql<{
		incident_id: string;
		status: "open" | "acknowledged" | "resolved";
	}>(
		`SELECT incident_id::text AS incident_id, status FROM data_incidents
		 WHERE rule_id = $1 AND status <> 'resolved'
		 ORDER BY opened_on DESC LIMIT 1`,
		[rule.ruleId],
	);
	const muted = await sql<{ muted_until: string | null }>(
		`SELECT muted_until FROM data_rules WHERE rule_id = $1`,
		[rule.ruleId],
	);
	const mutedUntil = muted[0]?.muted_until
		? new Date(muted[0].muted_until).getTime()
		: null;
	const now = Date.now();
	const next = nextIncident(
		held[0]
			? { status: held[0].status, mutedUntil }
			: { status: "resolved", mutedUntil },
		result,
		now,
	);

	if (next.action === "resolve" && held[0]) {
		await sql(
			`UPDATE data_incidents SET status = 'resolved', resolved_on = now()
			 WHERE incident_id = $1`,
			[held[0].incident_id],
		);
	}
	if (next.action === "open") {
		await sql(
			`INSERT INTO data_incidents (rule_id, severity, muted_until)
			 VALUES ($1, $2, $3)`,
			[rule.ruleId, rule.severity, muted[0]?.muted_until ?? null],
		);
	}
	// Expected while the source is down for maintenance, so nobody is told. The run and
	// the incident stay on record.
	if (next.notify && !(await sourcesInMaintenance()).has(rule.sourceKey)) {
		await tellPeople(rule);
	}
}

// Told by name only, without a figure. The rule's owner chose this, and Maintainers of
// reports on the source can already read it through those reports.
async function tellPeople(rule: DataRule): Promise<void> {
	const source = getSource(rule.sourceKey);
	const reports = await reportsReading(rule.sourceKey);
	const maintainers = await maintainersFor(
		reports.flatMap((report) =>
			report.category_id ? [report.category_id] : [],
		),
	).catch(() => [] as string[]);
	const people = new Set(
		[...(rule.owner ? [rule.owner] : []), ...maintainers].map((person) =>
			person.toLowerCase(),
		),
	);
	for (const person of people) {
		void notify(person, {
			kind: "data",
			title: `A data rule failed on ${source?.title ?? rule.sourceKey}`,
			body: rule.name,
			link: `/status?tab=quality&source=${encodeURIComponent(rule.sourceKey)}`,
		}).catch((error) => {
			console.warn("A data rule notification was not delivered:", error);
		});
	}
}

// Latest load per source, which is what after-load rules wait on.
async function lastLoads(): Promise<Map<string, number>> {
	const rows = await sql<{ source_key: string; loaded_on: string | null }>(
		`SELECT source_key, GREATEST(last_arrival, data_changed_on) AS loaded_on
		 FROM data_sources WHERE is_active`,
	);
	return new Map(
		rows.flatMap((row) =>
			row.loaded_on
				? [
						[row.source_key, new Date(row.loaded_on).getTime()] as [
							string,
							number,
						],
					]
				: [],
		),
	);
}

// One pass. Each rule due is run in turn on the replica holding the claim.
export async function runDueRules(): Promise<void> {
	if (!(await routineLooksAllowed())) return;
	if (!(await claimRun(claimName, claimSeconds))) return;

	const [rules, runs, loads] = await Promise.all([
		allActiveRules(),
		lastRuns(),
		lastLoads(),
	]);
	const now = Date.now();
	const due = rules
		.filter((rule) =>
			isDue(
				rule,
				runs.get(rule.ruleId)?.at ?? null,
				loads.get(rule.sourceKey) ?? null,
				now,
			),
		)
		// The ones that have waited longest go first, so none is starved.
		.sort(
			(a, b) =>
				(runs.get(a.ruleId)?.at ?? 0) - (runs.get(b.ruleId)?.at ?? 0),
		)
		.slice(0, rulesPerPass);

	for (const rule of due) {
		await runOneRule(rule, runs.get(rule.ruleId)?.measures ?? null);
	}
}

// Run history older than the retention setting goes with everything else it covers.
export async function pruneRuleRuns(months: number): Promise<void> {
	if (!(months > 0)) return;
	await sql(
		`DELETE FROM data_rule_runs
		 WHERE run_on < now() - make_interval(months => $1::int)`,
		[months],
	);
}
