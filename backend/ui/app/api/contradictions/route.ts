import { NextRequest, NextResponse } from "next/server";
import type { Identity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { sql } from "@/lib/data/lakebase";
import {
	disagree,
	collapseCandidates,
	findCandidates,
	pairKey,
	totalOf,
	type ComparedVisual,
} from "@/lib/platform/contradictionRules";
import { insertLog } from "@/lib/activityLog";
import { pageLink } from "@/lib/deliveries/store";
import { canOnReport, getExplicitContext } from "@/lib/platform/access";
import { listReports } from "@/lib/platform/reports";
import { reachableSet } from "@/lib/platform/sources";
import { executeQuery, QueryAccessError } from "@/lib/query/execute";
import { parseQuerySpec, QuerySpecError } from "@/lib/query/spec";
import { initialQueryForVisual } from "@/lib/query/visualSpec";
import { getSource } from "@/lib/semantic/registry";
import { isPageControl } from "@/lib/visuals/catalog";
import { openingFilters } from "@/lib/visuals/pageDefaults";
import { caller, privateJson, readJson } from "../notifications/guard";

// Published reports showing one measure in ways that can disagree. The list comes from
// their definitions and costs nothing. Comparing a pair runs both queries as the person
// asking, on request, so nobody sees a figure they could not open.

interface VisualRow {
	page_id: string;
	visual_id: string;
	visual_type: string;
	report_id: string;
	report_title: string;
	report_slug: string;
	page_title: string;
	page_is_first: boolean;
	category_id: string | null;
	report_tags: string[] | null;
	title: string | null;
	source_key: string | null;
	page_source: string | null;
	report_source: string | null;
	config: {
		dimensions?: unknown;
		measures?: unknown;
		filters?: unknown;
		options?: Record<string, unknown>;
	};
}

async function comparable(identity: Identity): Promise<ComparedVisual[]> {
	const policy = await resolvePolicyClass(identity);
	const [readable, reachable, rows] = await Promise.all([
		listReports(policy, identity),
		reachableSet(identity),
		sql<VisualRow>(
			`SELECT p.page_id::text AS page_id, v.visual_id::text AS visual_id, v.visual_type,
			        r.report_id::text AS report_id, r.title AS report_title,
			        r.slug AS report_slug, p.title AS page_title, v.title,
			        r.category_id, r.tags AS report_tags,
			        p.sort_order = (SELECT min(sort_order) FROM report_pages
			                        WHERE report_id = r.report_id AND is_active)
			          AS page_is_first,
			        v.source_key, p.source_key AS page_source,
			        r.source_key AS report_source, v.config
			 FROM report_visuals v
			 JOIN report_pages p ON p.page_id = v.page_id AND p.is_active
			 JOIN reports r ON r.report_id = p.report_id AND r.is_active
			 WHERE v.is_active AND r.is_personal = FALSE`,
		),
	]);
	const open = new Set(readable.map((report) => report.reportId));

	// What each page narrows to as it opens, worked out the way the page does. A filter on a
	// field its source lacks reaches nothing, since the page only applies it where it can.
	const byPage = new Map<string, VisualRow[]>();
	for (const row of rows) {
		byPage.set(row.page_id, [...(byPage.get(row.page_id) ?? []), row]);
	}
	const today = new Date();
	const openingByPage = new Map(
		[...byPage].map(([pageId, visuals]) => [
			pageId,
			Object.values(
				openingFilters(
					visuals.map((visual) => ({
						visualId: visual.visual_id,
						visualType: visual.visual_type,
						config: visual.config as never,
					})),
					today,
				),
			).flat(),
		]),
	);
	return rows.flatMap((row) => {
		if (!open.has(row.report_id) || isPageControl(row.visual_type))
			return [];
		const sourceKey =
			row.source_key ?? row.page_source ?? row.report_source;
		if (!sourceKey || (reachable && !reachable.has(sourceKey))) return [];
		const asList = (value: unknown) =>
			Array.isArray(value) ? value.map(String) : [];
		const source = getSource(sourceKey);
		const pageFilters = (openingByPage.get(row.page_id) ?? []).filter(
			(clause) =>
				source?.dimensions.some((field) => field.name === clause.field),
		);
		return asList(row.config?.measures).map((measure) => ({
			visualId: row.visual_id,
			reportId: row.report_id,
			reportTitle: row.report_title,
			reportSlug: row.report_slug,
			pageTitle: row.page_title,
			pageIsFirst: row.page_is_first,
			categoryId: row.category_id,
			reportTags: row.report_tags,
			title: row.title,
			sourceKey,
			measure,
			dimensions: asList(row.config?.dimensions),
			filters: Array.isArray(row.config?.filters)
				? row.config.filters
				: [],
			pageFilters,
			options: row.config?.options ?? {},
		}));
	});
}

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	try {
		const policy = await resolvePolicyClass(identity);
		const context = await getExplicitContext(policy, identity.email);
		const reviews = await sql<{
			pair_key: string;
			note: string;
			decided_by: string;
			decided_on: string;
		}>(
			`SELECT pair_key, note, decided_by, decided_on
			 FROM contradiction_reviews`,
		);
		const reviewOf = new Map(reviews.map((held) => [held.pair_key, held]));
		const mayDecide = (side: ComparedVisual) =>
			canOnReport(
				context.capabilities,
				"report.review",
				{
					reportId: side.reportId,
					categoryId: side.categoryId ?? null,
					tags: side.reportTags,
				},
				context.denied,
			);
		const sideLink = (side: ComparedVisual) =>
			pageLink(
				side.reportSlug,
				side.pageTitle,
				side.pageIsFirst === true,
			);
		return privateJson({
			candidates: collapseCandidates(
				findCandidates(await comparable(identity)),
			).map((candidate) => {
				const key = pairKey(
					candidate.left.visualId,
					candidate.right.visualId,
					candidate.measure,
				);
				const review = reviewOf.get(key);
				return {
					...candidate,
					pairKey: key,
					left: {
						...candidate.left,
						link: sideLink(candidate.left),
					},
					right: {
						...candidate.right,
						link: sideLink(candidate.right),
					},
					canDecide:
						mayDecide(candidate.left) || mayDecide(candidate.right),
					intended: review
						? {
								note: review.note,
								by: review.decided_by,
								on: review.decided_on,
							}
						: null,
				};
			}),
		});
	} catch (error) {
		console.error("Could not look for contradictions:", error);
		return privateJson({ error: "Could not load these" }, 500);
	}
}

// { leftVisualId, rightVisualId, measure }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	try {
		const visuals = await comparable(identity);

		// Saying a difference is on purpose, or taking that back. For someone who looks after
		// one of the two reports, since it is an answer on that report's behalf.
		if (body.action === "intended" || body.action === "reopen") {
			const measure = String(body.measure ?? "");
			const sides = [body.leftVisualId, body.rightVisualId].map((id) =>
				visuals.find((v) => v.visualId === id && v.measure === measure),
			);
			const [one, other] = sides;
			if (!one || !other) return privateJson({ error: "Not found" }, 404);
			const policy = await resolvePolicyClass(identity);
			const context = await getExplicitContext(policy, identity.email);
			const allowed = sides.some(
				(side) =>
					side &&
					canOnReport(
						context.capabilities,
						"report.review",
						{
							reportId: side.reportId,
							categoryId: side.categoryId ?? null,
							tags: side.reportTags,
						},
						context.denied,
					),
			);
			if (!allowed) {
				return privateJson(
					{
						error: "Only a Maintainer of one of these reports can decide this.",
					},
					403,
				);
			}
			const key = pairKey(one.visualId, other.visualId, measure);
			if (body.action === "reopen") {
				await sql(
					`DELETE FROM contradiction_reviews WHERE pair_key = $1`,
					[key],
				);
			} else {
				const note = String(body.note ?? "").trim();
				if (!note) {
					return privateJson(
						{ error: "Say why they are meant to differ." },
						400,
					);
				}
				await sql(
					`INSERT INTO contradiction_reviews (pair_key, note, decided_by)
					 VALUES ($1, $2, $3)
					 ON CONFLICT (pair_key) DO UPDATE SET
					   note = EXCLUDED.note, decided_by = EXCLUDED.decided_by,
					   decided_on = now()`,
					[key, note.slice(0, 1000), identity.email],
				);
			}
			await insertLog({
				recordType: "contradiction",
				recordId: key,
				action:
					body.action === "reopen"
						? "reopen_contradiction"
						: "mark_contradiction_intended",
				changedBy: identity.email,
				newValue: String(body.note ?? ""),
			});
			return privateJson({ ok: true });
		}

		const measure = String(body.measure ?? "");
		const find = (id: unknown) =>
			visuals.find((v) => v.visualId === id && v.measure === measure);
		const left = find(body.leftVisualId);
		const right = find(body.rightVisualId);
		if (!left || !right) return privateJson({ error: "Not found" }, 404);

		const figure = async (visual: ComparedVisual) => {
			const source = getSource(visual.sourceKey);
			if (!source) throw new QuerySpecError("That source is gone.");
			const shape = initialQueryForVisual(
				{
					visualId: visual.visualId,
					visualType: "table",
					config: {
						dimensions: visual.dimensions,
						measures: [visual.measure],
						filters: [
							...(visual.pageFilters ?? []),
							...visual.filters,
						],
						options: visual.options,
					},
				} as never,
				visual.sourceKey,
				source,
			);
			const answer = await executeQuery(
				identity,
				parseQuerySpec({ ...shape, limit: 5000 }),
			);
			return totalOf(answer.rows, visual.measure);
		};
		const [leftTotal, rightTotal] = await Promise.all([
			figure(left),
			figure(right),
		]);
		return privateJson({
			left: leftTotal,
			right: rightTotal,
			disagree: disagree(leftTotal, rightTotal),
		});
	} catch (error) {
		if (
			error instanceof QueryAccessError ||
			error instanceof QuerySpecError
		) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("Could not compare two figures:", error);
		return privateJson({ error: "Could not compare these" }, 500);
	}
}
