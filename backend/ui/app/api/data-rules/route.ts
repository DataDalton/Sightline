import { NextRequest, NextResponse } from "next/server";
import type { Identity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { asOwner } from "@/lib/alerts/runner";
import {
	dictionaryRules,
	lastRuns,
	qualityFor,
	ruleById,
	saveRule,
	removeRule,
	changeIncident,
	assertCanManage,
	DataRuleError,
	failingFor,
	listRuleTemplates,
	removeRuleTemplate,
	saveRuleTemplate,
	tablesOf,
} from "@/lib/dataRules/store";
import { runOneRule } from "@/lib/dataRules/runner";
import {
	compileFailingRows,
	quoteTable,
	RuleError,
	suggestRules,
} from "@/lib/dataRules/rules";
import { reachableSet } from "@/lib/platform/sources";
import { runCatalogQuery } from "@/lib/semantic/ucMetadata";
import { caller, privateJson, readJson } from "../notifications/guard";

// Data rules, their results, and everything done to them. Also how an automation
// manages rules, since this is the same API for everyone. See lib/dataRules.

// Enough rows to see what is wrong without turning this into an export.
const failingRowsShown = 100;

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const params = request.nextUrl.searchParams;
	try {
		// What a report page warns about, for the sources it reads.
		const pageSources = params.get("sources");
		if (pageSources !== null) {
			return privateJson({
				sources: await failingFor(
					identity,
					pageSources.split(",").filter(Boolean),
				),
			});
		}
		const policy = await resolvePolicyClass(identity);
		if (params.get("dictionary") !== null) {
			return privateJson({
				sources: await dictionaryRules(policy, identity),
			});
		}
		if (params.get("templates") !== null) {
			return privateJson({
				templates: await listRuleTemplates(policy, identity),
			});
		}
		return privateJson({
			sources: await qualityFor(policy, identity, params.get("source")),
		});
	} catch (error) {
		console.error("Could not read data rules:", error);
		return privateJson({ error: "Could not load data rules" }, 500);
	}
}

export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const action = String(body.action ?? "");
	const ruleId = String(body.ruleId ?? "");

	try {
		const policy = await resolvePolicyClass(identity);

		if (action === "save") {
			return privateJson({
				rule: await saveRule(policy, identity, body),
			});
		}
		if (action === "remove") {
			await removeRule(policy, identity, ruleId);
			return privateJson({ ok: true });
		}
		if (action === "saveTemplate") {
			await saveRuleTemplate(policy, identity, body);
			return privateJson({ ok: true });
		}
		if (action === "removeTemplate") {
			await removeRuleTemplate(
				policy,
				identity,
				String(body.templateId ?? ""),
			);
			return privateJson({ ok: true });
		}
		if (
			action === "acknowledge" ||
			action === "resolve" ||
			action === "mute"
		) {
			await changeIncident(
				policy,
				identity,
				ruleId,
				action,
				Number(body.days) || undefined,
				typeof body.note === "string" ? body.note : null,
			);
			return privateJson({ ok: true });
		}
		if (action === "run") {
			const rule = await ruleById(ruleId);
			if (!rule) return privateJson({ error: "Not found" }, 404);
			await assertCanManage(policy, identity.email, rule.sourceKey);
			const runs = await lastRuns();
			await runOneRule(rule, runs.get(ruleId)?.measures ?? null);
			return privateJson({ ok: true });
		}
		if (action === "failingRows") {
			return privateJson(await failingRows(identity, ruleId));
		}
		if (action === "suggest") {
			const sourceKey = String(body.sourceKey ?? "");
			await assertCanManage(policy, identity.email, sourceKey);
			return privateJson(
				await suggestionsFor(
					identity,
					sourceKey,
					String(body.table ?? ""),
				),
			);
		}
		if (action === "backtest") {
			const rule = await ruleById(ruleId);
			if (!rule) return privateJson({ error: "Not found" }, 404);
			await assertCanManage(policy, identity.email, rule.sourceKey);
			return privateJson(
				await backtest(identity, rule, Number(body.days) || 14),
			);
		}
		return privateJson({ error: "Unknown action." }, 400);
	} catch (error) {
		if (error instanceof DataRuleError) {
			return privateJson({ error: error.message }, error.status);
		}
		if (error instanceof RuleError) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("A data rule request failed:", error);
		return privateJson({ error: "Could not do that" }, 500);
	}
}

// Rows behind a failure, as the person asking. Their own filters apply, and a table
// they cannot read says so rather than falling back on anything.
async function failingRows(identity: Identity, ruleId: string) {
	const rule = await ruleById(ruleId);
	if (!rule) throw new DataRuleError("Not found", 404);
	const reachable = await reachableSet(identity);
	if (reachable && !reachable.has(rule.sourceKey)) {
		throw new DataRuleError("Not found", 404);
	}
	const compiled = compileFailingRows(rule, failingRowsShown);
	if (!compiled) {
		throw new DataRuleError("This kind of rule is not about single rows.");
	}
	const run = asOwner(identity);
	if (!run) {
		throw new DataRuleError(
			"Your access could not be confirmed, so these rows were not read.",
			403,
		);
	}
	try {
		return { rows: await run(compiled.sql, compiled.params) };
	} catch (error) {
		console.warn("Reading failing rows was refused:", error);
		throw new DataRuleError(
			"You cannot read this table directly, so these rows are not available to you.",
			403,
		);
	}
}

// A look at a table as the person asking, with its declared key if it has one.
async function suggestionsFor(
	identity: Identity,
	sourceKey: string,
	table: string,
) {
	const allowed = await tablesOf(sourceKey);
	if (!allowed.includes(table)) {
		throw new DataRuleError("That table is not behind this source.");
	}
	const parts = table.split(".");
	if (parts.length !== 3) return { suggestions: [] };
	const [catalog, schema, object] = parts;
	const run = asOwner(identity);
	if (!run) throw new DataRuleError("Could not read that table.", 403);

	const columns = await runCatalogQuery(
		identity,
		`SELECT column_name, full_data_type
		 FROM \`${catalog}\`.information_schema.columns
		 WHERE table_schema = :schema AND table_name = :object
		 ORDER BY ordinal_position`,
		{ schema, object },
	).catch(() => []);
	const keys = await runCatalogQuery(
		identity,
		`SELECT k.column_name
		 FROM \`${catalog}\`.information_schema.table_constraints c
		 JOIN \`${catalog}\`.information_schema.key_column_usage k
		   ON k.constraint_name = c.constraint_name
		  AND k.table_schema = c.table_schema AND k.table_name = c.table_name
		 WHERE c.constraint_type = 'PRIMARY KEY'
		   AND c.table_schema = :schema AND c.table_name = :object
		 ORDER BY k.ordinal_position`,
		{ schema, object },
	).catch(() => []);

	// Counts per column, a limited number of columns so a wide table stays cheap.
	const looked = columns.slice(0, 30).map((row) => ({
		name: String(row.column_name),
		type: String(row.full_data_type),
	}));
	let rowCount = 0;
	const profiled: {
		name: string;
		type: string;
		blanks: number;
		distinct: number;
	}[] = [];
	if (looked.length > 0) {
		const selects = looked.flatMap((column, index) => {
			const quoted = "`" + column.name.replace(/`/g, "``") + "`";
			return [
				`SUM(CASE WHEN ${quoted} IS NULL THEN 1 ELSE 0 END) AS b${index}`,
				`approx_count_distinct(${quoted}) AS d${index}`,
			];
		});
		const rows = await run(
			`SELECT count(*) AS row_total, ${selects.join(", ")} FROM ${quoteTable(table)}`,
			{},
		);
		const row = rows[0] ?? {};
		rowCount = Number(row.row_total ?? 0);
		looked.forEach((column, index) => {
			profiled.push({
				...column,
				blanks: Number(row[`b${index}`] ?? 0),
				distinct: Number(row[`d${index}`] ?? 0),
			});
		});
	}
	return {
		suggestions: suggestRules({
			table,
			primaryKey: keys.map((row) => String(row.column_name)),
			columns: profiled,
			rowCount,
		}),
	};
}

// What a rule would have said on earlier days, where the table keeps its history. As the
// person asking, and counts only. Each day that history no longer reaches says so.
async function backtest(
	identity: Identity,
	rule: NonNullable<Awaited<ReturnType<typeof ruleById>>>,
	days: number,
) {
	const { compileRule, judge } = await import("@/lib/dataRules/rules");
	const run = asOwner(identity);
	if (!run) throw new DataRuleError("Could not read that table.", 403);
	const check = compileRule(rule);
	const quoted = quoteTable(rule.table);
	if (
		rule.kind === "rowCountShift" ||
		rule.kind === "distributionShift" ||
		rule.kind === "schema" ||
		rule.kind === "reconcile"
	) {
		throw new DataRuleError(
			"This kind of rule compares across runs, so it has nothing to look back on.",
		);
	}
	const results: {
		day: string;
		failing: number | null;
		checked: number | null;
		note: string | null;
	}[] = [];
	const count = Math.min(Math.max(days, 1), 30);
	for (let back = count; back >= 1; back -= 1) {
		const day = new Date(Date.now() - back * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		const statement = check.sql
			.split(quoted)
			.join(`${quoted} TIMESTAMP AS OF '${day}'`);
		try {
			const rows = await run(statement, check.params);
			const judged = judge(rule, rows as Record<string, unknown>[], null);
			results.push({
				day,
				failing: judged.failing,
				checked: judged.checked,
				note: null,
			});
		} catch {
			results.push({
				day,
				failing: null,
				checked: null,
				note: "This table's history does not reach that far.",
			});
		}
	}
	return { results };
}
