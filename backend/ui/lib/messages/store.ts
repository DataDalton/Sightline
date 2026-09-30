import type { PoolClient } from "pg";
import { displayNameFromEmail } from "../auth/names";
import { sql, transaction } from "../data/lakebase";
import {
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
}

export interface ThreadMessage {
	id: string;
	authorEmail: string;
	authorName: string;
	body: string;
	createdOn: string;
	mine: boolean;
}

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
			`INSERT INTO threads (subject, category_id, report_slug, created_by)
			 VALUES ($1, $2, $3, $4) RETURNING thread_id::text`,
			[input.subject, input.categoryId, input.reportSlug, author],
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
	}>(
		`SELECT t.thread_id::text, t.subject, t.category_id,
		        c.name AS category_name, t.report_slug, t.created_by,
		        t.last_message_on::text, last.author_email AS last_author,
		        left(last.body, 200) AS preview, r.read_on::text
		 FROM threads t
		 LEFT JOIN categories c ON c.category_id = t.category_id
		 LEFT JOIN thread_reads r
		   ON r.thread_id = t.thread_id AND r.user_email = $1
		 LEFT JOIN LATERAL (
		   SELECT author_email, body FROM thread_messages
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

	const rows = await sql<{
		message_id: string;
		author_email: string;
		body: string;
		created_on: string;
	}>(
		`SELECT message_id::text, author_email, body, created_on::text
		 FROM thread_messages WHERE thread_id = $1 ORDER BY created_on`,
		[threadId],
	);

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

	return {
		thread: { ...thread, unread: false },
		messages: rows.map((row) => ({
			id: row.message_id,
			authorEmail: row.author_email,
			authorName: displayNameFromEmail(row.author_email),
			body: row.body,
			createdOn: row.created_on,
			mine: row.author_email === me,
		})),
	};
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
}
