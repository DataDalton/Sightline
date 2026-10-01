import { sql, transaction } from "../data/lakebase";

// Where conversations and each person's standing preferences are kept.
//
// Every read and write is scoped to the email of the person asking, matched in
// lowercase, so one person's conversations are unreachable by another however
// the id is guessed. There is no administrative view of these: what somebody
// asked the assistant is theirs.

export interface ConversationSummary {
	id: string;
	title: string;
	modifiedOn: string;
	questions: number;
}

export interface Conversation {
	id: string;
	title: string;
	messages: unknown[];
	modifiedOn: string;
}

export interface Memory {
	id: string;
	text: string;
	createdOn: string;
}

export interface Profile {
	instructions: string;
	memories: Memory[];
}

// One message as a save carries it, already checked by the route. The JSON is
// kept as the text that arrived and cast to JSONB in the statement.
export interface StoredMessage {
	id: string;
	role: string;
	json: string;
}

// What one save brings to a conversation. The title is used only when the save
// creates the conversation, since a later title comes from a rename.
export interface ConversationChanges {
	title?: string;
	messages: StoredMessage[];
	removed: string[];
}

// Bounds on a person's standing preferences.
export const maxInstructions = 2000;
export const maxMemories = 50;
export const maxMemoryText = 300;

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConversationId(value: string): boolean {
	return uuidPattern.test(value);
}

function owner(email: string): string {
	return email.trim().toLowerCase();
}

export async function listConversations(
	email: string,
): Promise<ConversationSummary[]> {
	const rows = await sql<{
		conversation_id: string;
		title: string;
		modified_on: string;
		questions: string;
	}>(
		`SELECT conversation_id::text AS conversation_id,
		        title,
		        modified_on,
		        coalesce(questions, 0)::text AS questions
		 FROM assistant_conversations
		 WHERE owner_email = $1
		 ORDER BY modified_on DESC`,
		[owner(email)],
	);
	return rows.map((r) => ({
		id: r.conversation_id,
		title: r.title,
		modifiedOn: new Date(r.modified_on).toISOString(),
		questions: Number(r.questions),
	}));
}

// Reads the conversation's messages in the order they were first saved. A
// conversation whose transcript has not been moved into rows yet is read from
// the transcript column instead.
export async function getConversation(
	email: string,
	id: string,
): Promise<Conversation | null> {
	if (!isConversationId(id)) return null;
	const rows = await sql<{
		title: string;
		legacy: unknown;
		modified_on: string;
	}>(
		`SELECT title,
		        CASE WHEN messages_moved THEN NULL ELSE messages END AS legacy,
		        modified_on
		 FROM assistant_conversations
		 WHERE conversation_id = $1 AND owner_email = $2`,
		[id, owner(email)],
	);
	const row = rows[0];
	if (!row) return null;

	const stored = await sql<{ message: unknown }>(
		`SELECT m.message
		 FROM assistant_messages m
		 JOIN assistant_conversations c
		   ON c.conversation_id = m.conversation_id
		 WHERE m.conversation_id = $1 AND c.owner_email = $2
		 ORDER BY m.position, m.created_on, m.message_id`,
		[id, owner(email)],
	);
	const messages =
		stored.length > 0
			? stored.map((r) => r.message)
			: Array.isArray(row.legacy)
				? row.legacy
				: [];
	return {
		id,
		title: row.title,
		messages,
		modifiedOn: new Date(row.modified_on).toISOString(),
	};
}

// Moves one conversation's transcript, if it is still held whole, into one row
// per message. The flag is set in the same statement, so a transcript is moved
// once however often this runs. The migration in lib/platform/schema does the
// same for every conversation.
const moveTranscript = `WITH moved AS (
	     UPDATE assistant_conversations SET messages_moved = true
	     WHERE NOT messages_moved
	       AND conversation_id = $1 AND owner_email = $2
	     RETURNING conversation_id, messages)
	 INSERT INTO assistant_messages
	     (conversation_id, message_id, position, role, message)
	 SELECT moved.conversation_id,
	        coalesce(m.elem->>'id', 'moved-' || m.ord),
	        m.ord,
	        coalesce(m.elem->>'role', ''),
	        m.elem
	 FROM moved,
	      jsonb_array_elements(
	          CASE WHEN jsonb_typeof(moved.messages) = 'array'
	               THEN moved.messages ELSE '[]'::jsonb END)
	          WITH ORDINALITY AS m(elem, ord)
	 WHERE jsonb_typeof(m.elem) = 'object'
	 ON CONFLICT (conversation_id, message_id) DO NOTHING`;

// Creates the conversation if it is new, then stores the messages that are new
// or changed and drops the ones listed as removed, all in one transaction. A
// message already stored keeps its place and has its content replaced, so a
// save sent twice changes nothing. An id that exists under somebody else is
// not touched. The conversation row is only updated for the same owner, and
// nothing else runs when it was not.
export async function saveConversation(
	email: string,
	id: string,
	changes: ConversationChanges,
): Promise<boolean> {
	if (!isConversationId(id)) return false;
	const who = owner(email);
	return transaction(async (client) => {
		const claimed = await client.query<{ messages_moved: boolean }>(
			`INSERT INTO assistant_conversations
			     (conversation_id, owner_email, title, questions, messages_moved)
			 VALUES ($1, $2, $3, 0, true)
			 ON CONFLICT (conversation_id) DO UPDATE
			     SET modified_on = now()
			     WHERE assistant_conversations.owner_email = EXCLUDED.owner_email
			 RETURNING messages_moved`,
			[id, who, (changes.title ?? "").trim().slice(0, 120) || "Untitled"],
		);
		const row = claimed.rows[0];
		if (!row) return false;

		// Moved first, so new messages land after the ones already there.
		if (!row.messages_moved) {
			await client.query(moveTranscript, [id, who]);
		}

		if (changes.removed.length > 0) {
			await client.query(
				`DELETE FROM assistant_messages
				 WHERE conversation_id = $1 AND message_id = ANY($2::text[])`,
				[id, changes.removed],
			);
		}

		// The last copy of an id wins, since one statement cannot write the
		// same row twice.
		const latest = new Map<string, StoredMessage>();
		for (const m of changes.messages) {
			latest.delete(m.id);
			latest.set(m.id, m);
		}
		const messages = [...latest.values()];
		if (messages.length > 0) {
			await client.query(
				`INSERT INTO assistant_messages
				     (conversation_id, message_id, position, role, message)
				 SELECT $1, s.message_id, base.top + s.ord, s.role, s.message::jsonb
				 FROM unnest($2::text[], $3::text[], $4::text[])
				          WITH ORDINALITY AS s(message_id, role, message, ord),
				      (SELECT coalesce(max(position), 0) AS top
				       FROM assistant_messages WHERE conversation_id = $1) base
				 ON CONFLICT (conversation_id, message_id) DO UPDATE
				     SET message = EXCLUDED.message,
				         role = EXCLUDED.role`,
				[
					id,
					messages.map((m) => m.id),
					messages.map((m) => m.role),
					messages.map((m) => m.json),
				],
			);
		}

		// Counted from the rows on every save, so the history list reads a
		// number that stays right through removals and resends.
		await client.query(
			`UPDATE assistant_conversations
			 SET questions = (SELECT count(*) FROM assistant_messages
			                  WHERE conversation_id = $1 AND role = 'user')
			 WHERE conversation_id = $1 AND owner_email = $2`,
			[id, who],
		);
		return true;
	});
}

export async function renameConversation(
	email: string,
	id: string,
	title: string,
): Promise<boolean> {
	if (!isConversationId(id)) return false;
	const rows = await sql<{ conversation_id: string }>(
		`UPDATE assistant_conversations SET title = $3
		 WHERE conversation_id = $1 AND owner_email = $2
		 RETURNING conversation_id`,
		[id, owner(email), title.trim().slice(0, 120) || "Untitled"],
	);
	return rows.length > 0;
}

export async function deleteConversation(
	email: string,
	id: string,
): Promise<boolean> {
	if (!isConversationId(id)) return false;
	const rows = await sql<{ conversation_id: string }>(
		`DELETE FROM assistant_conversations
		 WHERE conversation_id = $1 AND owner_email = $2
		 RETURNING conversation_id`,
		[id, owner(email)],
	);
	return rows.length > 0;
}

export async function deleteAllConversations(email: string): Promise<number> {
	const rows = await sql<{ conversation_id: string }>(
		`DELETE FROM assistant_conversations WHERE owner_email = $1
		 RETURNING conversation_id`,
		[owner(email)],
	);
	return rows.length;
}

function readMemories(value: unknown): Memory[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(m): m is Memory =>
				Boolean(m) &&
				typeof m === "object" &&
				typeof (m as Memory).id === "string" &&
				typeof (m as Memory).text === "string",
		)
		.map((m) => ({
			id: m.id,
			text: m.text,
			createdOn: typeof m.createdOn === "string" ? m.createdOn : "",
		}));
}

export async function getProfile(email: string): Promise<Profile> {
	const rows = await sql<{ instructions: string; memories: unknown }>(
		`SELECT instructions, memories FROM assistant_profiles
		 WHERE owner_email = $1`,
		[owner(email)],
	);
	const row = rows[0];
	return {
		instructions: row?.instructions ?? "",
		memories: readMemories(row?.memories),
	};
}

export async function saveProfile(
	email: string,
	profile: Profile,
): Promise<Profile> {
	const clean: Profile = {
		instructions: profile.instructions.slice(0, maxInstructions),
		memories: profile.memories.slice(-maxMemories).map((m) => ({
			id: m.id,
			text: m.text.trim().slice(0, maxMemoryText),
			createdOn: m.createdOn || new Date().toISOString(),
		})),
	};
	await sql(
		`INSERT INTO assistant_profiles (owner_email, instructions, memories)
		 VALUES ($1, $2, $3::jsonb)
		 ON CONFLICT (owner_email) DO UPDATE
		     SET instructions = EXCLUDED.instructions,
		         memories = EXCLUDED.memories,
		         modified_on = now()`,
		[owner(email), clean.instructions, JSON.stringify(clean.memories)],
	);
	return clean;
}

// Adds one thing to remember, which is what the assistant does when somebody
// tells it to remember something. The oldest go first once the list is full.
//
// Appended and trimmed in one statement, so two memories added at the same
// moment both land rather than the second overwriting the list the first was
// added to.
export async function addMemory(email: string, text: string): Promise<Memory> {
	const memory: Memory = {
		id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
		text: text.trim().slice(0, maxMemoryText),
		createdOn: new Date().toISOString(),
	};
	await sql(
		`INSERT INTO assistant_profiles (owner_email, memories)
		 VALUES ($1, jsonb_build_array($2::jsonb))
		 ON CONFLICT (owner_email) DO UPDATE SET
		   memories = (
		     SELECT COALESCE(jsonb_agg(kept.elem ORDER BY kept.ord), '[]'::jsonb)
		     FROM (
		       SELECT a.elem, a.ord, count(*) OVER () AS total
		       FROM jsonb_array_elements(
		         (CASE WHEN jsonb_typeof(assistant_profiles.memories) = 'array'
		               THEN assistant_profiles.memories
		               ELSE '[]'::jsonb END)
		         || jsonb_build_array($2::jsonb)
		       ) WITH ORDINALITY AS a(elem, ord)
		     ) kept
		     WHERE kept.ord > kept.total - $3
		   ),
		   modified_on = now()`,
		[owner(email), JSON.stringify(memory), maxMemories],
	);
	return memory;
}
