import { NextRequest, NextResponse } from "next/server";
import { createItem, listItems, type ListFilter } from "@/lib/work/store";
import { similarItems } from "@/lib/work/activity";
import { loadConfig } from "@/lib/work/access";
import { giversForThread } from "@/lib/feedback/store";
import { listThreads } from "@/lib/messages/store";
import { privateJson, readJson } from "../notifications/guard";
import { failed, workCaller } from "./shared";

// The work queue. See lib/work.
//
// GET: requests this caller can see, narrowed by any of status, q, assignee,
// requester ("me" for oneself), workType, priority, domain, layer, tag, source,
// release, blocked, archive (archived or all, active when left out) and limit,
// with the queue's
// configuration and what the caller may do.
// GET ?similar=1&title=&description=&sources=a,b: open requests that read alike.
// POST: a new request, { title, description, workType, priority, effort, layer,
// domain, target, tags, visibility, parentKey, links, criteria, requesters,
// origin, reference }. The same reference answers with the same request, so an
// automation can retry safely.
export async function GET(request: NextRequest) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	const params = request.nextUrl.searchParams;
	try {
		if (params.get("similar") !== null) {
			return privateJson({
				similar: await similarItems(who.actor, {
					title: params.get("title") ?? "",
					description: params.get("description") ?? "",
					sources: (params.get("sources") ?? "")
						.split(",")
						.filter(Boolean),
				}),
			});
		}
		const text = (name: string) => params.get(name) || undefined;
		const filter: ListFilter = {
			statuses: text("status")?.split(","),
			search: text("q"),
			assignee:
				params.get("assignee") === "me"
					? who.actor.email
					: text("assignee"),
			requester:
				params.get("requester") === "me"
					? who.actor.email
					: text("requester"),
			workType: text("workType"),
			priority: text("priority"),
			domain: text("domain"),
			layer: text("layer"),
			tag: text("tag"),
			source: text("source"),
			release: text("release"),
			blocked:
				params.get("blocked") === null
					? undefined
					: params.get("blocked") === "true",
			archive:
				params.get("archive") === "archived"
					? "archived"
					: params.get("archive") === "all"
						? "all"
						: "active",
			limit: Number(params.get("limit")) || undefined,
		};
		const [items, config] = await Promise.all([
			listItems(who.actor, filter),
			loadConfig(),
		]);
		return privateJson({
			items,
			config,
			may: {
				request: who.actor.mayRequest,
				engineer: who.actor.engineer,
				devSecOps: who.actor.devSecOps,
			},
			me: who.actor.email,
		});
	} catch (error) {
		return failed(error);
	}
}

export async function POST(request: NextRequest) {
	const who = await workCaller(request);
	if (who instanceof NextResponse) return who;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	const text = (name: string) =>
		typeof body[name] === "string" ? (body[name] as string) : null;
	const list = (name: string) =>
		Array.isArray(body[name]) ? (body[name] as never[]) : [];
	try {
		const origin =
			body.origin && typeof body.origin === "object"
				? (body.origin as Record<string, unknown>)
				: { kind: "form" };
		// A request made from a conversation about reader feedback asks on
		// behalf of the people who gave it. Only somebody in that conversation
		// can bring them over.
		const requesters = (list("requesters") as unknown[])
			.filter((r): r is string => typeof r === "string")
			.filter((r) => r.toLowerCase() !== "assistant");
		if (
			origin.kind === "thread" &&
			typeof origin.threadId === "string" &&
			/^[0-9a-f-]{36}$/i.test(origin.threadId)
		) {
			const threadId = origin.threadId;
			const member = (
				await listThreads(
					who.identity.email,
					who.policy.grants,
					threadId,
				)
			).some((thread) => thread.id === threadId);
			if (member) requesters.push(...(await giversForThread(threadId)));
		}
		const created = await createItem(who.actor, {
			title: text("title") ?? "",
			description: text("description") ?? "",
			workType: text("workType"),
			priority: text("priority"),
			effort: text("effort"),
			layer: text("layer"),
			domain: text("domain"),
			target: text("target"),
			tags: list("tags"),
			visibility:
				body.visibility === "restricted" ? "restricted" : "normal",
			parentKey: text("parentKey"),
			links: list("links"),
			criteria: list("criteria"),
			requesters,
			origin,
			reference: text("reference")?.slice(0, 200) ?? null,
			status: text("status"),
			releaseId: text("releaseId"),
			asRequest: body.asRequest === true,
			assignees: Array.isArray(body.assignees)
				? (body.assignees as unknown[]).filter(
						(a): a is string => typeof a === "string",
					)
				: null,
		});
		return privateJson({ item: created }, 201);
	} catch (error) {
		return failed(error);
	}
}
