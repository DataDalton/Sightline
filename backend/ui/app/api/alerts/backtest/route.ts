import { NextRequest, NextResponse } from "next/server";
import { backtest } from "@/lib/alerts/backtest";
import { AlertDefinitionError, cleanDefinition } from "@/lib/alerts/rule";
import { alertSpec } from "@/lib/alerts/store";
import { reachableSet } from "@/lib/platform/sources";
import { executeQuery, QueryAccessError } from "@/lib/query/execute";
import { parseQuerySpec, QuerySpecError } from "@/lib/query/spec";
import { getSource } from "@/lib/semantic/registry";
import { caller, privateJson, readJson } from "../../notifications/guard";

// How often an alert would have fired over the past year, as the person asking, before they
// save it. One query, by day. A figure is read as it stood on each day, not added up to that
// point, which the answer says plainly.

const yearOfDays = 366;

export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	try {
		const definition = cleanDefinition(await readJson(request));
		const source = getSource(definition.sourceKey);
		const reachable = await reachableSet(identity);
		if (!source || (reachable && !reachable.has(source.sourceKey))) {
			return privateJson(
				{ error: "That dataset is not one you can read." },
				403,
			);
		}
		const timeField = source.defaultTimeField;
		if (!timeField) {
			return privateJson({
				available: false,
				reason: "This source has no date to look back along.",
			});
		}

		const since = new Date(Date.now() - yearOfDays * 86_400_000)
			.toISOString()
			.slice(0, 10);
		const base = alertSpec(source, definition) as unknown as {
			filters?: unknown[];
			anyOf?: unknown;
			where?: unknown;
		};
		const answer = await executeQuery(
			identity,
			parseQuerySpec({
				sourceKey: source.sourceKey,
				dimensions: [
					timeField,
					...(definition.groupBy ? [definition.groupBy] : []),
				],
				measures: [definition.measure],
				filters: [
					...(base.filters ?? []),
					{ field: timeField, op: "gte", value: since },
				],
				...(base.anyOf ? { anyOf: base.anyOf } : {}),
				...(base.where ? { where: base.where } : {}),
				sort: [{ field: timeField, direction: "asc" }],
				limit: 20000,
			}),
		);
		const result = backtest(
			definition,
			answer.rows.map((row) => ({
				period: String(row[timeField]).slice(0, 10),
				group: definition.groupBy
					? String(row[definition.groupBy] ?? "")
					: null,
				value:
					row[definition.measure] === null
						? null
						: Number(row[definition.measure]),
			})),
		);
		return privateJson({ available: true, ...result });
	} catch (error) {
		if (
			error instanceof AlertDefinitionError ||
			error instanceof QueryAccessError ||
			error instanceof QuerySpecError
		) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("Could not look back over an alert:", error);
		return privateJson({ error: "Could not look back" }, 500);
	}
}
