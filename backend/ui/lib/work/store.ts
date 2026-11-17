import type { PoolClient } from "pg";
import { sql, transaction } from "../data/lakebase";
import { notify, safeLink } from "../notify/store";
import { dropPastedWith } from "./attachments";
import {
	canSee,
	loadConfig,
	visibleParams,
	visibleSql,
	WorkError,
	type WorkActor,
} from "./access";
import {
	changesBetween,
	formatKey,
	numberOfKey,
	ownersFor,
	refuseMove,
	type ArchiveScope,
	type FieldChange,
	type TrackedField,
	type WorkConfig,
} from "./model";

// Requests in the work queue: making them, reading them, and every change to
// them, each recorded on the request's timeline as who did what from what to
// what. See lib/work/model for the rules and lib/work/access for who sees what.

interface Row {
	item_id: string;
	number: string;
	title: string;
	description: string;
	status: string;
	closed_as: string | null;
	closed_reason: string | null;
	duplicate_of: string | null;
	work_type: string | null;
	priority: string | null;
	effort: string | null;
	layer: string | null;
	domain: string | null;
	target_on: string | null;
	release_id: string | null;
	blocked: boolean;
	blocked_reason: string | null;
	assignees: string[];
	reviewer: string | null;
	approver: string | null;
	approved_by: string | null;
	approved_on: string | null;
	security_reviewed_by: string | null;
	security_reviewed_on: string | null;
	tags: string[];
	visibility: string;
	parent_id: string | null;
	origin: Record<string, unknown>;
	reference: string | null;
	created_by: string;
	created_on: string;
	modified_on: string;
	status_since: string;
	started_on: string | null;
	closed_on: string | null;
}

const columns = `w.item_id::text, w.number::text, w.title, w.description, w.status,
	w.closed_as, w.closed_reason, w.duplicate_of::text, w.work_type, w.priority,
	w.effort, w.layer, w.domain, w.target_on::text, w.release_id::text, w.blocked,
	w.blocked_reason, w.assignees, w.reviewer, w.approver, w.approved_by,
	w.approved_on::text, w.security_reviewed_by, w.security_reviewed_on::text,
	w.tags, w.visibility, w.parent_id::text, w.origin, w.reference, w.created_by,
	w.created_on::text, w.modified_on::text, w.status_since::text,
	w.started_on::text, w.closed_on::text`;

export interface WorkSummary {
	id: string;
	key: string;
	number: number;
	title: string;
	status: string;
	closedAs: string | null;
	workType: string | null;
	priority: string | null;
	effort: string | null;
	layer: string | null;
	domain: string | null;
	target: string | null;
	releaseId: string | null;
	blocked: boolean;
	blockedReason: string | null;
	assignees: string[];
	reviewer: string | null;
	approver: string | null;
	tags: string[];
	visibility: string;
	parentId: string | null;
	createdBy: string;
	createdOn: string;
	modifiedOn: string;
	statusSince: string;
	startedOn: string | null;
	closedOn: string | null;
	requesters: number;
	sources: string[];
	children: { total: number; done: number };
}

function toSummary(
	row: Row,
	prefix: string,
	extra: {
		requesters: number;
		sources: string[];
		children: { total: number; done: number };
	},
): WorkSummary {
	return {
		id: row.item_id,
		key: formatKey(prefix, Number(row.number)),
		number: Number(row.number),
		title: row.title,
		status: row.status,
		closedAs: row.closed_as,
		workType: row.work_type,
		priority: row.priority,
		effort: row.effort,
		layer: row.layer,
		domain: row.domain,
		target: row.target_on,
		releaseId: row.release_id,
		blocked: row.blocked,
		blockedReason: row.blocked_reason,
		assignees: row.assignees ?? [],
		reviewer: row.reviewer,
		approver: row.approver,
		tags: row.tags ?? [],
		visibility: row.visibility,
		parentId: row.parent_id,
		createdBy: row.created_by,
		createdOn: row.created_on,
		modifiedOn: row.modified_on,
		statusSince: row.status_since,
		startedOn: row.started_on,
		closedOn: row.closed_on,
		...extra,
	};
}

// --- Finding one -------------------------------------------------------------

export async function rowByKey(key: string): Promise<Row | null> {
	const number = numberOfKey(key);
	const byId = /^[0-9a-f-]{36}$/i.test(key);
	if (number === null && !byId) return null;
	const rows = await sql<Row>(
		`SELECT ${columns} FROM work_items w
		 WHERE ${byId ? "w.item_id::text = $1" : "w.number = $1"}`,
		[byId ? key : number],
	);
	return rows[0] ?? null;
}

async function peopleOf(itemId: string) {
	const [requesters, watchers, sources] = await Promise.all([
		sql<{ user_email: string }>(
			`SELECT user_email FROM work_requesters WHERE item_id = $1 ORDER BY added_on`,
			[itemId],
		),
		sql<{ user_email: string }>(
			`SELECT user_email FROM work_watchers WHERE item_id = $1 AND watching`,
			[itemId],
		),
		sql<{ target: string }>(
			`SELECT target FROM work_links WHERE item_id = $1 AND kind = 'source'`,
			[itemId],
		),
	]);
	return {
		requesters: requesters.map((r) => r.user_email),
		watchers: watchers.map((r) => r.user_email),
		sources: sources.map((r) => r.target),
	};
}

// A request this person may see, or a not-found error, so a key is no way of
// learning that a restricted one exists.
export async function visibleRow(
	actor: WorkActor,
	key: string,
): Promise<{
	row: Row;
	requesters: string[];
	watchers: string[];
	sources: string[];
}> {
	const row = await rowByKey(key);
	if (!row) throw new WorkError("Not found", 404);
	const people = await peopleOf(row.item_id);
	const seen = canSee(actor, {
		visibility: row.visibility,
		createdBy: row.created_by,
		requesters: people.requesters,
		watchers: people.watchers,
		assignees: row.assignees ?? [],
		sources: people.sources,
	});
	if (!seen) throw new WorkError("Not found", 404);
	return { row, ...people };
}

// --- Recording ---------------------------------------------------------------

export async function recordEvent(
	itemId: string,
	actor: string,
	kind: string,
	data: Record<string, unknown> = {},
	client?: PoolClient,
): Promise<void> {
	const text = `INSERT INTO work_events (item_id, actor, kind, data) VALUES ($1, $2, $3, $4::jsonb)`;
	const params = [itemId, actor, kind, JSON.stringify(data)];
	if (client) await client.query(text, params);
	else await sql(text, params);
}

// Tells the people around a request about something that happened to it, except
// whoever did it.
export async function tellAbout(
	itemId: string,
	key: string,
	// Whoever did it, and anybody already told about it more directly.
	except: string | string[],
	title: string,
	body: string,
	extra: string[] = [],
): Promise<void> {
	const rows = await sql<{ email: string }>(
		`SELECT user_email AS email FROM work_requesters WHERE item_id = $1
		 UNION SELECT user_email FROM work_watchers WHERE item_id = $1 AND watching
		 UNION SELECT unnest(assignees) FROM work_items WHERE item_id = $1
		 UNION SELECT reviewer FROM work_items WHERE item_id = $1 AND reviewer IS NOT NULL`,
		[itemId],
	);
	const people = new Set([
		...rows.map((r) => r.email.toLowerCase()),
		...extra.map((e) => e.toLowerCase()),
	]);
	for (const person of Array.isArray(except) ? except : [except])
		people.delete(person.toLowerCase());
	people.delete("assistant");
	for (const person of people) {
		await notify(person, {
			kind: "system",
			title: `${key}: ${title}`,
			body: body.slice(0, 300),
			link: safeLink(`/work/${key}`),
			data: { workKey: key },
		}).catch(() => {});
	}
}

// --- Making one --------------------------------------------------------------

export interface NewItem {
	title: string;
	description?: string;
	workType?: string | null;
	priority?: string | null;
	effort?: string | null;
	layer?: string | null;
	domain?: string | null;
	target?: string | null;
	tags?: string[];
	visibility?: "normal" | "restricted";
	parentKey?: string | null;
	links?: {
		kind: string;
		target: string;
		detail?: string | null;
		label?: string | null;
	}[];
	criteria?: string[];
	// Who else asked for it, such as everyone who gave the feedback it came from.
	requesters?: string[];
	origin?: Record<string, unknown>;
	reference?: string | null;
	// The column it starts in and who works it. Honoured only for an engineer,
	// who makes items directly rather than asking for them.
	status?: string | null;
	assignees?: string[] | null;
	// The release it joins, whose date becomes its target.
	releaseId?: string | null;
	// Asked for rather than made, even by an engineer.
	asRequest?: boolean;
}

function oneOf(value: unknown, list: { id: string }[]): string | null {
	return typeof value === "string" && list.some((item) => item.id === value)
		? value
		: null;
}

function cleanDate(value: unknown): string | null {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
		? value
		: null;
}

function cleanTags(value: unknown): string[] {
	return Array.isArray(value)
		? [
				...new Set(
					value
						.filter((t): t is string => typeof t === "string")
						.map((t) => t.trim().slice(0, 40))
						.filter(Boolean),
				),
			].slice(0, 20)
		: [];
}

const linkKinds = new Set([
	"source",
	"field",
	"report",
	"page",
	"visual",
	"url",
	"dependsOn",
	"update",
]);

export async function createItem(
	actor: WorkActor,
	input: NewItem,
): Promise<WorkSummary> {
	if (!actor.mayRequest && !actor.engineer) {
		throw new WorkError("You cannot ask for work.", 403);
	}
	// An engineer makes the item directly unless they are asking for it, as
	// anybody else would.
	const maker = actor.engineer && !input.asRequest;
	const title = (input.title ?? "").trim().slice(0, 200);
	if (!title) throw new WorkError("Give it a title.");
	const config = await loadConfig();

	// A retry of a create with the same reference answers with what it made.
	if (input.reference) {
		const existing = await sql<{ number: string }>(
			`SELECT number::text FROM work_items WHERE reference = $1`,
			[input.reference],
		);
		if (existing[0]) {
			return (
				await listItems(actor, {
					keys: [
						formatKey(config.prefix, Number(existing[0].number)),
					],
				})
			)[0];
		}
	}

	const parent = input.parentKey ? await rowByKey(input.parentKey) : null;
	const domain = oneOf(input.domain, config.domains);
	const layer = oneOf(input.layer, config.layers);
	const chosenAssignees =
		maker && Array.isArray(input.assignees)
			? [
					...new Set(
						input.assignees
							.filter((a): a is string => typeof a === "string")
							.map((a) => a.trim().toLowerCase())
							.filter((a) => a.includes("@")),
					),
				].slice(0, 20)
			: null;
	// Owners of its domain or layer are assigned only when nobody was chosen.
	const ownerAssigned = !chosenAssignees || chosenAssignees.length === 0;
	const assignees = ownerAssigned
		? ownersFor(config, domain, layer).map((owner) => owner.toLowerCase())
		: chosenAssignees;
	const status =
		(maker && oneOf(input.status, config.columns)) ||
		(config.columns[0]?.id ?? "new");

	const itemId = await transaction(async (client) => {
		const inserted = await client.query<{ item_id: string }>(
			`INSERT INTO work_items
			   (title, description, work_type, priority, effort, layer, domain,
			    target_on, tags, visibility, parent_id, origin, reference,
			    assignees, created_by, status)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12::jsonb,
			         $13, $14, $15, $16)
			 RETURNING item_id::text`,
			[
				title,
				(input.description ?? "").slice(0, 50_000),
				oneOf(input.workType, config.workTypes),
				oneOf(input.priority, config.priorities),
				oneOf(input.effort, config.efforts),
				layer,
				domain,
				cleanDate(input.target),
				cleanTags(input.tags),
				input.visibility === "restricted" ? "restricted" : "normal",
				parent?.item_id ?? null,
				JSON.stringify(input.origin ?? { kind: "form" }),
				input.reference ?? null,
				assignees,
				actor.email,
				status,
			],
		);
		const id = inserted.rows[0].item_id;
		if (maker && input.releaseId) {
			const joined = await client.query(
				`UPDATE work_items w
				 SET release_id = r.release_id,
				     target_on = coalesce(r.target_on, w.target_on)
				 FROM work_releases r
				 WHERE w.item_id = $1 AND r.release_id::text = $2
				   AND r.shipped_on IS NULL`,
				[id, input.releaseId],
			);
			if (joined.rowCount === 0) {
				throw new WorkError("That release does not exist or is out.");
			}
		}
		// An engineer making an item is not asking for it. Anybody they name
		// as asking still is.
		const askers = new Set([
			...(maker ? [] : [actor.email]),
			...(input.requesters ?? []).map((r) => r.toLowerCase()),
		]);
		askers.delete("assistant");
		for (const email of askers) {
			await client.query(
				`INSERT INTO work_requesters (item_id, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
				[id, email],
			);
		}
		for (const link of input.links ?? []) {
			if (!linkKinds.has(link.kind) || !link.target) continue;
			await client.query(
				`INSERT INTO work_links (item_id, kind, target, detail, label, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
				[
					id,
					link.kind,
					String(link.target).slice(0, 500),
					link.detail ?? null,
					link.label ?? null,
					actor.email,
				],
			);
		}
		let position = 0;
		for (const body of (input.criteria ?? []).slice(0, 30)) {
			const text = String(body).trim().slice(0, 500);
			if (!text) continue;
			await client.query(
				`INSERT INTO work_criteria (item_id, body, position) VALUES ($1, $2, $3)`,
				[id, text, position++],
			);
		}
		await recordEvent(
			id,
			actor.email,
			"created",
			{ origin: input.origin ?? { kind: "form" } },
			client,
		);
		if (ownerAssigned && assignees.length > 0) {
			await recordEvent(
				id,
				"Assistant",
				"changed",
				{
					field: "assignees",
					from: [],
					to: assignees,
					why: "the owners of its domain or layer",
				},
				client,
			);
		}
		return id;
	});

	const [summary] = await listItems(actor, { ids: [itemId] });
	// Nobody is told about an item they assigned to themselves.
	const told = assignees.filter((a) => a !== actor.email);
	if (told.length > 0) {
		await tellAbout(
			itemId,
			summary.key,
			actor.email,
			`assigned to you: ${title}`,
			ownerAssigned
				? "A new request in your domain."
				: `${actor.name} assigned it to you.`,
			told,
		);
	}
	return summary;
}

// --- Lists -------------------------------------------------------------------

export interface ListFilter {
	ids?: string[];
	keys?: string[];
	statuses?: string[];
	includeClosed?: boolean;
	onlyClosed?: boolean;
	// Set by the board and its lists. Takes the place of the two above.
	archive?: ArchiveScope;
	search?: string;
	assignee?: string;
	requester?: string;
	workType?: string;
	priority?: string;
	domain?: string;
	layer?: string;
	tag?: string;
	source?: string;
	release?: string;
	blocked?: boolean;
	parent?: string;
	// Everything under a request, at any depth.
	under?: string;
	limit?: number;
}

export async function listItems(
	actor: WorkActor,
	filter: ListFilter = {},
): Promise<WorkSummary[]> {
	const config = await loadConfig();
	const params: unknown[] = visibleParams(actor);
	const where: string[] = [visibleSql(1)];
	const add = (condition: (n: string) => string, value: unknown) => {
		params.push(value);
		where.push(condition(`$${params.length}`));
	};
	if (filter.ids?.length)
		add((n) => `w.item_id::text = ANY(${n}::text[])`, filter.ids);
	if (filter.keys?.length) {
		add(
			(n) => `w.number = ANY(${n}::bigint[])`,
			filter.keys.map(numberOfKey).filter((n) => n !== null),
		);
	}
	if (filter.archive === "active" || filter.archive === "archived") {
		// Worked out when read, so a request leaves the board on time without
		// anything scheduled to move it.
		params.push(config.rules.archiveDoneAfterDays);
		const days = `$${params.length}::int`;
		const archived = `(w.closed_as IS NOT NULL OR (w.status = 'done' AND ${days} IS NOT NULL AND w.status_since < now() - make_interval(days => ${days})))`;
		where.push(filter.archive === "active" ? `NOT ${archived}` : archived);
	} else if (filter.archive === "all") {
		// Every request, archived or not.
	} else if (filter.onlyClosed) where.push("w.closed_as IS NOT NULL");
	else if (!filter.includeClosed && !filter.ids && !filter.keys)
		where.push("w.closed_as IS NULL");
	if (filter.statuses?.length)
		add((n) => `w.status = ANY(${n}::text[])`, filter.statuses);
	if (filter.assignee)
		add((n) => `${n} = ANY(w.assignees)`, filter.assignee.toLowerCase());
	if (filter.requester) {
		add(
			(n) =>
				`EXISTS (SELECT 1 FROM work_requesters r WHERE r.item_id = w.item_id AND r.user_email = ${n})`,
			filter.requester.toLowerCase(),
		);
	}
	if (filter.workType) add((n) => `w.work_type = ${n}`, filter.workType);
	if (filter.priority) add((n) => `w.priority = ${n}`, filter.priority);
	if (filter.domain) add((n) => `w.domain = ${n}`, filter.domain);
	if (filter.layer) add((n) => `w.layer = ${n}`, filter.layer);
	if (filter.tag) add((n) => `${n} = ANY(w.tags)`, filter.tag);
	if (filter.release) add((n) => `w.release_id::text = ${n}`, filter.release);
	if (filter.parent) add((n) => `w.parent_id::text = ${n}`, filter.parent);
	if (filter.under) {
		// UNION rather than UNION ALL, so a loop left in older data ends.
		add(
			(n) => `w.item_id IN (
			  WITH RECURSIVE d AS (
			    SELECT item_id FROM work_items WHERE parent_id::text = ${n}
			    UNION
			    SELECT c.item_id FROM work_items c JOIN d ON c.parent_id = d.item_id)
			  SELECT item_id FROM d)`,
			filter.under,
		);
	}
	if (filter.blocked !== undefined)
		add((n) => `w.blocked = ${n}`, filter.blocked);
	if (filter.source) {
		add(
			(n) =>
				`EXISTS (SELECT 1 FROM work_links l WHERE l.item_id = w.item_id AND l.kind = 'source' AND l.target = ${n})`,
			filter.source,
		);
	}
	if (filter.search?.trim()) {
		const term = filter.search.trim();
		const number =
			numberOfKey(term) ?? (/^\d+$/.test(term) ? Number(term) : null);
		params.push(`%${term.replace(/[%_]/g, (c) => `\\${c}`)}%`);
		const like = `$${params.length}`;
		if (number !== null) {
			params.push(number);
			where.push(
				`(w.number = $${params.length} OR w.title ILIKE ${like} OR w.description ILIKE ${like})`,
			);
		} else {
			where.push(
				`(w.title ILIKE ${like} OR w.description ILIKE ${like}
				  OR EXISTS (SELECT 1 FROM unnest(w.tags) AS tag WHERE tag ILIKE ${like}))`,
			);
		}
	}
	params.push(Math.min(Math.max(filter.limit ?? 500, 1), 2000));
	const rows = await sql<
		Row & {
			requester_count: number;
			sources: string[];
			child_total: number;
			child_done: number;
		}
	>(
		`SELECT ${columns},
		        (SELECT count(*)::int FROM work_requesters r WHERE r.item_id = w.item_id) AS requester_count,
		        coalesce((SELECT array_agg(l.target) FROM work_links l WHERE l.item_id = w.item_id AND l.kind = 'source'), '{}') AS sources,
		        (WITH RECURSIVE d AS (
		              SELECT c.item_id, c.status, c.closed_as FROM work_items c WHERE c.parent_id = w.item_id
		              UNION
		              SELECT c.item_id, c.status, c.closed_as FROM work_items c JOIN d ON c.parent_id = d.item_id)
		         SELECT count(*)::int FROM d) AS child_total,
		        (WITH RECURSIVE d AS (
		              SELECT c.item_id, c.status, c.closed_as FROM work_items c WHERE c.parent_id = w.item_id
		              UNION
		              SELECT c.item_id, c.status, c.closed_as FROM work_items c JOIN d ON c.parent_id = d.item_id)
		         SELECT count(*)::int FROM d WHERE d.status = 'done' OR d.closed_as IS NOT NULL) AS child_done
		 FROM work_items w
		 WHERE ${where.join(" AND ")}
		 ORDER BY w.modified_on DESC
		 LIMIT $${params.length}`,
		params,
	);
	return rows.map((row) =>
		toSummary(row, config.prefix, {
			requesters: row.requester_count,
			sources: row.sources ?? [],
			children: { total: row.child_total, done: row.child_done },
		}),
	);
}

// --- One in full -------------------------------------------------------------

export interface TimelineEntry {
	type: "event" | "comment";
	id: string;
	actor: string;
	at: string;
	kind?: string;
	data?: Record<string, unknown>;
	body?: string;
	replyTo?: string | null;
	reactions?: Record<string, string[]>;
	editedOn?: string | null;
	removed?: boolean;
	// A top-level comment's thread.
	looking?: string[];
	resolvedBy?: string | null;
	resolvedOn?: string | null;
}

export async function getItem(actor: WorkActor, key: string) {
	const config = await loadConfig();
	const { row, requesters, watchers } = await visibleRow(actor, key);
	const [summary] = await listItems(actor, { ids: [row.item_id] });
	const [
		links,
		criteria,
		events,
		comments,
		attachments,
		children,
		dependents,
		release,
		parent,
		duplicateOf,
	] = await Promise.all([
		sql<{
			link_id: string;
			kind: string;
			target: string;
			detail: string | null;
			label: string | null;
			created_by: string;
			created_on: string;
		}>(
			`SELECT link_id::text, kind, target, detail, label, created_by, created_on::text
				 FROM work_links WHERE item_id = $1 ORDER BY created_on`,
			[row.item_id],
		),
		sql<{
			criterion_id: string;
			body: string;
			done_by: string | null;
			done_on: string | null;
		}>(
			`SELECT criterion_id::text, body, done_by, done_on::text FROM work_criteria
				 WHERE item_id = $1 ORDER BY position, criterion_id`,
			[row.item_id],
		),
		sql<{
			event_id: string;
			actor: string;
			kind: string;
			data: Record<string, unknown>;
			at: string;
		}>(
			`SELECT event_id::text, actor, kind, data, at::text FROM work_events
				 WHERE item_id = $1 ORDER BY at`,
			[row.item_id],
		),
		sql<{
			comment_id: string;
			reply_to: string | null;
			author: string;
			body: string;
			reactions: Record<string, string[]>;
			created_on: string;
			edited_on: string | null;
			removed_on: string | null;
			looking: string[];
			resolved_by: string | null;
			resolved_on: string | null;
		}>(
			`SELECT comment_id::text, reply_to::text, author, body, reactions,
				        created_on::text, edited_on::text, removed_on::text,
				        looking, resolved_by, resolved_on::text
				 FROM work_comments WHERE item_id = $1 ORDER BY created_on`,
			[row.item_id],
		),
		sql<{
			attachment_id: string;
			hash: string;
			file_name: string;
			content_type: string;
			size: number;
			width: number | null;
			height: number | null;
			uploaded_by: string;
			uploaded_on: string;
			pasted: boolean | null;
		}>(
			`SELECT attachment_id::text, hash, file_name, content_type, size, width,
				        height, uploaded_by, uploaded_on::text, pasted
				 FROM work_attachments WHERE item_id = $1 ORDER BY uploaded_on`,
			[row.item_id],
		),
		listItems(actor, { under: row.item_id, includeClosed: true }),
		sql<{ item_id: string }>(
			`SELECT item_id::text FROM work_links WHERE kind = 'dependsOn' AND target = $1`,
			[row.item_id],
		),
		row.release_id
			? sql<{
					release_id: string;
					name: string;
					target_on: string | null;
					shipped_on: string | null;
				}>(
					`SELECT release_id::text, name, target_on::text, shipped_on::text FROM work_releases WHERE release_id::text = $1`,
					[row.release_id],
				)
			: Promise.resolve([]),
		row.parent_id
			? listItems(actor, { ids: [row.parent_id], includeClosed: true })
			: Promise.resolve([]),
		row.duplicate_of
			? listItems(actor, { ids: [row.duplicate_of], includeClosed: true })
			: Promise.resolve([]),
	]);

	const dependsOnIds = links
		.filter((l) => l.kind === "dependsOn")
		.map((l) => l.target);
	const [dependsOn, blocks] = await Promise.all([
		dependsOnIds.length
			? listItems(actor, { ids: dependsOnIds, includeClosed: true })
			: Promise.resolve([]),
		dependents.length
			? listItems(actor, {
					ids: dependents.map((d) => d.item_id),
					includeClosed: true,
				})
			: Promise.resolve([]),
	]);

	const timeline: TimelineEntry[] = [
		...events.map((e) => ({
			type: "event" as const,
			id: e.event_id,
			actor: e.actor,
			at: e.at,
			kind: e.kind,
			data: e.data,
		})),
		...comments.map((c) => ({
			type: "comment" as const,
			id: c.comment_id,
			actor: c.author,
			at: c.created_on,
			body: c.removed_on ? "" : c.body,
			replyTo: c.reply_to,
			reactions: c.reactions ?? {},
			editedOn: c.edited_on,
			removed: Boolean(c.removed_on),
			looking: c.looking ?? [],
			resolvedBy: c.resolved_by,
			resolvedOn: c.resolved_on,
		})),
	].sort((a, b) => a.at.localeCompare(b.at));

	// A pasted file points at the comment or description that shows it. A file
	// from before pasted files were marked counts as pasted when the
	// discussion shows it.
	const liveComments = comments.filter((c) => !c.removed_on);
	const placedAttachments = attachments.map((a) => {
		const reference = `/api/work/files/${a.hash}`;
		const comment = liveComments.find((c) => c.body.includes(reference));
		const inDescription = row.description.includes(reference);
		const fromDiscussion =
			a.pasted === true ||
			(a.pasted === null && (Boolean(comment) || inDescription));
		return {
			...a,
			section: fromDiscussion
				? ("discussion" as const)
				: ("files" as const),
			foundIn: comment
				? {
						kind: "comment" as const,
						commentId: comment.comment_id,
						author: comment.author,
						at: comment.created_on,
					}
				: inDescription
					? { kind: "description" as const }
					: null,
		};
	});

	const own =
		row.created_by === actor.email || requesters.includes(actor.email);
	return {
		item: {
			...summary,
			description: row.description,
			closedReason: row.closed_reason,
			duplicateOf: duplicateOf[0]
				? { key: duplicateOf[0].key, title: duplicateOf[0].title }
				: null,
			approvedBy: row.approved_by,
			approvedOn: row.approved_on,
			securityReviewedBy: row.security_reviewed_by,
			securityReviewedOn: row.security_reviewed_on,
			origin: row.origin,
			reference: row.reference,
			release: release[0]
				? {
						id: release[0].release_id,
						name: release[0].name,
						target: release[0].target_on,
						shippedOn: release[0].shipped_on,
					}
				: null,
			parent: parent[0]
				? { key: parent[0].key, title: parent[0].title }
				: null,
		},
		requesters,
		watchers,
		watching: watchers.includes(actor.email),
		meToo: requesters.includes(actor.email),
		links: links.filter((l) => l.kind !== "dependsOn"),
		criteria,
		attachments: placedAttachments,
		children,
		// Each carries the link that made it, so the link can be removed.
		dependsOn: dependsOn.map((d) => ({
			...d,
			linkId:
				links.find((l) => l.kind === "dependsOn" && l.target === d.id)
					?.link_id ?? null,
		})),
		blocks,
		timeline,
		may: {
			engineer: actor.engineer,
			devSecOps: actor.devSecOps,
			// The person who asked edits what they asked while it is still new.
			editAsked:
				actor.engineer ||
				(own && ["new", "needsInfo"].includes(row.status)),
			markSensitive: actor.engineer || own,
		},
		config,
	};
}

// --- Changing fields ---------------------------------------------------------

export interface ItemPatch {
	title?: string;
	description?: string;
	workType?: string | null;
	priority?: string | null;
	effort?: string | null;
	layer?: string | null;
	domain?: string | null;
	target?: string | null;
	assignees?: string[];
	reviewer?: string | null;
	approver?: string | null;
	tags?: string[];
	visibility?: "normal" | "restricted";
	parentKey?: string | null;
	releaseId?: string | null;
}

// The fields somebody who asked may change while it is new or needs info.
const askerFields = new Set([
	"title",
	"description",
	"workType",
	"priority",
	"layer",
	"domain",
	"tags",
	"visibility",
]);

function emailList(value: unknown): string[] {
	return Array.isArray(value)
		? [
				...new Set(
					value
						.filter(
							(v): v is string =>
								typeof v === "string" &&
								/^[^@\s]+@[^@\s]+$/.test(v.trim()),
						)
						.map((v) => v.trim().toLowerCase()),
				),
			].slice(0, 20)
		: [];
}

function email(value: unknown): string | null {
	return typeof value === "string" && value.trim()
		? value.trim().toLowerCase()
		: null;
}

export async function updateItem(
	actor: WorkActor,
	key: string,
	patch: ItemPatch,
): Promise<void> {
	const config = await loadConfig();
	const { row, requesters } = await visibleRow(actor, key);
	const own =
		row.created_by === actor.email || requesters.includes(actor.email);
	const asked = Object.keys(patch).filter(
		(field) => (patch as Record<string, unknown>)[field] !== undefined,
	);
	if (!actor.engineer) {
		const stillNew = ["new", "needsInfo"].includes(row.status);
		const refused = asked.filter((field) =>
			field === "visibility"
				? !own
				: !(own && stillNew && askerFields.has(field)),
		);
		if (refused.length > 0) {
			throw new WorkError("Only the engineers change that.", 403);
		}
	}

	let parentId = row.parent_id;
	if (patch.parentKey !== undefined) {
		const parent = patch.parentKey ? await rowByKey(patch.parentKey) : null;
		if (parent && parent.item_id === row.item_id)
			throw new WorkError("A request cannot be its own parent.");
		if (parent) {
			// Walks up from the new parent. Meeting this request on the way
			// means the new parent sits under it, which would make a loop.
			const loop = await sql<{ found: boolean }>(
				`WITH RECURSIVE above AS (
				   SELECT item_id, parent_id FROM work_items WHERE item_id = $1
				   UNION
				   SELECT w.item_id, w.parent_id FROM work_items w
				   JOIN above a ON w.item_id = a.parent_id
				 )
				 SELECT EXISTS (SELECT 1 FROM above WHERE item_id = $2) AS found`,
				[parent.item_id, row.item_id],
			);
			if (loop[0]?.found)
				throw new WorkError(
					"That request is under this one, so it cannot be its parent.",
				);
		}
		parentId = parent?.item_id ?? null;
	}
	let releaseId = row.release_id;
	let target =
		patch.target !== undefined ? cleanDate(patch.target) : row.target_on;
	if (patch.releaseId !== undefined) {
		releaseId = patch.releaseId || null;
		if (releaseId) {
			const release = await sql<{ target_on: string | null }>(
				`SELECT target_on::text FROM work_releases WHERE release_id::text = $1`,
				[releaseId],
			);
			if (!release[0])
				throw new WorkError("That release does not exist.");
			// Its release's date is its target.
			target = release[0].target_on ?? target;
		}
	}

	const before: Partial<Record<TrackedField, unknown>> = {
		title: row.title,
		workType: row.work_type,
		priority: row.priority,
		effort: row.effort,
		layer: row.layer,
		domain: row.domain,
		target: row.target_on,
		assignees: row.assignees ?? [],
		reviewer: row.reviewer,
		approver: row.approver,
		tags: row.tags ?? [],
		visibility: row.visibility,
		parent: row.parent_id,
		release: row.release_id,
	};
	const after: Partial<Record<TrackedField, unknown>> = {};
	if (patch.title !== undefined) {
		const title = patch.title.trim().slice(0, 200);
		if (!title) throw new WorkError("Give it a title.");
		after.title = title;
	}
	if (patch.workType !== undefined)
		after.workType = oneOf(patch.workType, config.workTypes);
	if (patch.priority !== undefined)
		after.priority = oneOf(patch.priority, config.priorities);
	if (patch.effort !== undefined)
		after.effort = oneOf(patch.effort, config.efforts);
	if (patch.layer !== undefined)
		after.layer = oneOf(patch.layer, config.layers);
	if (patch.domain !== undefined)
		after.domain = oneOf(patch.domain, config.domains);
	if (patch.target !== undefined || patch.releaseId !== undefined)
		after.target = target;
	if (patch.assignees !== undefined)
		after.assignees = emailList(patch.assignees);
	if (patch.reviewer !== undefined) after.reviewer = email(patch.reviewer);
	if (patch.approver !== undefined) after.approver = email(patch.approver);
	if (patch.tags !== undefined) after.tags = cleanTags(patch.tags);
	if (patch.visibility !== undefined)
		after.visibility =
			patch.visibility === "restricted" ? "restricted" : "normal";
	if (patch.parentKey !== undefined) after.parent = parentId;
	if (patch.releaseId !== undefined) after.release = releaseId;

	const changes: FieldChange[] = changesBetween(before, after);
	const description =
		patch.description !== undefined && patch.description !== row.description
			? patch.description.slice(0, 50_000)
			: null;
	if (changes.length === 0 && description === null) return;

	const value = (field: TrackedField) =>
		field in after ? after[field] : before[field];
	await transaction(async (client) => {
		await client.query(
			`UPDATE work_items SET
			   title = $2, work_type = $3, priority = $4, effort = $5, layer = $6,
			   domain = $7, target_on = $8::date, assignees = $9, reviewer = $10,
			   approver = $11, tags = $12, visibility = $13, parent_id = $14::uuid,
			   release_id = $15::uuid, description = coalesce($16, description),
			   modified_on = now()
			 WHERE item_id = $1`,
			[
				row.item_id,
				value("title"),
				value("workType"),
				value("priority"),
				value("effort"),
				value("layer"),
				value("domain"),
				value("target"),
				value("assignees"),
				value("reviewer"),
				value("approver"),
				value("tags"),
				value("visibility"),
				value("parent"),
				value("release"),
				description,
			],
		);
		for (const change of changes) {
			await recordEvent(
				row.item_id,
				actor.email,
				"changed",
				{ ...change },
				client,
			);
		}
		if (description !== null) {
			await recordEvent(
				row.item_id,
				actor.email,
				"described",
				{ before: row.description, after: description },
				client,
			);
		}
	});
	// A pasted file edited out of the description goes with it.
	if (description !== null)
		await dropPastedWith(row.item_id, row.description);

	const key2 = formatKey(config.prefix, Number(row.number));
	const assigned = changes.find((c) => c.field === "assignees");
	if (assigned) {
		const newly = (assigned.to as string[]).filter(
			(e) => !(assigned.from as string[]).includes(e),
		);
		for (const person of newly) {
			if (person === actor.email) continue;
			await notify(person, {
				kind: "system",
				title: `${key2}: assigned to you`,
				body: row.title,
				link: safeLink(`/work/${key2}`),
				data: { workKey: key2 },
			}).catch(() => {});
		}
	}
}

// --- Moving ------------------------------------------------------------------

async function factsOf(row: Row) {
	const criteria = await sql<{ n: number }>(
		`SELECT count(*)::int AS n FROM work_criteria WHERE item_id = $1`,
		[row.item_id],
	);
	return {
		status: row.status,
		workType: row.work_type,
		priority: row.priority,
		effort: row.effort,
		domain: row.domain,
		layer: row.layer,
		assignees: row.assignees ?? [],
		reviewer: row.reviewer,
		approver: row.approver,
		approved: Boolean(row.approved_on),
		securityReviewed: Boolean(row.security_reviewed_on),
		target: row.target_on,
		criteria: criteria[0]?.n ?? 0,
		closed: row.closed_as !== null,
	};
}

export async function moveItem(
	actor: WorkActor,
	key: string,
	to: string,
	config?: WorkConfig,
): Promise<void> {
	const held = config ?? (await loadConfig());
	const { row } = await visibleRow(actor, key);
	if (row.status === to) return;
	const refused = refuseMove(await factsOf(row), to, actor, held);
	if (refused) {
		// Who may move it is a matter of permission. Anything else is about the
		// state of the request.
		const notAllowed =
			(!actor.engineer && !actor.devSecOps) ||
			(to === "done" &&
				held.rules.onlyDevSecOpsDeploys &&
				!actor.devSecOps);
		throw new WorkError(refused, notAllowed ? 403 : 409);
	}
	await setStatus(row, to, actor.email, held);
}

// Moves without asking the rules, for a move the system makes, such as an
// update that resolves a request being released.
export async function setStatus(
	row: Row,
	to: string,
	by: string,
	config: WorkConfig,
	why?: string,
): Promise<void> {
	await transaction(async (client) => {
		await client.query(
			`UPDATE work_items SET status = $2, status_since = now(), modified_on = now(),
			   started_on = CASE WHEN started_on IS NULL AND $2 = 'inProgress' THEN now() ELSE started_on END,
			   closed_on = CASE WHEN $2 = 'done' THEN now() ELSE NULL END
			 WHERE item_id = $1`,
			[row.item_id, to],
		);
		await recordEvent(
			row.item_id,
			by,
			"moved",
			{ from: row.status, to, ...(why ? { why } : {}) },
			client,
		);
	});
	const label = (id: string) =>
		config.columns.find((c) => c.id === id)?.label ?? id;
	await tellAbout(
		row.item_id,
		formatKey(config.prefix, Number(row.number)),
		by,
		`moved to ${label(to)}`,
		why ?? row.title,
	);
}

// --- Closing, blocking, approving --------------------------------------------

export async function closeItem(
	actor: WorkActor,
	key: string,
	as: "declined" | "duplicate",
	reason: string,
	duplicateOfKey?: string | null,
): Promise<void> {
	if (!actor.engineer)
		throw new WorkError("Only the engineers close requests.", 403);
	const config = await loadConfig();
	const { row, requesters } = await visibleRow(actor, key);
	if (row.closed_as) throw new WorkError("It is already closed.", 409);
	let target: Row | null = null;
	if (as === "duplicate") {
		target = duplicateOfKey ? await rowByKey(duplicateOfKey) : null;
		if (!target || target.item_id === row.item_id) {
			throw new WorkError("Say which request it duplicates.");
		}
	} else if (!reason.trim()) {
		throw new WorkError("Say why it is declined.");
	}
	await transaction(async (client) => {
		await client.query(
			`UPDATE work_items SET closed_as = $2, closed_reason = $3, duplicate_of = $4::uuid,
			   closed_on = now(), modified_on = now()
			 WHERE item_id = $1`,
			[
				row.item_id,
				as,
				reason.trim().slice(0, 2000) || null,
				target?.item_id ?? null,
			],
		);
		await recordEvent(
			row.item_id,
			actor.email,
			"closed",
			{
				as,
				reason: reason.trim() || null,
				duplicateOf: target
					? formatKey(config.prefix, Number(target.number))
					: null,
			},
			client,
		);
		if (target) {
			// Everybody who asked for the duplicate is moved onto the original,
			// so they hear when it is done.
			for (const person of requesters) {
				await client.query(
					`INSERT INTO work_requesters (item_id, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
					[target.item_id, person],
				);
			}
			await recordEvent(
				target.item_id,
				actor.email,
				"merged",
				{
					from: formatKey(config.prefix, Number(row.number)),
					title: row.title,
					people: requesters,
				},
				client,
			);
		}
	});
	await tellAbout(
		row.item_id,
		formatKey(config.prefix, Number(row.number)),
		actor.email,
		as === "duplicate"
			? `closed as a duplicate of ${formatKey(config.prefix, Number(target!.number))}`
			: "declined",
		reason || row.title,
	);
}

export async function reopenItem(actor: WorkActor, key: string): Promise<void> {
	if (!actor.engineer)
		throw new WorkError("Only the engineers reopen requests.", 403);
	const { row } = await visibleRow(actor, key);
	if (!row.closed_as && row.status !== "done") return;
	const config = await loadConfig();
	await transaction(async (client) => {
		await client.query(
			`UPDATE work_items SET closed_as = NULL, closed_reason = NULL, duplicate_of = NULL,
			   closed_on = NULL, status = CASE WHEN status = 'done' THEN 'backlog' ELSE status END,
			   status_since = now(), modified_on = now()
			 WHERE item_id = $1`,
			[row.item_id],
		);
		await recordEvent(row.item_id, actor.email, "reopened", {}, client);
	});
	await tellAbout(
		row.item_id,
		formatKey(config.prefix, Number(row.number)),
		actor.email,
		"reopened",
		row.title,
	);
}

export async function setBlocked(
	actor: WorkActor,
	key: string,
	blocked: boolean,
	reason: string,
	byKey?: string | null,
): Promise<void> {
	if (!actor.engineer)
		throw new WorkError("Only the engineers mark requests blocked.", 403);
	const { row } = await visibleRow(actor, key);
	if (blocked && !reason.trim())
		throw new WorkError("Say what it is waiting on.");
	const by = blocked && byKey ? await rowByKey(byKey) : null;
	const config = await loadConfig();
	await transaction(async (client) => {
		await client.query(
			`UPDATE work_items SET blocked = $2, blocked_reason = $3, modified_on = now() WHERE item_id = $1`,
			[
				row.item_id,
				blocked,
				blocked ? reason.trim().slice(0, 1000) : null,
			],
		);
		if (by) {
			await client.query(
				`INSERT INTO work_links (item_id, kind, target, created_by) VALUES ($1, 'dependsOn', $2, $3)
				 ON CONFLICT DO NOTHING`,
				[row.item_id, by.item_id, actor.email],
			);
		}
		await recordEvent(
			row.item_id,
			actor.email,
			blocked ? "blocked" : "unblocked",
			{
				reason: blocked ? reason.trim() : null,
				by: by ? formatKey(config.prefix, Number(by.number)) : null,
			},
			client,
		);
	});
	await tellAbout(
		row.item_id,
		formatKey(config.prefix, Number(row.number)),
		actor.email,
		blocked ? "blocked" : "unblocked",
		blocked ? reason : row.title,
	);
}

export async function signOff(
	actor: WorkActor,
	key: string,
	kind: "approve" | "securityReview",
): Promise<void> {
	const { row } = await visibleRow(actor, key);
	if (kind === "approve") {
		const named = row.approver && row.approver === actor.email;
		if (!named && !actor.engineer)
			throw new WorkError("Only its approver approves it.", 403);
		if (!named && row.approver)
			throw new WorkError(`${row.approver} is its approver.`, 403);
		await sql(
			`UPDATE work_items SET approved_by = $2, approved_on = now(), modified_on = now() WHERE item_id = $1`,
			[row.item_id, actor.email],
		);
		await recordEvent(row.item_id, actor.email, "approved");
	} else {
		if (!actor.devSecOps)
			throw new WorkError(
				"Only DevSecOps signs off a security review.",
				403,
			);
		await sql(
			`UPDATE work_items SET security_reviewed_by = $2, security_reviewed_on = now(), modified_on = now() WHERE item_id = $1`,
			[row.item_id, actor.email],
		);
		await recordEvent(row.item_id, actor.email, "securityReviewed");
	}
	const config = await loadConfig();
	await tellAbout(
		row.item_id,
		formatKey(config.prefix, Number(row.number)),
		actor.email,
		kind === "approve" ? "approved" : "security review signed off",
		row.title,
	);
}
