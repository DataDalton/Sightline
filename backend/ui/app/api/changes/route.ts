import { NextRequest, NextResponse } from "next/server";
import type { Identity } from "@/lib/auth/identity";
import { resolvePolicyClass, type PolicyClass } from "@/lib/auth/policy";
import { insertLog } from "@/lib/activityLog";
import { refusedUnless } from "@/lib/platform/capabilityGuard";
import { can, getExplicitContext } from "@/lib/platform/access";
import { collectDependents } from "@/lib/platform/dependents";
import {
	posterName,
	sourcesOf,
	UpdateInputError,
	type Follow,
} from "@/lib/updates/model";
import {
	allTypes,
	changeUpdate,
	deleteUpdates,
	historyOf,
	listFollows,
	listTemplates,
	moveIncident,
	noteRead,
	ownDrafts,
	postUpdate,
	postingRule,
	noteOnUpdate,
	ackCounts,
	listAliases,
	removeAlias,
	saveAlias,
	unmatchedGithubNames,
	withNames,
	removeType,
	retractUpdate,
	saveTemplate,
	saveType,
	setFollow,
	sourcesInMaintenance,
	UpdateError,
	updateById,
	visibleUpdates,
	whoAcknowledged,
	removeTemplate,
} from "@/lib/updates/store";
import { sql } from "@/lib/data/lakebase";
import { listReports } from "@/lib/platform/reports";
import { curatedReports } from "@/lib/platform/curated";
import { reachableSet } from "@/lib/platform/sources";
import { listSources } from "@/lib/semantic/registry";
import { caller, privateJson, readJson } from "../notifications/guard";
import { displayNameFromEmail } from "@/lib/auth/names";

// Updates. The page reads this, and any tool can post to it: a GitHub workflow or a
// pipeline signs in as a service principal given the right to post. A reference makes a
// retry land on one entry. See lib/updates.

async function moderates(policy: PolicyClass, email: string): Promise<boolean> {
	const context = await getExplicitContext(policy, email);
	return can(context.capabilities, "update.moderate", null, context.denied);
}

function csvCell(value: unknown): string {
	const text = String(value ?? "");
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// An update starting from a saved template. What the caller sends wins over the template.
async function fromTemplate(
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const named = typeof body.template === "string" ? body.template.trim() : "";
	if (!named) return body;
	const wanted = named.toLowerCase();
	const template = (await listTemplates()).find(
		(held) =>
			held.templateId === named || held.name.toLowerCase() === wanted,
	);
	if (!template) {
		throw new UpdateError(`There is no template called "${named}".`);
	}
	const { template: _template, ...rest } = body;
	return { ...template.fields, type: template.type, ...rest };
}

// What the screens offer to choose from. A person sees only what they can read, and
// each dataset, category and report says whether they may post about it, by the same
// rule publishing checks. A caller who may post updates everywhere, such as a changelog
// automation, gets every dataset and report without the catalogue being asked, since
// attaching an update names a dataset and reads none of its data.
async function updateChoices(policy: PolicyClass, identity: Identity) {
	const rule = await postingRule(policy, identity);
	const [reachable, visibleReports, curated, categories] = await Promise.all([
		rule.everywhere ? null : reachableSet(identity),
		rule.everywhere ? null : listReports(policy, identity),
		curatedReports(),
		sql<{ id: string; name: string }>(
			`SELECT category_id AS id, name FROM categories
			 WHERE is_active = TRUE ORDER BY sort_order, name`,
		),
	]);
	const visibleIds = visibleReports
		? new Set(visibleReports.map((report) => report.reportId))
		: null;
	const reports = curated.filter(
		(row) => !visibleIds || visibleIds.has(row.report_id),
	);
	const pages = await sql<{ id: string; title: string; report_id: string }>(
		`SELECT page_id::text AS id, title, report_id::text AS report_id
		 FROM report_pages
		 WHERE is_active = TRUE AND report_id::text = ANY($1::text[])
		 ORDER BY sort_order`,
		[reports.map((report) => report.report_id)],
	);
	const people = await sql<{ user_email: string }>(
		`SELECT user_email FROM member_groups ORDER BY user_email`,
	);
	const onScope = (scopeId: string) =>
		rule.everywhere || rule.onScope(scopeId);
	return {
		postsEverywhere: rule.everywhere,
		people: people.map((row) => ({
			email: row.user_email,
			name: displayNameFromEmail(row.user_email),
		})),
		sources: listSources()
			.filter((source) => !reachable || reachable.has(source.sourceKey))
			.map((source) => ({
				key: source.sourceKey,
				title: source.title,
				fields: [...source.dimensions, ...source.measures].map(
					(field) => field.name,
				),
				canPost: onScope(source.sourceKey),
			}))
			.sort((a, b) => a.title.localeCompare(b.title)),
		categories: categories.map((category) => ({
			...category,
			canPost: onScope(category.id),
		})),
		reports: reports.map((report) => {
			const ref = {
				reportId: report.report_id,
				categoryId: report.category_id,
				tags: report.tags,
			};
			return {
				id: report.report_id,
				title: report.title,
				canPost: rule.everywhere || rule.onReport(ref, "any"),
				canPostReportChange:
					rule.everywhere || rule.onReport(ref, "reportChange"),
				pages: pages
					.filter((page) => page.report_id === report.report_id)
					.map((page) => ({ id: page.id, title: page.title })),
			};
		}),
	};
}

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const params = request.nextUrl.searchParams;
	const updateId = params.get("id");

	try {
		const policy = await resolvePolicyClass(identity);

		if (params.get("choices") !== null) {
			return privateJson(await updateChoices(policy, identity));
		}
		// Named so an automation can see what it may post from.
		if (params.get("templates") !== null) {
			return privateJson({ templates: await listTemplates() });
		}

		if (updateId) {
			const visible = await visibleUpdates(policy, identity);
			const shown =
				visible.find((u) => u.updateId === updateId) ??
				(await ownDrafts(policy, identity)).find(
					(u) => u.updateId === updateId,
				);
			if (!shown) return privateJson({ error: "Not found" }, 404);
			const sources = sourcesOf(shown.about);
			const fields = shown.about
				.filter((item) => item.kind === "field")
				.map((item) => item.id);
			const affected =
				sources.length > 0
					? await collectDependents(
							sources,
							fields.length > 0 ? fields : null,
						).catch(() => [])
					: [];
			const reports = new Map<string, { slug: string; title: string }>();
			for (const item of affected) {
				if (item.report) {
					reports.set(item.report.reportId, {
						slug: item.report.slug,
						title: item.report.title,
					});
				}
			}
			const canSeeWho =
				shown.createdBy.toLowerCase() ===
					identity.email.toLowerCase() ||
				(await moderates(policy, identity.email));
			return privateJson({
				update: (await withNames([shown]))[0],
				history: await historyOf(updateId).then(async (events) => {
					const aliases = await listAliases();
					return events.map((event) => ({
						...event,
						by_name: posterName(event.by_email, aliases),
					}));
				}),
				affects: [...reports.values()],
				// Who acknowledged it is for the poster and moderators, not other readers.
				acknowledgedBy: canSeeWho
					? await whoAcknowledged(updateId)
					: null,
			});
		}

		// The names an administrator matched or gave, and the GitHub names still waiting for one.
		if (params.get("aliases") !== null) {
			if (!(await moderates(policy, identity.email))) {
				return privateJson({ error: "Not found" }, 404);
			}
			return privateJson({
				aliases: await listAliases(),
				unmatched: await unmatchedGithubNames(),
			});
		}

		const [updates, types, follows, drafts, acks, templates, quiet] =
			await Promise.all([
				visibleUpdates(policy, identity),
				allTypes(),
				listFollows(identity.email),
				ownDrafts(policy, identity),
				ackCounts(),
				listTemplates(),
				sourcesInMaintenance(),
			]);

		if (params.get("format") === "csv") {
			const refused = await refusedUnless(identity, "export.run");
			if (refused) return refused;
			const rows = [
				["Posted", "Type", "Impact", "Title", "Effective", "Reference"],
				...updates.map((u) => [
					u.postedOn,
					u.type,
					u.impact,
					u.title,
					u.effectiveOn,
					u.reference,
				]),
			];
			await insertLog({
				recordType: "export",
				recordId: "updates",
				action: "export_updates",
				changedBy: identity.email,
				newValue: JSON.stringify({ rows: updates.length }),
			});
			return new NextResponse(
				rows.map((row) => row.map(csvCell).join(",")).join("\n"),
				{
					headers: {
						"Content-Type": "text/csv; charset=utf-8",
						"Content-Disposition":
							'attachment; filename="updates.csv"',
						"Cache-Control": "private, no-store",
					},
				},
			);
		}

		const context = await getExplicitContext(policy, identity.email);
		const canModerate = await moderates(policy, identity.email);
		const caller = identity.email.toLowerCase();
		return privateJson({
			// The acknowledgement count goes only to the poster and moderators, and only
			// on an update that asks for acknowledgement.
			updates: (await withNames(updates)).map((update) => ({
				...update,
				acks:
					update.requireAck &&
					(canModerate || update.createdBy.toLowerCase() === caller)
						? (acks.get(update.updateId) ?? 0)
						: null,
			})),
			types,
			follows,
			drafts,
			templates,
			quietSources: [...quiet],
			canPost:
				(context.capabilities.get("update.post")?.size ?? 0) > 0 ||
				(context.capabilities.get("report.edit")?.size ?? 0) > 0,
			canModerate,
		});
	} catch (error) {
		console.error("Could not read updates:", error);
		return privateJson({ error: "Could not load updates" }, 500);
	}
}

// { action: "post", ...update }, or an array as { action: "bulk", updates }
// Either can name a template by name or id, as { template: "Nightly load" }, and whatever
// else is sent fills it in or overrides it.
// { action: "change", updateId, ...fields }
// { action: "retract", updateId, note }
// { action: "delete", reference } or { action: "delete", references: [...] }, removing
// each entry outright with its history, notes and reads. For administrators, and for the
// automation that posted the entry. Answers { deleted, notFound }.
// { action: "incident", updateId, state, note }
// { action: "read", updateId, acknowledged? }
// { action: "note", updateId, note }
// { action: "saveAlias", kind: "github" | "principal", alias, email?, displayName? }
// { action: "removeAlias", alias }
// An update takes authors as emails, "github:name" or plain names, a past effectiveOn with
// placement "history" to sit back at that date, and notify false to tell nobody.
// { action: "follow", kind, value, mode, on }
// { action: "saveType" | "removeType" | "saveTemplate", ... }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const action = String(body.action ?? "post");
	const updateId = String(body.updateId ?? "");

	try {
		const policy = await resolvePolicyClass(identity);
		return privateJson(await act(action, policy, identity, updateId, body));
	} catch (error) {
		if (error instanceof UpdateError) {
			return privateJson({ error: error.message }, error.status);
		}
		if (error instanceof UpdateInputError) {
			return privateJson({ error: error.message }, 400);
		}
		console.error("An updates request failed:", error);
		return privateJson({ error: "Could not do that" }, 500);
	}
}

async function act(
	action: string,
	policy: PolicyClass,
	identity: Identity,
	updateId: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	switch (action) {
		case "post":
			return postUpdate(policy, identity, await fromTemplate(body));
		case "bulk": {
			const items = Array.isArray(body.updates) ? body.updates : [];
			const results = [];
			for (const item of items) {
				results.push(
					await postUpdate(
						policy,
						identity,
						await fromTemplate(item as Record<string, unknown>),
					),
				);
			}
			return { results };
		}
		case "removeTemplate":
			await removeTemplate(
				policy,
				identity,
				String(body.templateId ?? ""),
			);
			return { ok: true };
		case "change":
			return {
				update: await changeUpdate(policy, identity, updateId, body),
			};
		case "retract":
			await retractUpdate(policy, identity, updateId, body.note);
			return { ok: true };
		case "delete":
			return deleteUpdates(policy, identity, body);
		case "incident": {
			const state = String(body.state);
			if (
				state !== "investigating" &&
				state !== "identified" &&
				state !== "resolved"
			) {
				throw new UpdateError(
					"That is not a state an incident can be in.",
				);
			}
			await moveIncident(policy, identity, updateId, state, body.note);
			return { ok: true };
		}
		case "note":
			await noteOnUpdate(policy, identity, updateId, body.note);
			return { ok: true };
		case "read":
			if (!(await updateById(updateId))) {
				throw new UpdateError("Not found", 404);
			}
			await noteRead(
				identity.email,
				updateId,
				body.acknowledged === true,
			);
			return { ok: true };
		case "follow":
			await setFollow(
				identity.email,
				{
					kind: String(body.kind) as Follow["kind"],
					value: String(body.value ?? ""),
					mode: body.mode === "digest" ? "digest" : "instant",
				},
				body.on !== false,
			);
			return { ok: true };
		case "saveType":
			await saveType(policy, identity, body);
			return { ok: true };
		case "removeType":
			await removeType(policy, identity, String(body.typeId ?? ""));
			return { ok: true };
		case "saveAlias":
			await saveAlias(policy, identity, body);
			return { ok: true };
		case "removeAlias":
			await removeAlias(policy, identity, String(body.alias ?? ""));
			return { ok: true };
		case "saveTemplate":
			await saveTemplate(policy, identity, body);
			return { ok: true };
		default:
			throw new UpdateError("Unknown action.");
	}
}
