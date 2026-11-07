import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/data/lakebase";
import { reachableSet } from "@/lib/platform/sources";
import { executeQuery, QueryAccessError } from "@/lib/query/execute";
import { parseQuerySpec, QuerySpecError } from "@/lib/query/spec";
import { getSource } from "@/lib/semantic/registry";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { visibleUpdates } from "@/lib/updates/store";
import { failingFor } from "@/lib/dataRules/store";
import { caller, privateJson, readJson } from "../notifications/guard";

// What is behind one figure. Its definition, the filters in effect, when the data last
// loaded, what has been said about it and how it breaks down. Every query runs as the
// person asking. Real rows only come from a plain table, since a metric view answers in
// aggregates and has no rows to give.

const breakdownsTried = 5;
const rowsShown = 50;

// { sourceKey, measure, filters }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;

	const source = getSource(String(body.sourceKey ?? ""));
	const reachable = await reachableSet(identity);
	if (!source || (reachable && !reachable.has(source.sourceKey))) {
		return privateJson(
			{ error: "That dataset is not one you can read." },
			403,
		);
	}
	const measure = String(body.measure ?? "");
	const field = source.measures.find((m) => m.name === measure);
	if (!field)
		return privateJson({ error: "That is not a measure here." }, 400);
	const filters = Array.isArray(body.filters) ? body.filters : [];

	try {
		const [stored, loaded, policy] = await Promise.all([
			sql<{ fingerprint: { expression?: string | null } | null }>(
				`SELECT fingerprint FROM source_fields
				 WHERE source_key = $1 AND field_name = $2`,
				[source.sourceKey, measure],
			),
			sql<{
				last_arrival: string | null;
				data_changed_on: string | null;
			}>(
				`SELECT last_arrival, data_changed_on FROM data_sources
				 WHERE source_key = $1`,
				[source.sourceKey],
			),
			resolvePolicyClass(identity),
		]);

		const total = await executeQuery(
			identity,
			parseQuerySpec({
				sourceKey: source.sourceKey,
				dimensions: [],
				measures: [measure],
				filters,
			}),
		);

		const dimensions = source.dimensions
			.filter(
				(dimension) =>
					!/^(date|timestamp)/i.test(dimension.dataType ?? ""),
			)
			.slice(0, breakdownsTried);
		const answers = await Promise.all(
			dimensions.map(async (dimension) => {
				const answer = await executeQuery(
					identity,
					parseQuerySpec({
						sourceKey: source.sourceKey,
						dimensions: [dimension.name],
						measures: [measure],
						filters,
						limit: 200,
					}),
				).catch(() => null);
				return answer
					? {
							field: dimension.name,
							rows: answer.rows
								.map((row) => ({
									label: String(
										row[dimension.name] ?? "(blank)",
									),
									value: Number(row[measure] ?? 0),
								}))
								.sort(
									(a, b) =>
										Math.abs(b.value) - Math.abs(a.value),
								),
						}
					: null;
			}),
		);

		let rows: Record<string, unknown>[] | null = null;
		if (source.kind === "table") {
			const answer = await executeQuery(
				identity,
				parseQuerySpec({
					sourceKey: source.sourceKey,
					dimensions: source.dimensions
						.slice(0, 12)
						.map((d) => d.name),
					measures: [],
					filters,
					limit: rowsShown,
				}),
			).catch(() => null);
			rows = answer?.rows ?? null;
		}

		const [updates, quality] = await Promise.all([
			visibleUpdates(policy, identity).catch(() => []),
			failingFor(identity, [source.sourceKey]).catch(() => []),
		]);
		const about = updates
			.filter((update) =>
				update.about.some(
					(item) =>
						(item.kind === "field" &&
							item.id === measure &&
							item.sourceKey === source.sourceKey) ||
						(item.kind === "source" &&
							item.id === source.sourceKey),
				),
			)
			.slice(0, 5)
			.map((update) => ({
				updateId: update.updateId,
				title: update.title,
				postedOn: update.postedOn,
			}));

		return privateJson({
			measure,
			sourceTitle: source.title,
			kind: source.kind,
			description: field.description,
			formatHint: field.formatHint ?? null,
			expression: stored[0]?.fingerprint?.expression ?? null,
			total: total.rows[0]?.[measure] ?? null,
			computedAt: total.computedAt,
			lastLoad:
				loaded[0]?.last_arrival ?? loaded[0]?.data_changed_on ?? null,
			filters,
			breakdowns: answers.filter(Boolean),
			rows,
			updates: about,
			failingRules: quality[0]?.failing ?? [],
		});
	} catch (error) {
		if (
			error instanceof QueryAccessError ||
			error instanceof QuerySpecError
		) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("Could not work out what is behind a figure:", error);
		return privateJson({ error: "Could not load this" }, 500);
	}
}
