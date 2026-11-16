import { sql } from "../data/lakebase";
import { notify, safeLink } from "../notify/store";
import { WorkError, loadConfig, type WorkActor } from "./access";
import { duplicateAt, formatKey, likeness } from "./model";
import {
	listItems,
	recordEvent,
	rowByKey,
	tellAbout,
	visibleRow,
	type WorkSummary,
} from "./store";

// Everything around a request besides its fields: the discussion, what it is
// linked to, its acceptance criteria, who else wants it and who watches it, and
// finding requests that already ask for the same thing.

const mentionPattern = /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

export function mentionsIn(body: string): string[] {
	return [
		...new Set(
			[...body.matchAll(mentionPattern)].map((m) => m[1].toLowerCase()),
		),
	];
}

async function keyOf(number: string): Promise<string> {
	const config = await loadConfig();
	return formatKey(config.prefix, Number(number));
}

// --- Discussion --------------------------------------------------------------

export async function addComment(
	actor: WorkActor,
	key: string,
	body: string,
	replyTo: string | null,
): Promise<string> {
	const { row, requesters } = await visibleRow(actor, key);
	const text = body.trim().slice(0, 20_000);
	if (!text) throw new WorkError("Write something first.");
	const rows = await sql<{ comment_id: string }>(
		`INSERT INTO work_comments (item_id, reply_to, author, body)
		 VALUES ($1, $2::uuid, $3, $4) RETURNING comment_id::text`,
		[row.item_id, replyTo, actor.email, text],
	);
	await sql(`UPDATE work_items SET modified_on = now() WHERE item_id = $1`, [
		row.item_id,
	]);
	// Writing on a request means wanting to hear what follows.
	await sql(
		`INSERT INTO work_watchers (item_id, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		[row.item_id, actor.email],
	);
	const workKey = await keyOf(row.number);
	// Somebody mentioned is told, and on a restricted request only when they
	// already belong to it.
	const mentioned = mentionsIn(text).filter(
		(person) =>
			row.visibility !== "restricted" ||
			requesters.includes(person) ||
			(row.assignees ?? []).includes(person),
	);
	for (const person of mentioned) {
		if (person === actor.email) continue;
		await notify(person, {
			kind: "system",
			title: `${workKey}: ${actor.name} mentioned you`,
			body: text.slice(0, 300),
			link: safeLink(`/work/${workKey}`),
			data: { workKey },
		}).catch(() => {});
	}
	await tellAbout(
		row.item_id,
		workKey,
		actor.email,
		`${actor.name} commented`,
		text,
	);
	return rows[0].comment_id;
}

export async function editComment(
	actor: WorkActor,
	key: string,
	commentId: string,
	body: string | null,
): Promise<void> {
	const { row } = await visibleRow(actor, key);
	const rows = await sql<{ author: string; body: string }>(
		`SELECT author, body FROM work_comments WHERE comment_id::text = $1 AND item_id = $2`,
		[commentId, row.item_id],
	);
	const comment = rows[0];
	if (!comment) throw new WorkError("Not found", 404);
	// Removing is open to the author and the engineers. Editing is the author's.
	if (comment.author !== actor.email && !(body === null && actor.engineer)) {
		throw new WorkError("Only its author changes a comment.", 403);
	}
	if (body === null) {
		await sql(
			`UPDATE work_comments SET removed_on = now() WHERE comment_id::text = $1`,
			[commentId],
		);
		await recordEvent(row.item_id, actor.email, "commentRemoved", {
			commentId,
			before: comment.body,
		});
		return;
	}
	const text = body.trim().slice(0, 20_000);
	if (!text || text === comment.body) return;
	await sql(
		`UPDATE work_comments SET body = $2, edited_on = now() WHERE comment_id::text = $1`,
		[commentId, text],
	);
	// The earlier wording is kept, so an edit can be compared with what it
	// replaced.
	await recordEvent(row.item_id, actor.email, "commentEdited", {
		commentId,
		before: comment.body,
		after: text,
	});
}

export async function react(
	actor: WorkActor,
	key: string,
	commentId: string,
	reaction: string,
): Promise<void> {
	const { row } = await visibleRow(actor, key);
	const allowed = ["+1", "-1", "heart", "eyes", "tada", "confused"];
	if (!allowed.includes(reaction)) throw new WorkError("Not a reaction.");
	// Adds the person to the reaction, or takes them off it if already there.
	await sql(
		`UPDATE work_comments
		 SET reactions = CASE
		   WHEN reactions ? $3 AND reactions->$3 ? $4
		     THEN jsonb_set(reactions, ARRAY[$3], (reactions->$3) - $4)
		   ELSE jsonb_set(reactions, ARRAY[$3], coalesce(reactions->$3, '[]'::jsonb) || to_jsonb($4::text))
		 END
		 WHERE comment_id::text = $1 AND item_id = $2`,
		[commentId, row.item_id, reaction, actor.email],
	);
}

// --- Links -------------------------------------------------------------------

const linkKinds = [
	"source",
	"field",
	"report",
	"page",
	"visual",
	"url",
	"dependsOn",
	"update",
] as const;

export async function addLink(
	actor: WorkActor,
	key: string,
	link: {
		kind: string;
		target: string;
		detail?: string | null;
		label?: string | null;
	},
): Promise<void> {
	const { row, requesters } = await visibleRow(actor, key);
	const own =
		row.created_by === actor.email || requesters.includes(actor.email);
	if (
		!actor.engineer &&
		!(own && ["new", "needsInfo"].includes(row.status))
	) {
		throw new WorkError("Only the engineers link this.", 403);
	}
	if (!(linkKinds as readonly string[]).includes(link.kind))
		throw new WorkError("Not something a request links to.");
	let target = String(link.target ?? "")
		.trim()
		.slice(0, 500);
	if (!target) throw new WorkError("Say what to link.");
	let label = link.label ?? null;
	if (link.kind === "url" && !/^https?:\/\//i.test(target)) {
		throw new WorkError("A link is an address starting with http.");
	}
	if (link.kind === "dependsOn") {
		const other = await rowByKey(target);
		if (!other || other.item_id === row.item_id)
			throw new WorkError("That request does not exist.");
		target = other.item_id;
		label = other.title;
	}
	if (link.kind === "update") {
		const update = await sql<{ title: string }>(
			`SELECT title FROM updates WHERE update_id::text = $1`,
			[target],
		);
		if (!update[0]) throw new WorkError("That update does not exist.");
		label = update[0].title;
	}
	const detail =
		link.kind === "update"
			? link.detail === "resolves"
				? "resolves"
				: "relates"
			: (link.detail ?? null);
	const added = await sql(
		`INSERT INTO work_links (item_id, kind, target, detail, label, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (item_id, kind, target) DO UPDATE SET detail = EXCLUDED.detail
		 RETURNING link_id`,
		[row.item_id, link.kind, target, detail, label, actor.email],
	);
	if (added.length === 0) return;
	await recordEvent(row.item_id, actor.email, "linked", {
		kind: link.kind,
		target,
		detail,
		label,
	});
	await sql(`UPDATE work_items SET modified_on = now() WHERE item_id = $1`, [
		row.item_id,
	]);
}

export async function removeLink(
	actor: WorkActor,
	key: string,
	linkId: string,
): Promise<void> {
	const { row } = await visibleRow(actor, key);
	if (!actor.engineer)
		throw new WorkError("Only the engineers unlink this.", 403);
	const removed = await sql<{
		kind: string;
		target: string;
		label: string | null;
	}>(
		`DELETE FROM work_links WHERE link_id::text = $1 AND item_id = $2 RETURNING kind, target, label`,
		[linkId, row.item_id],
	);
	if (removed[0])
		await recordEvent(row.item_id, actor.email, "unlinked", removed[0]);
}

// --- Acceptance criteria -----------------------------------------------------

export async function changeCriteria(
	actor: WorkActor,
	key: string,
	change:
		| { add: string }
		| { criterionId: string; done: boolean }
		| { criterionId: string; remove: true },
): Promise<void> {
	const { row, requesters } = await visibleRow(actor, key);
	const own =
		row.created_by === actor.email || requesters.includes(actor.email);
	if ("add" in change) {
		if (
			!actor.engineer &&
			!(own && ["new", "needsInfo"].includes(row.status))
		) {
			throw new WorkError("Only the engineers add criteria now.", 403);
		}
		const text = change.add.trim().slice(0, 500);
		if (!text) return;
		await sql(
			`INSERT INTO work_criteria (item_id, body, position)
			 VALUES ($1, $2, (SELECT coalesce(max(position), -1) + 1 FROM work_criteria WHERE item_id = $1))`,
			[row.item_id, text],
		);
		await recordEvent(row.item_id, actor.email, "criterionAdded", {
			body: text,
		});
		return;
	}
	const rows = await sql<{ body: string }>(
		`SELECT body FROM work_criteria WHERE criterion_id::text = $1 AND item_id = $2`,
		[change.criterionId, row.item_id],
	);
	if (!rows[0]) throw new WorkError("Not found", 404);
	if ("remove" in change) {
		if (!actor.engineer)
			throw new WorkError("Only the engineers remove criteria.", 403);
		await sql(`DELETE FROM work_criteria WHERE criterion_id::text = $1`, [
			change.criterionId,
		]);
		await recordEvent(row.item_id, actor.email, "criterionRemoved", {
			body: rows[0].body,
		});
		return;
	}
	// Ticked in Validating, by the engineers or by the people who asked.
	if (!actor.engineer && !own)
		throw new WorkError(
			"Only the engineers and the people who asked tick these.",
			403,
		);
	await sql(
		`UPDATE work_criteria SET done_by = $2, done_on = CASE WHEN $3 THEN now() END
		 WHERE criterion_id::text = $1`,
		[change.criterionId, change.done ? actor.email : null, change.done],
	);
	await recordEvent(
		row.item_id,
		actor.email,
		change.done ? "criterionDone" : "criterionUndone",
		{ body: rows[0].body },
	);
}

// --- Me too, watching --------------------------------------------------------

export async function setMeToo(
	actor: WorkActor,
	key: string,
	on: boolean,
): Promise<void> {
	const { row } = await visibleRow(actor, key);
	if (row.created_by === actor.email && !on) {
		throw new WorkError("You asked for this, so you stay on it.");
	}
	const changed = on
		? await sql(
				`INSERT INTO work_requesters (item_id, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING item_id`,
				[row.item_id, actor.email],
			)
		: await sql(
				`DELETE FROM work_requesters WHERE item_id = $1 AND user_email = $2 RETURNING item_id`,
				[row.item_id, actor.email],
			);
	if (changed.length > 0) {
		await recordEvent(
			row.item_id,
			actor.email,
			on ? "meToo" : "meTooRemoved",
		);
	}
}

export async function setWatching(
	actor: WorkActor,
	key: string,
	on: boolean,
): Promise<void> {
	const { row } = await visibleRow(actor, key);
	await sql(
		`INSERT INTO work_watchers (item_id, user_email, watching) VALUES ($1, $2, $3)
		 ON CONFLICT (item_id, user_email) DO UPDATE SET watching = $3`,
		[row.item_id, actor.email, on],
	);
}

// --- Finding duplicates ------------------------------------------------------

// Open requests this person can see that read like the one being written,
// most alike first.
export async function similarItems(
	actor: WorkActor,
	draft: { title: string; description: string; sources: string[] },
	excludeId?: string,
): Promise<(WorkSummary & { likeness: number })[]> {
	if (!draft.title.trim() && !draft.description.trim()) return [];
	const open = await listItems(actor, { limit: 2000 });
	const descriptions = new Map(
		(
			await sql<{ item_id: string; description: string }>(
				`SELECT item_id::text, left(description, 4000) AS description FROM work_items
				 WHERE closed_as IS NULL AND item_id::text = ANY($1::text[])`,
				[open.map((item) => item.id)],
			)
		).map((row) => [row.item_id, row.description]),
	);
	return open
		.filter((item) => item.id !== excludeId)
		.map((item) => ({
			...item,
			likeness: likeness(draft, {
				title: item.title,
				description: descriptions.get(item.id) ?? "",
				sources: item.sources,
			}),
		}))
		.filter((item) => item.likeness >= duplicateAt)
		.sort((a, b) => b.likeness - a.likeness)
		.slice(0, 5);
}
