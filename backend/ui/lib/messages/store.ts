import type { PoolClient } from "pg";
import { displayNameFromEmail } from "../auth/names";
import { sql, transaction } from "../data/lakebase";
import {
	forgetSummary,
	notifyInTransaction,
	pushNotification,
	type InboxItem,
} from "../notify/store";
import { canSee, limits, peopleToTell, type Member } from "./rules";

// Conversations with the people who maintain a category.
//
// Somebody reading a report asks its maintainers a question, and the answer
// comes back to them in the same place. Both sides reply from their inbox, and
// every message is also a notification, so it reaches a phone the way an alert
// does.
//
// A conversation is addressed to people and groups, recorded when it is
// started. Who counts as in a group is read each time somebody looks, from the
// groups they were resolved into when they signed in, so a message to a team
// is one conversation the whole team shares rather than a copy each.

export class MessageError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export interface ThreadMember {
	type: "user" | "group";
	id: string;
	name: string;
}

export interface ThreadSummary {
	id: string;
	subject: string;
	categoryId: string;
	categoryName: string | null;
	reportSlug: string | null;
	createdBy: string;
	createdByName: string;
	lastMessageOn: string;
	lastAuthorName: string;
	preview: string;
	unread: boolean;
	members: ThreadMember[];
	// The assistant takes part, reading the conversation and offering answers
	// and changes. See lib/feedback/threadAssistant.
	withAssistant: boolean;
	// The assistant conversation the person who asked chose to share.
	sharedConversationId: string | null;
	// The visual it is about, when it started from one.
	visualId: string | null;
}

export interface ThreadMessage {
	id: string;
	authorEmail: string;
	authorName: string;
	body: string;
	createdOn: string;
	mine: boolean;
	// "text", or "proposal" for a change the assistant offers with Apply and
	// Suggest, whose details are in payload.
	kind: string;
	payload: unknown;
	// Removed by its author. The body is empty when it is.
	removed: boolean;
}

// The name the assistant posts under. Matches lib/upkeep/actor.
export const assistantAuthor = "Assistant";

function memberName(m: Member): string {
	return m.type === "user" ? displayNameFromEmail(m.id) : m.id;
}

function linkTo(threadId: string): string {
	return `/inbox/?view=conversations&thread=${threadId}`;
}

// A conversation is visible to whoever is named in it, directly or through a
// group they are in. The same test canSee applies, written as SQL so a list
// can be filtered in the database.
const visibleTo = `EXISTS (
	SELECT 1 FROM thread_members m
	WHERE m.thread_id = t.thread_id
	  AND ((m.member_type = 'user' AND m.member_id = $1)
	    OR (m.member_type = 'group' AND m.member_id = ANY($2::text[])))
)`;

async function membersOf(threadIds: string[]): Promise<Map<string, Member[]>> {
	const rows = await sql<{
		thread_id: string;
		member_type: "user" | "group";
		member_id: string;
	}>(
		`SELECT thread_id::text, member_type, member_id FROM thread_members
		 WHERE thread_id = ANY($1::uuid[])`,
		[threadIds],
	);
	const out = new Map<string, Member[]>();
	for (const row of rows) {
		const list = out.get(row.thread_id) ?? [];
		list.push({ type: row.member_type, id: row.member_id });
		out.set(row.thread_id, list);
	}
	return out;
}

// Members of each group, of everyone who has ever used the application, as of
// the last time each of them was checked. Somebody who has never signed in is
// not told, since there is no inbox of theirs to put it in.
export async function knownMembers(
	groups: string[],
): Promise<Record<string, string[]>> {
	if (groups.length === 0) return {};
	const rows = await sql<{ grp: string; user_email: string }>(
		`SELECT g.grp, m.user_email
		 FROM member_groups m
		 CROSS JOIN LATERAL jsonb_array_elements_text(m.grants) AS g(grp)
		 WHERE m.grants ?| $1::text[] AND g.grp = ANY($1::text[])`,
		[groups],
	);
	const out: Record<string, string[]> = {};
	for (const row of rows) (out[row.grp] ??= []).push(row.user_email);
	return out;
}

// Who is told of a message, everyone named in the conversation apart from
// its author. Resolved before the message is written, so the inbox entries
// can be written in the same transaction as the message.
async function peopleFor(members: Member[], author: string): Promise<string[]> {
	const groups = members.filter((m) => m.type === "group").map((m) => m.id);
	return peopleToTell(members, await knownMembers(groups), author);
}

interface Written {
	email: string;
	item: InboxItem;
}

// Writes an inbox entry for each person inside the caller's transaction, so
// the entries commit or roll back with the message they announce.
async function writeNotices(
	client: PoolClient,
	people: string[],
	threadId: string,
	title: string,
	body: string,
): Promise<Written[]> {
	const written: Written[] = [];
	for (const email of people) {
		written.push({
			email,
			item: await notifyInTransaction(client, email, {
				kind: "message",
				title,
				body: body.slice(0, 300),
				link: linkTo(threadId),
				data: { threadId },
			}),
		});
	}
	return written;
}

// Pushed once the transaction has committed, so no device hears of a
// message that rolled back.
function pushAll(written: Written[]): void {
	for (const { email, item } of written) pushNotification(email, item);
}

export async function startThread(input: {
	author: string;
	categoryId: string;
	reportSlug: string | null;
	subject: string;
	body: string;
	recipients: Member[];
	// With the assistant taking part, the conversation the person shared with
	// their consent, and the visual it is about.
	withAssistant?: boolean;
	sharedConversationId?: string | null;
	visualId?: string | null;
}): Promise<string> {
	const author = input.author.toLowerCase();
	const others = input.recipients.filter(
		(m) => !(m.type === "user" && m.id === author),
	);
	if (others.length === 0 && input.recipients.length > 0) {
		throw new MessageError(
			"You are the only maintainer of this category, so there is nobody else to ask.",
			409,
		);
	}
	if (input.recipients.length === 0) {
		throw new MessageError(
			"Nobody maintains this category yet, so there is nobody to ask.",
			409,
		);
	}

	const recent = await sql<{ count: string }>(
		`SELECT count(*)::text AS count FROM threads
		 WHERE created_by = $1 AND created_on > now() - interval '1 hour'`,
		[author],
	);
	if (Number(recent[0]?.count ?? 0) >= limits.startsPerHour) {
		throw new MessageError(
			"You have started a lot of conversations in the last hour. Try again later, or reply in one you already have.",
			429,
		);
	}

	// The author is a member too, so the replies come back to them.
	const members: Member[] = [
		{ type: "user", id: author },
		...input.recipients.filter(
			(m) => !(m.type === "user" && m.id === author),
		),
	];

	const people = await peopleFor(members, author);
	const title = `${displayNameFromEmail(author)} asked: ${input.subject}`;

	const { threadId, written } = await transaction(async (client) => {
		const created = await client.query<{ thread_id: string }>(
			`INSERT INTO threads
			   (subject, category_id, report_slug, created_by, with_assistant,
			    shared_conversation_id, visual_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING thread_id::text`,
			[
				input.subject,
				input.categoryId,
				input.reportSlug,
				author,
				input.withAssistant === true,
				input.sharedConversationId ?? null,
				input.visualId ?? null,
			],
		);
		const id = created.rows[0].thread_id;
		for (const m of members) {
			await client.query(
				`INSERT INTO thread_members (thread_id, member_type, member_id)
				 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				[id, m.type, m.id],
			);
		}
		await client.query(
			`INSERT INTO thread_messages (thread_id, author_email, body)
			 VALUES ($1, $2, $3)`,
			[id, author, input.body],
		);
		await client.query(
			`INSERT INTO thread_reads (thread_id, user_email) VALUES ($1, $2)`,
			[id, author],
		);
		return {
			threadId: id,
			written: await writeNotices(client, people, id, title, input.body),
		};
	});

	pushAll(written);
	return threadId;
}

// With a thread id, only that thread, and only when this person can see it.
// Asked directly rather than looked for in the newest page, so an older thread
// opens as well as a recent one.
export async function listThreads(
	email: string,
	groups: string[],
	threadId: string | null = null,
): Promise<ThreadSummary[]> {
	const me = email.toLowerCase();
	const rows = await sql<{
		thread_id: string;
		subject: string;
		category_id: string;
		category_name: string | null;
		report_slug: string | null;
		created_by: string;
		last_message_on: string;
		last_author: string | null;
		preview: string | null;
		read_on: string | null;
		with_assistant: boolean;
		shared_conversation_id: string | null;
		visual_id: string | null;
	}>(
		`SELECT t.thread_id::text, t.subject, t.category_id,
		        c.name AS category_name, t.report_slug, t.created_by,
		        t.with_assistant, t.shared_conversation_id::text,
		        t.visual_id::text,
		        t.last_message_on::text, last.author_email AS last_author,
		        CASE WHEN last.removed_on IS NULL THEN left(last.body, 200)
		             ELSE 'Message removed' END AS preview,
		        r.read_on::text
		 FROM threads t
		 LEFT JOIN categories c ON c.category_id = t.category_id
		 LEFT JOIN thread_reads r
		   ON r.thread_id = t.thread_id AND r.user_email = $1
		 LEFT JOIN LATERAL (
		   SELECT author_email, body, removed_on FROM thread_messages
		   WHERE thread_id = t.thread_id
		   ORDER BY created_on DESC LIMIT 1
		 ) last ON TRUE
		 WHERE ${visibleTo}
		   AND ($3::text IS NULL OR t.thread_id::text = $3)
		 ORDER BY t.last_message_on DESC
		 LIMIT 100`,
		[me, groups, threadId],
	);
	const members = await membersOf(rows.map((r) => r.thread_id));

	return rows.map((row) => ({
		id: row.thread_id,
		subject: row.subject,
		categoryId: row.category_id,
		categoryName: row.category_name,
		reportSlug: row.report_slug,
		createdBy: row.created_by,
		createdByName: displayNameFromEmail(row.created_by),
		lastMessageOn: row.last_message_on,
		lastAuthorName: row.last_author
			? row.last_author === me
				? "You"
				: displayNameFromEmail(row.last_author)
			: "",
		preview: row.preview ?? "",
		// Unread when somebody else has written since this person last
		// looked. Their own message is never news to them.
		unread:
			row.last_author !== me &&
			(!row.read_on ||
				new Date(row.last_message_on) > new Date(row.read_on)),
		members: (members.get(row.thread_id) ?? []).map((m) => ({
			...m,
			name: memberName(m),
		})),
		withAssistant: row.with_assistant,
		sharedConversationId: row.shared_conversation_id,
		visualId: row.visual_id,
	}));
}

// How many conversations have something this person has not read.
export async function unreadThreadCount(
	email: string,
	groups: string[],
): Promise<number> {
	const threads = await listThreads(email, groups);
	return threads.filter((t) => t.unread).length;
}

// One conversation with its messages, marked read for whoever opened it. The
// notifications that pointed at it are marked read too, since reading the
// conversation is reading them.
export async function openThread(
	threadId: string,
	email: string,
	groups: string[],
): Promise<{ thread: ThreadSummary; messages: ThreadMessage[] } | null> {
	const me = email.toLowerCase();
	const thread = (await listThreads(me, groups, threadId)).find(
		(t) => t.id === threadId,
	);
	if (!thread) return null;

	const rows = await messagesOf(threadId);

	await sql(
		`INSERT INTO thread_reads (thread_id, user_email) VALUES ($1, $2)
		 ON CONFLICT (thread_id, user_email) DO UPDATE SET read_on = now()`,
		[threadId, me],
	);
	await sql(
		`UPDATE notifications SET read_on = now()
		 WHERE owner_email = $1 AND read_on IS NULL
		   AND kind = 'message' AND data->>'threadId' = $2`,
		[me, threadId],
	);
	forgetSummary(me);

	return {
		thread: { ...thread, unread: false },
		messages: rows.map((row) => toMessage(row, me)),
	};
}

interface MessageRow {
	message_id: string;
	author_email: string;
	body: string;
	created_on: string;
	kind: string;
	payload: unknown;
	removed_on: string | null;
}

async function messagesOf(threadId: string): Promise<MessageRow[]> {
	return sql<MessageRow>(
		`SELECT message_id::text, author_email, body, created_on::text, kind,
		        payload, removed_on::text
		 FROM thread_messages WHERE thread_id = $1 ORDER BY created_on`,
		[threadId],
	);
}

function toMessage(row: MessageRow, me: string): ThreadMessage {
	return {
		id: row.message_id,
		authorEmail: row.author_email,
		authorName:
			row.author_email.toLowerCase() === assistantAuthor.toLowerCase()
				? assistantAuthor
				: displayNameFromEmail(row.author_email),
		body: row.removed_on ? "" : row.body,
		createdOn: row.created_on,
		mine: row.author_email === me,
		kind: row.kind,
		payload: row.removed_on ? null : row.payload,
		removed: row.removed_on !== null,
	};
}

// Removes a message its author wrote. Somebody else's message, or one in a
// conversation the caller is not in, reads as not found.
export async function removeMessage(
	threadId: string,
	messageId: string,
	email: string,
	groups: string[],
): Promise<void> {
	const me = email.toLowerCase();
	const members = (await membersOf([threadId])).get(threadId) ?? [];
	if (!canSee(members, me, groups)) {
		throw new MessageError("Conversation not found", 404);
	}
	const removed = await sql<{ message_id: string }>(
		`UPDATE thread_messages SET removed_on = now()
		 WHERE thread_id::text = $1 AND message_id::text = $2
		   AND lower(author_email) = $3 AND removed_on IS NULL
		 RETURNING message_id::text`,
		[threadId, messageId, me],
	);
	if (removed.length === 0) {
		throw new MessageError("Message not found", 404);
	}
	forgetSummary(me);
}

// A conversation read by somebody granted review of it. Nothing is marked read
// and no notification changes, so the members see no sign of it. The grant and
// the reading are recorded by lib/review instead.
export async function readThreadForReview(threadId: string): Promise<{
	thread: {
		id: string;
		subject: string;
		reportSlug: string | null;
		createdBy: string;
		createdOn: string;
		members: ThreadMember[];
	};
	messages: ThreadMessage[];
} | null> {
	const rows = await sql<{
		thread_id: string;
		subject: string;
		report_slug: string | null;
		created_by: string;
		created_on: string;
	}>(
		`SELECT thread_id::text, subject, report_slug, created_by,
		        created_on::text
		 FROM threads WHERE thread_id::text = $1`,
		[threadId],
	);
	const row = rows[0];
	if (!row) return null;
	const members = (await membersOf([threadId])).get(threadId) ?? [];
	return {
		thread: {
			id: row.thread_id,
			subject: row.subject,
			reportSlug: row.report_slug,
			createdBy: row.created_by,
			createdOn: row.created_on,
			members: members.map((m) => ({ ...m, name: memberName(m) })),
		},
		messages: (await messagesOf(threadId)).map((m) => toMessage(m, "")),
	};
}

// The members of a conversation, for telling them about it.
export async function threadMembers(threadId: string): Promise<Member[]> {
	return (await membersOf([threadId])).get(threadId) ?? [];
}

// A message the assistant posts in a conversation it takes part in: an answer,
// or a proposed change. Everybody in the conversation is told, as with any
// reply.
export async function postAssistantMessage(
	threadId: string,
	body: string,
	kind: "text" | "proposal" = "text",
	payload: unknown = null,
): Promise<string> {
	const members = (await membersOf([threadId])).get(threadId) ?? [];
	const people = await peopleFor(members, assistantAuthor);
	const { messageId, written } = await transaction(async (client) => {
		const inserted = await client.query<{ message_id: string }>(
			`INSERT INTO thread_messages (thread_id, author_email, body, kind, payload)
			 VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING message_id::text`,
			[threadId, assistantAuthor, body, kind, JSON.stringify(payload)],
		);
		const updated = await client.query<{ subject: string }>(
			`UPDATE threads SET last_message_on = now()
			 WHERE thread_id = $1 RETURNING subject`,
			[threadId],
		);
		return {
			messageId: inserted.rows[0].message_id,
			written: await writeNotices(
				client,
				people,
				threadId,
				`${assistantAuthor} in: ${updated.rows[0]?.subject ?? ""}`,
				body,
			),
		};
	});
	pushAll(written);
	return messageId;
}

// Records what happened to a proposal card, such as who applied it.
export async function updateProposal(
	threadId: string,
	messageId: string,
	change: Record<string, unknown>,
): Promise<void> {
	await sql(
		`UPDATE thread_messages
		 SET payload = coalesce(payload, '{}'::jsonb) || $3::jsonb
		 WHERE thread_id::text = $1 AND message_id::text = $2 AND kind = 'proposal'`,
		[threadId, messageId, JSON.stringify(change)],
	);
}

export async function proposalOf(
	threadId: string,
	messageId: string,
): Promise<Record<string, unknown> | null> {
	const rows = await sql<{ payload: Record<string, unknown> | null }>(
		`SELECT payload FROM thread_messages
		 WHERE thread_id::text = $1 AND message_id::text = $2 AND kind = 'proposal'`,
		[threadId, messageId],
	);
	return rows[0]?.payload ?? null;
}

export async function reply(
	threadId: string,
	email: string,
	groups: string[],
	body: string,
): Promise<void> {
	const me = email.toLowerCase();
	const members = (await membersOf([threadId])).get(threadId) ?? [];
	if (!canSee(members, me, groups)) {
		throw new MessageError("Conversation not found", 404);
	}
	const people = await peopleFor(members, me);
	const written = await transaction(async (client) => {
		await client.query(
			`INSERT INTO thread_messages (thread_id, author_email, body)
			 VALUES ($1, $2, $3)`,
			[threadId, me, body],
		);
		const updated = await client.query<{ subject: string }>(
			`UPDATE threads SET last_message_on = now()
			 WHERE thread_id = $1 RETURNING subject`,
			[threadId],
		);
		await client.query(
			`INSERT INTO thread_reads (thread_id, user_email) VALUES ($1, $2)
			 ON CONFLICT (thread_id, user_email) DO UPDATE SET read_on = now()`,
			[threadId, me],
		);
		const subject = updated.rows[0]?.subject ?? "";
		return writeNotices(
			client,
			people,
			threadId,
			`${displayNameFromEmail(me)} replied: ${subject}`,
			body,
		);
	});

	pushAll(written);

	// A conversation the assistant takes part in gets its reading of the new
	// message. Not waited for, so the reply is never held up by the model.
	const flags = await sql<{ with_assistant: boolean }>(
		`SELECT with_assistant FROM threads WHERE thread_id = $1`,
		[threadId],
	);
	if (flags[0]?.with_assistant) {
		void import("../feedback/threadAssistant")
			.then(({ respondInThread }) => respondInThread(threadId))
			.catch((error) => {
				console.warn(
					"The assistant did not answer in a conversation:",
					error,
				);
			});
	}
}
