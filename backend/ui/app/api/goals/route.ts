import { NextRequest, NextResponse } from "next/server";
import type { Identity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { insertLog } from "@/lib/activityLog";
import { sql } from "@/lib/data/lakebase";
import { getReport } from "@/lib/platform/reports";
import { executeQuery } from "@/lib/query/execute";
import { parseQuerySpec } from "@/lib/query/spec";
import { getSource } from "@/lib/semantic/registry";
import { goalStatus } from "@/lib/insight/insight";
import { goalBelongsOnPage, measuresOnPage } from "@/lib/insight/pageGoals";
import { caller, privateJson, readJson } from "../notifications/guard";

// Goals on a report, shown on its pages holding the goal's measure. Who can open the report sees
// them and who can edit the page looks after them, so no permission of their own is needed.
//
// Each figure is read as the person looking and kept against them, so progress never shows anyone
// a number their own access would not. Looking is what records a day's value, so nothing runs
// with nobody here.

interface GoalRow {
	goal_id: string;
	title: string;
	source_key: string;
	measure: string;
	filters: { field: string; op: string; value: string }[];
	target: number;
	created_by: string;
	due_on: string | null;
	created_on: string;
}

// The report a page sits in as this person may see it, with what they may do on that page.
async function placeOf(identity: Identity, pageId: string) {
	const [found] = await sql<{ slug: string }>(
		`SELECT r.slug FROM report_pages p
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE p.page_id::text = $1 AND p.is_active AND r.is_active`,
		[pageId],
	);
	if (!found) return null;
	const policy = await resolvePolicyClass(identity);
	const report = await getReport(policy, identity, found.slug);
	const page = report?.pages.find((held) => held.pageId === pageId);
	if (!report || !page) return null;
	const measuresOf = (held: typeof page) =>
		measuresOnPage(
			held.visuals.map((visual) => ({
				visualType: visual.visualType,
				sourceKey: visual.sourceKey,
				config: visual.config as { measures?: unknown },
			})),
			held.sourceKey,
		);
	return {
		report,
		// Only a page that differs from the report is listed.
		canManage:
			(pageId in report.pageModes
				? report.pageModes[pageId]
				: report.editMode) === "edit",
		onPage: measuresOf(page),
		onReport: report.pages.flatMap(measuresOf),
	};
}

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const pageId = request.nextUrl.searchParams.get("pageId") ?? "";
	try {
		const place = await placeOf(identity, pageId);
		if (!place) {
			return privateJson({
				goals: [],
				all: [],
				measures: [],
				canManage: false,
			});
		}
		const rows = await sql<GoalRow>(
			`SELECT goal_id::text AS goal_id, title, source_key, measure, filters,
			        target, created_by, due_on, created_on
			 FROM goals
			 WHERE is_active AND report_id = $1::uuid
			 ORDER BY due_on NULLS LAST, title`,
			[place.report.reportId],
		);
		const here = rows.filter((goal) =>
			goalBelongsOnPage(goal, place.onPage),
		);

		const describe = (goal: GoalRow) => {
			const source = getSource(goal.source_key);
			return {
				goalId: goal.goal_id,
				title: goal.title,
				sourceKey: goal.source_key,
				measure: goal.measure,
				filter: goal.filters[0] ?? null,
				formatHint:
					source?.measures.find((m) => m.name === goal.measure)
						?.formatHint ?? "decimal",
				target: goal.target,
				createdBy: goal.created_by,
				dueOn: goal.due_on,
				onAnyPage: goalBelongsOnPage(goal, place.onReport),
			};
		};

		const goals = await Promise.all(
			here.map(async (goal) => {
				const answer = await executeQuery(
					identity,
					parseQuerySpec({
						sourceKey: goal.source_key,
						dimensions: [],
						measures: [goal.measure],
						filters: goal.filters,
					}),
				).catch(() => null);
				const raw = answer?.rows[0]?.[goal.measure];
				const current =
					raw === undefined || raw === null ? null : Number(raw);
				if (current !== null && Number.isFinite(current)) {
					await sql(
						`INSERT INTO goal_progress (goal_id, user_email, day, value)
						 VALUES ($1, lower($2), CURRENT_DATE, $3)
						 ON CONFLICT (goal_id, user_email, day)
						 DO UPDATE SET value = EXCLUDED.value`,
						[goal.goal_id, identity.email, current],
					);
				}
				const history = await sql<{ day: string; value: number }>(
					`SELECT day::text AS day, value FROM goal_progress
					 WHERE goal_id = $1 AND user_email = lower($2)
					 ORDER BY day`,
					[goal.goal_id, identity.email],
				);
				return {
					...describe(goal),
					current,
					history,
					status:
						current === null
							? null
							: goalStatus({
									start: history[0]?.value ?? current,
									current,
									target: goal.target,
									startedOn:
										history[0]?.day ?? goal.created_on,
									dueOn: goal.due_on,
									now: Date.now(),
								}),
				};
			}),
		);

		return privateJson({
			goals,
			// Every goal on the report, for the list in the editor.
			all: rows.map(describe),
			measures: place.onPage.map(({ sourceKey, measure }) => {
				const source = getSource(sourceKey);
				return {
					sourceKey,
					sourceTitle: source?.title ?? sourceKey,
					measure,
					fields: source?.dimensions.map((f) => f.name) ?? [],
				};
			}),
			canManage: place.canManage,
		});
	} catch (error) {
		console.error("Could not read goals:", error);
		return privateJson({ error: "Could not load goals" }, 500);
	}
}

// { action: "save", pageId, goalId?, title, sourceKey, measure, filter, target, dueOn }
// { action: "remove", pageId, goalId }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const goalId = body.goalId ? String(body.goalId) : null;

	try {
		const place = await placeOf(identity, String(body.pageId ?? ""));
		if (!place) return privateJson({ error: "Not found" }, 404);
		if (!place.canManage) {
			return privateJson(
				{ error: "Only someone who can edit this page can do this." },
				403,
			);
		}
		const reportId = place.report.reportId;

		if (goalId) {
			const held = await sql<{ goal_id: string }>(
				`SELECT goal_id FROM goals
				 WHERE goal_id = $1 AND report_id = $2::uuid AND is_active`,
				[goalId, reportId],
			);
			if (!held[0]) return privateJson({ error: "Not found" }, 404);
		}

		if (body.action === "remove" && goalId) {
			await sql(`UPDATE goals SET is_active = FALSE WHERE goal_id = $1`, [
				goalId,
			]);
			await insertLog({
				recordType: "goal",
				recordId: goalId,
				action: "remove_goal",
				changedBy: identity.email,
			});
			return privateJson({ ok: true });
		}

		const title = String(body.title ?? "").trim();
		const sourceKey = String(body.sourceKey ?? "");
		const measure = String(body.measure ?? "");
		const target = Number(body.target);
		const source = getSource(sourceKey);
		if (!title) return privateJson({ error: "A goal needs a name." }, 400);
		if (!source?.measures.some((m) => m.name === measure)) {
			return privateJson(
				{ error: "Choose a measure on that source." },
				400,
			);
		}
		if (!Number.isFinite(target)) {
			return privateJson({ error: "A goal needs a target number." }, 400);
		}
		// Changing a goal whose measure has left the report is how it gets fixed, so only a
		// new goal has to start from a measure the report shows.
		if (
			!goalId &&
			!goalBelongsOnPage(
				{ source_key: sourceKey, measure },
				place.onReport,
			)
		) {
			return privateJson(
				{ error: "Choose a measure this report shows." },
				400,
			);
		}

		const dueOn = body.dueOn ? String(body.dueOn) : null;
		// One field and one value at most, such as a single region.
		const asked = (body.filter ?? null) as {
			field?: unknown;
			value?: unknown;
		} | null;
		const filterField = String(asked?.field ?? "");
		const filterValue = String(asked?.value ?? "");
		if (
			filterField &&
			!source.dimensions.some((d) => d.name === filterField)
		) {
			return privateJson(
				{ error: "Choose a field on that source." },
				400,
			);
		}
		const filters = JSON.stringify(
			filterField && filterValue
				? [{ field: filterField, op: "eq", value: filterValue }]
				: [],
		);
		const rows = goalId
			? await sql<{ goal_id: string }>(
					`UPDATE goals SET title = $2, source_key = $3, measure = $4,
					   filters = $5::jsonb, target = $6, due_on = $7
					 WHERE goal_id = $1
					 RETURNING goal_id::text AS goal_id`,
					[goalId, title, sourceKey, measure, filters, target, dueOn],
				)
			: await sql<{ goal_id: string }>(
					`INSERT INTO goals
					   (title, source_key, measure, filters, target, due_on, created_by,
					    report_id)
					 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::uuid)
					 RETURNING goal_id::text AS goal_id`,
					[
						title,
						sourceKey,
						measure,
						filters,
						target,
						dueOn,
						identity.email,
						reportId,
					],
				);
		await insertLog({
			recordType: "goal",
			recordId: rows[0].goal_id,
			action: goalId ? "update_goal" : "create_goal",
			changedBy: identity.email,
			newValue: title,
		});
		return privateJson({ goalId: rows[0].goal_id });
	} catch (error) {
		console.error("A goal request failed:", error);
		return privateJson({ error: "Could not do that" }, 500);
	}
}
