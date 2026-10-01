import type { Identity } from "../auth/identity";
import { insertLog } from "../activityLog";
import { sql, transaction } from "../data/lakebase";
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
}

// Every board query reads through this, so what somebody may open is decided
// in one place: boards they own, and boards named to them. Bracketed because
// callers append further conditions with AND.
const visible = `
	SELECT b.board_id::text, b.owner_email, b.title, b.definition,
	       b.version::text, b.modified_on::text, b.modified_by,
	       CASE WHEN b.owner_email = $1 THEN 'owner'
	            ELSE (SELECT s.permission FROM board_shares s
	                  WHERE s.board_id = b.board_id AND s.email = $1)
	       END AS permission,
	       (SELECT count(*) FROM board_shares s
	        WHERE s.board_id = b.board_id)::text AS shared_with
	FROM boards b
	WHERE (b.owner_email = $1
	    OR EXISTS (SELECT 1 FROM board_shares s
	               WHERE s.board_id = b.board_id AND s.email = $1))`;

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

export async function listBoards(identity: Identity): Promise<BoardSummary[]> {
	const rows = await sql<Row>(`${visible} ORDER BY b.modified_on DESC`, [
		identity.email.toLowerCase(),
	]);
	return rows.map((r) => {
		const { definition: _d, version: _v, ...summary } = toBoard(r);
		return summary;
	});
}

export async function getBoard(
	identity: Identity,
	id: string,
): Promise<Board | null> {
	if (!isUuid(id)) return null;
	const rows = await sql<Row>(`${visible} AND b.board_id = $2`, [
		identity.email.toLowerCase(),
		id,
	]);
	return rows[0] ? toBoard(rows[0]) : null;
}

function mayEdit(board: Board): boolean {
	return board.permission === "owner" || board.permission === "edit";
}

export async function createBoard(
	identity: Identity,
	title: unknown,
	items: unknown,
): Promise<Board> {
	const email = identity.email.toLowerCase();
	const definition = emptyBoard();
	if (Array.isArray(items)) appendTo(definition, items);
	const rows = await sql<{ board_id: string }>(
		`INSERT INTO boards (owner_email, title, definition, modified_by)
		 VALUES ($1, $2, $3, $1)
		 RETURNING board_id::text`,
		[
			email,
			cleanTitle(title) || "Untitled board",
			JSON.stringify(definition),
		],
	);
	return (await getBoard(identity, rows[0].board_id))!;
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
// two people arranging it at once cannot silently undo each other.
export async function updateBoard(
	identity: Identity,
	id: string,
	change: { title?: unknown; definition?: unknown; baseVersion?: unknown },
): Promise<Board> {
	const board = await getBoard(identity, id);
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
	const rows = await sql<{ version: string }>(
		`UPDATE boards SET title = $3, definition = $4, version = version + 1,
		   modified_on = now(), modified_by = $5
		 WHERE board_id = $1 AND ($2::bigint IS NULL OR version = $2)
		 RETURNING version::text`,
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
	return (await getBoard(identity, id))!;
}

// Adds items from elsewhere, such as a visual from a report. Read and written
// in one transaction under a row lock, so two additions at once both land and
// neither needs the caller to know the board's version.
export async function addItems(
	identity: Identity,
	id: string,
	items: unknown,
): Promise<{ board: Board; added: BoardItem[] }> {
	const board = await getBoard(identity, id);
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
		await client.query(
			`UPDATE boards SET definition = $2, version = version + 1,
			   modified_on = now(), modified_by = $3
			 WHERE board_id = $1`,
			[id, JSON.stringify(definition), identity.email.toLowerCase()],
		);
		return placed;
	});
	if (added.length === 0) throw new BoardError("Nothing to add.");
	return { board: (await getBoard(identity, id))!, added };
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
