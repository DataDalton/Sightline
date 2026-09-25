import { sql } from "../data/lakebase";

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

// Bounds on what one person can put here. A transcript carries its steps and
// their previews, so a long conversation is large; past these a save is
// refused rather than letting one row grow without end.
export const maxConversations = 200;
export const maxTranscriptBytes = 2_000_000;
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
		        (SELECT count(*) FROM jsonb_array_elements(messages) m
		          WHERE m->>'role' = 'user')::text AS questions
		 FROM assistant_conversations
		 WHERE owner_email = $1
		 ORDER BY modified_on DESC
		 LIMIT $2`,
		[owner(email), maxConversations],
	);
	return rows.map((r) => ({
		id: r.conversation_id,
		title: r.title,
		modifiedOn: new Date(r.modified_on).toISOString(),
		questions: Number(r.questions),
	}));
}

export async function getConversation(
	email: string,
	id: string,
): Promise<Conversation | null> {
	if (!isConversationId(id)) return null;
	const rows = await sql<{
		title: string;
		messages: unknown[];
		modified_on: string;
	}>(
		`SELECT title, messages, modified_on
		 FROM assistant_conversations
		 WHERE conversation_id = $1 AND owner_email = $2`,
		[id, owner(email)],
	);
	const row = rows[0];
	if (!row) return null;
	return {
		id,
		title: row.title,
		messages: Array.isArray(row.messages) ? row.messages : [],
		modifiedOn: new Date(row.modified_on).toISOString(),
	};
}

// Creates the conversation or replaces its transcript. An id that exists under
// somebody else is not overwritten: the upsert only updates a row the same
// person owns, and reports whether anything was written.
export async function saveConversation(
	email: string,
	id: string,
	title: string,
	messages: unknown[],
): Promise<boolean> {
	if (!isConversationId(id)) return false;
	const rows = await sql<{ conversation_id: string }>(
		`INSERT INTO assistant_conversations
		     (conversation_id, owner_email, title, messages)
		 VALUES ($1, $2, $3, $4::jsonb)
		 ON CONFLICT (conversation_id) DO UPDATE
		     SET title = EXCLUDED.title,
		         messages = EXCLUDED.messages,
		         modified_on = now()
		     WHERE assistant_conversations.owner_email = EXCLUDED.owner_email
		 RETURNING conversation_id`,
		[id, owner(email), title.slice(0, 120), JSON.stringify(messages)],
	);
	if (rows.length === 0) return false;

	// Oldest beyond the limit go, so the list stays one somebody can read.
	await sql(
		`DELETE FROM assistant_conversations
		 WHERE owner_email = $1
		   AND conversation_id NOT IN (
		       SELECT conversation_id FROM assistant_conversations
		       WHERE owner_email = $1
		       ORDER BY modified_on DESC
		       LIMIT $2)`,
		[owner(email), maxConversations],
	);
	return true;
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
export async function addMemory(email: string, text: string): Promise<Memory> {
	const profile = await getProfile(email);
	const memory: Memory = {
		id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
		text: text.trim().slice(0, maxMemoryText),
		createdOn: new Date().toISOString(),
	};
	await saveProfile(email, {
		...profile,
		memories: [...profile.memories, memory],
	});
	return memory;
}
