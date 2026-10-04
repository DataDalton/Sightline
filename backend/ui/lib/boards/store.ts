import type { Identity } from "../auth/identity";
import { insertLog } from "../activityLog";
import { batchedRead } from "../data/batch";
import { sql, transaction } from "../data/lakebase";
import { noteOpened } from "../retention/opened";
import {
	cleanDefinition,
	cleanItem,
	cleanTitle,
	defaultSizes,
	emptyBoard,
	placeBelow,
	type BoardDefinition,
	type BoardItem,
} from "./definition";

// Boards as stored, who may open them, and the changes made to them.
//
// A board holds visuals, but never their data. Each visual is read when the
// board is opened, by whoever opens it, under their own access, so sharing a
// board shares an arrangement and not numbers. A person shown a visual on a
// dataset they cannot read sees that it is there and nothing of what it says.

export type BoardPermission = "owner" | "edit" | "view";

export interface BoardSummary {
	id: string;
	title: string;
	ownerEmail: string;
	permission: BoardPermission;
	modifiedOn: string;
	modifiedBy: string;
	sharedWith: number;
	itemCount: number;
	// Its owner marked it to be kept however long it goes unused.
	keep: boolean;
}

export interface Board extends BoardSummary {
	definition: BoardDefinition;
	version: number;
}

export class BoardError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

interface Row {
	board_id: string;
	owner_email: string;
	title: string;
	definition: BoardDefinition;
	version: string;
	modified_on: string;
	modified_by: string;
	permission: BoardPermission;
	shared_with: string;
	keep: boolean;
}

// Every board query reads through this condition, so what somebody may open
// is decided in one place. It holds boards they own, and boards named to them,
// and never a board in the retention bin, which its owner restores through
// lib/retention. Bracketed because callers append further conditions with AND.
const canOpen = `(b.removed_on IS NULL
	  AND (b.owner_email = $1
	    OR EXISTS (SELECT 1 FROM board_shares s
	               WHERE s.board_id = b.board_id AND s.email = $1)))`;

// The columns every board query reads, apart from the definition.
const columns = `
	b.board_id::text, b.owner_email, b.title,
	b.version::text, b.modified_on::text, b.modified_by, b.keep,
	CASE WHEN b.owner_email = $1 THEN 'owner'
	     ELSE (SELECT s.permission FROM board_shares s
	           WHERE s.board_id = b.board_id AND s.email = $1)
	END AS permission,
	(SELECT count(*) FROM board_shares s
	 WHERE s.board_id = b.board_id)::text AS shared_with`;

const visible = `
	SELECT ${columns}, b.definition
	FROM boards b
	WHERE ${canOpen}`;

// Opening a board reads it once per request, so everyone opening one at
// about the same time is answered by one statement. The query is the one
// above, asked once for each reader and board given, with the reader in
// place of $1. See lib/data/batch.
const boardReads = batchedRead<{ email: string; id: string }, Row | null>(
	async (asked) => {
		const rows = await sql<Row & { asker: string }>(
			`SELECT k.e AS asker, x.*
			 FROM unnest($1::text[], $2::uuid[]) AS k(e, id)
			 CROSS JOIN LATERAL (
			   ${visible.replaceAll("$1", "k.e")} AND b.board_id = k.id
			 ) x`,
			[asked.map((k) => k.email), asked.map((k) => k.id)],
		);
		return new Map(
			rows.map(({ asker, ...row }) => [
				readKey(asker, row.board_id),
				row as Row,
			]),
		);
	},
	(k) => readKey(k.email, k.id),
	null,
);

function readKey(email: string, id: string): string {
	return JSON.stringify([email, id.toLowerCase()]);
}

function toBoard(row: Row): Board {
	const definition = cleanDefinition(row.definition);
	return {
		id: row.board_id,
		title: row.title,
		ownerEmail: row.owner_email,
		permission: row.permission,
		modifiedOn: row.modified_on,
		modifiedBy: row.modified_by,
		sharedWith: Number(row.shared_with),
		keep: row.keep === true,
		itemCount: definition.items.length,
		definition,
		version: Number(row.version),
	};
}

export function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

// Counts each board's items in the database rather than reading every
// definition across.
export async function listBoards(identity: Identity): Promise<BoardSummary[]> {
	const rows = await sql<
		Omit<Row, "definition" | "version"> & { item_count: string }
	>(
		`SELECT ${columns},
		        CASE WHEN jsonb_typeof(b.definition->'items') = 'array'
		             THEN jsonb_array_length(b.definition->'items')
		             ELSE 0 END::text AS item_count
		 FROM boards b
		 WHERE ${canOpen}
		 ORDER BY b.modified_on DESC`,
		[identity.email.toLowerCase()],
	);
	return rows.map((r) => ({
		id: r.board_id,
		title: r.title,
		ownerEmail: r.owner_email,
		permission: r.permission,
		modifiedOn: r.modified_on,
		modifiedBy: r.modified_by,
		sharedWith: Number(r.shared_with),
		keep: r.keep === true,
		itemCount: Number(r.item_count),
	}));
}

export async function getBoard(
	identity: Identity,
	id: string,
): Promise<Board | null> {
	if (!isUuid(id)) return null;
	const row = await boardReads({ email: identity.email.toLowerCase(), id });
	if (!row) return null;
	// Any read by somebody who may open it counts as use for retention.
	noteOpened("board", id);
	return toBoard(row);
}

// The version of a board the caller may open, or null when they may not or it
// does not exist. Lets a page that already holds the board ask whether it
// changed without reading the definition again.
export async function boardVersion(
	identity: Identity,
	id: string,
): Promise<number | null> {
	if (!isUuid(id)) return null;
	const rows = await sql<{ version: string }>(
		`SELECT b.version::text FROM boards b
		 WHERE b.board_id = $2 AND ${canOpen}`,
		[identity.email.toLowerCase(), id],
	);
	return rows[0] ? Number(rows[0].version) : null;
}

// What a write changed, read back from its RETURNING clause.
interface Written {
	version: string;
	modified_on: string;
	modified_by: string;
}

// The board as it stands after a write, built from the copy read before it
// and what the write returned, rather than read again.
function afterWrite(
	board: Board,
	title: string,
	definition: BoardDefinition,
	written: Written,
): Board {
	return {
		...board,
		title,
		definition,
		itemCount: definition.items.length,
		version: Number(written.version),
		modifiedOn: written.modified_on,
		modifiedBy: written.modified_by,
	};
}

function mayEdit(board: Board): boolean {
	return board.permission === "owner" || board.permission === "edit";
}

// A new board owned by the caller. Starts from the definition given, when
// there is one, with any items added below what it holds.
export async function createBoard(
	identity: Identity,
	title: unknown,
	items: unknown,
	start?: unknown,
): Promise<Board> {
	const email = identity.email.toLowerCase();
	const definition =
		start !== undefined ? cleanDefinition(start) : emptyBoard();
	if (Array.isArray(items)) appendTo(definition, items);
	const named = cleanTitle(title) || "Untitled board";
	const rows = await sql<Written & { board_id: string }>(
		`INSERT INTO boards (owner_email, title, definition, modified_by)
		 VALUES ($1, $2, $3, $1)
		 RETURNING board_id::text, version::text, modified_on::text,
		           modified_by`,
		[email, named, JSON.stringify(definition)],
	);
	const row = rows[0];
	return afterWrite(
		{
			id: row.board_id,
			title: named,
			ownerEmail: email,
			permission: "owner",
			modifiedOn: row.modified_on,
			modifiedBy: row.modified_by,
			sharedWith: 0,
			keep: false,
			itemCount: 0,
			definition,
			version: 0,
		},
		named,
		definition,
		row,
	);
}

// Adds items below what is already there. Positions sent with them are
// ignored, since whoever adds from a report has not seen the board.
function appendTo(definition: BoardDefinition, raw: unknown[]): BoardItem[] {
	const taken = new Set(definition.items.map((i) => i.id));
	const items = raw
		.map((r) => cleanItem(r, taken))
		.filter((i): i is BoardItem => i !== null)
		.map((i) => ({ ...i, w: i.w || defaultSizes[i.kind].w }));
	const places = placeBelow(definition, items);
	const placed = items.map((item, n) => ({ ...item, ...places[n] }));
	definition.items.push(...placed);
	return placed;
}

// A change to the whole board, refused when the caller's copy is behind, so
// two people arranging it at once cannot silently undo each other. A caller
// that has just read the board for the same person passes it in, and it is
// not read again.
export async function updateBoard(
	identity: Identity,
	id: string,
	change: { title?: unknown; definition?: unknown; baseVersion?: unknown },
	loaded?: Board,
): Promise<Board> {
	const board =
		loaded && loaded.id === id ? loaded : await getBoard(identity, id);
	if (!board) throw new BoardError("Board not found", 404);
	if (!mayEdit(board))
		throw new BoardError("This board is shared with you to view.", 403);
	const base = Number(change.baseVersion);
	const title =
		change.title !== undefined
			? cleanTitle(change.title) || board.title
			: board.title;
	const definition =
		change.definition !== undefined
			? cleanDefinition(change.definition)
			: board.definition;
	const rows = await sql<Written>(
		`UPDATE boards SET title = $3, definition = $4, version = version + 1,
		   modified_on = now(), modified_by = $5
		 WHERE board_id = $1 AND removed_on IS NULL
		   AND ($2::bigint IS NULL OR version = $2)
		 RETURNING version::text, modified_on::text, modified_by`,
		[
			id,
			Number.isFinite(base) ? base : null,
			title,
			JSON.stringify(definition),
			identity.email.toLowerCase(),
		],
	);
	if (rows.length === 0) {
		throw new BoardError(
			"Somebody else changed this board a moment ago. It has been reloaded with their change.",
			409,
		);
	}
	return afterWrite(board, title, definition, rows[0]);
}

// Adds items from elsewhere, such as a visual from a report. Read and written
// in one transaction under a row lock, so two additions at once both land and
// neither needs the caller to know the board's version.
export async function addItems(
	identity: Identity,
	id: string,
	items: unknown,
	loaded?: Board,
): Promise<{ board: Board; added: BoardItem[] }> {
	const board =
		loaded && loaded.id === id ? loaded : await getBoard(identity, id);
	if (!board) throw new BoardError("Board not found", 404);
	if (!mayEdit(board))
		throw new BoardError("This board is shared with you to view.", 403);
	if (!Array.isArray(items) || items.length === 0)
		throw new BoardError("Nothing to add.");
	const added = await transaction(async (client) => {
		const locked = await client.query<{ definition: BoardDefinition }>(
			`SELECT definition FROM boards WHERE board_id = $1 FOR UPDATE`,
			[id],
		);
		const definition = cleanDefinition(locked.rows[0]?.definition);
		const placed = appendTo(definition, items);
		const written = await client.query<Written & { title: string }>(
			`UPDATE boards SET definition = $2, version = version + 1,
			   modified_on = now(), modified_by = $3
			 WHERE board_id = $1 AND removed_on IS NULL
			 RETURNING title, version::text, modified_on::text, modified_by`,
			[id, JSON.stringify(definition), identity.email.toLowerCase()],
		);
		return { placed, definition, written: written.rows[0] };
	});
	if (added.placed.length === 0) throw new BoardError("Nothing to add.");
	if (!added.written) throw new BoardError("Board not found", 404);
	return {
		board: afterWrite(
			board,
			added.written.title,
			added.definition,
			added.written,
		),
		added: added.placed,
	};
}

export async function deleteBoard(
	identity: Identity,
	id: string,
): Promise<void> {
	const board = await getBoard(identity, id);
	if (!board) throw new BoardError("Board not found", 404);
	if (board.permission !== "owner") {
		// Somebody it was shared with removes it from their own list.
		await sql(
			`DELETE FROM board_shares WHERE board_id = $1 AND email = $2`,
			[id, identity.email.toLowerCase()],
		);
		return;
	}
	await sql(`DELETE FROM boards WHERE board_id = $1`, [id]);
}

// --- Sharing ---------------------------------------------------------------

export interface Share {
	email: string;
	permission: "edit" | "view";
	grantedOn: string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function listShares(boardId: string): Promise<Share[]> {
	const rows = await sql<{
		email: string;
		permission: "edit" | "view";
		granted_on: string;
	}>(
		`SELECT email, permission, granted_on::text FROM board_shares
		 WHERE board_id = $1 ORDER BY granted_on`,
		[boardId],
	);
	return rows.map((r) => ({
		email: r.email,
		permission: r.permission,
		grantedOn: r.granted_on,
	}));
}

// Names one person on a board. Only its owner may, so a board cannot travel
// further than the person who made it decided. Answers whether the person was
// newly named, so they are told only once.
export async function shareBoard(
	identity: Identity,
	board: Board,
	email: string,
	permission: "edit" | "view",
): Promise<boolean> {
	if (board.permission !== "owner")
		throw new BoardError("Only the owner can share this board.", 403);
	const target = email.trim().toLowerCase();
	if (!emailPattern.test(target))
		throw new BoardError("That does not look like an email address.");
	if (target === identity.email.toLowerCase())
		throw new BoardError("You already have this board.");
	const existing = await sql(
		`SELECT 1 FROM board_shares WHERE board_id = $1 AND email = $2`,
		[board.id, target],
	);
	await sql(
		`INSERT INTO board_shares (board_id, email, permission, granted_by)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (board_id, email) DO UPDATE SET permission = EXCLUDED.permission`,
		[board.id, target, permission, identity.email.toLowerCase()],
	);
	void insertLog({
		recordType: "board",
		recordId: board.id,
		action: "share_board",
		changedBy: identity.email,
		newValue: `${target}:${permission}`,
	});
	return existing.length === 0;
}

export async function unshareBoard(
	identity: Identity,
	board: Board,
	email: string,
): Promise<void> {
	if (board.permission !== "owner")
		throw new BoardError(
			"Only the owner can change who has this board.",
			403,
		);
	await sql(`DELETE FROM board_shares WHERE board_id = $1 AND email = $2`, [
		board.id,
		email.trim().toLowerCase(),
	]);
	void insertLog({
		recordType: "board",
		recordId: board.id,
		action: "unshare_board",
		changedBy: identity.email,
		oldValue: email.trim().toLowerCase(),
	});
}
