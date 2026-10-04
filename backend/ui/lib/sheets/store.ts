import type { Identity } from "../auth/identity";
import { insertLog } from "../activityLog";
import { batchedRead } from "../data/batch";
import { sql, transaction } from "../data/lakebase";
import { noteOpened } from "../retention/opened";
import {
	cleanDefinition,
	emptyDefinition,
	limits,
	type SheetDefinition,
} from "./definition";

// Sheets as stored, who may open them, and the changes made to them.

export type SheetPermission = "owner" | "edit" | "view";

export interface SheetSummary {
	id: string;
	title: string;
	sourceKey: string;
	mode: SheetDefinition["mode"];
	ownerEmail: string;
	permission: SheetPermission;
	modifiedOn: string;
	modifiedBy: string;
	sharedWith: number;
	// Its owner marked it to be kept however long it goes unused.
	keep: boolean;
}

export interface Sheet extends SheetSummary {
	definition: SheetDefinition;
	version: number;
	// The layout this copy was read at, which a layout save names as its base.
	layoutVersion: number;
	// What notes are read again on. Version rises on every layout save and
	// every note, and the layout version on layout saves only, so the
	// difference rises with each note written. A field renamed under the
	// sheet raises it too, which reads the notes once more for nothing.
	notesVersion: number;
}

export class SheetError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

const maxTitle = 120;

interface Row {
	sheet_id: string;
	owner_email: string;
	title: string;
	definition: SheetDefinition;
	version: string;
	layout_version: string;
	modified_on: string;
	modified_by: string;
	permission: SheetPermission;
	shared_with: string;
	keep: boolean;
}

// Every sheet query reads through this, so what somebody may see is decided in
// one place: sheets they own, and sheets named to them. A sheet in the
// retention bin is visible to nobody here, its owner included. Its owner
// restores it through lib/retention.
//
// The two are bracketed together because callers append further conditions
// with AND. Without the brackets AND binds to the second alternative only, and
// "this sheet" read as "this sheet, or any sheet the caller owns".
const visible = `
	SELECT s.sheet_id::text, s.owner_email, s.title, s.definition,
	       s.version::text, s.layout_version::text, s.modified_on::text,
	       s.modified_by, s.keep,
	       CASE WHEN s.owner_email = $1 THEN 'owner'
	            ELSE (SELECT sh.permission FROM sheet_shares sh
	                  WHERE sh.sheet_id = s.sheet_id AND sh.email = $1)
	       END AS permission,
	       (SELECT count(*) FROM sheet_shares sh
	        WHERE sh.sheet_id = s.sheet_id)::text AS shared_with
	FROM sheets s
	WHERE s.removed_on IS NULL
	  AND (s.owner_email = $1
	    OR EXISTS (SELECT 1 FROM sheet_shares sh
	               WHERE sh.sheet_id = s.sheet_id AND sh.email = $1))`;

// Opening a sheet reads it once per request, so everyone opening one at
// about the same time is answered by one statement. The query is the one
// above, asked once for each reader and sheet given, with the reader in
// place of $1. See lib/data/batch.
const sheetReads = batchedRead<{ email: string; id: string }, Row | null>(
	async (asked) => {
		const rows = await sql<Row & { asker: string }>(
			`SELECT k.e AS asker, x.*
			 FROM unnest($1::text[], $2::uuid[]) AS k(e, id)
			 CROSS JOIN LATERAL (
			   ${visible.replaceAll("$1", "k.e")} AND s.sheet_id = k.id
			 ) x`,
			[asked.map((k) => k.email), asked.map((k) => k.id)],
		);
		return new Map(
			rows.map(({ asker, ...row }) => [
				readKey(asker, row.sheet_id),
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

function toSheet(row: Row): Sheet {
	return {
		id: row.sheet_id,
		title: row.title,
		sourceKey: row.definition?.sourceKey ?? "",
		mode: row.definition?.mode ?? "table",
		ownerEmail: row.owner_email,
		permission: row.permission,
		modifiedOn: row.modified_on,
		modifiedBy: row.modified_by,
		sharedWith: Number(row.shared_with),
		keep: row.keep === true,
		definition: cleanDefinition(row.definition),
		version: Number(row.version),
		layoutVersion: Number(row.layout_version),
		notesVersion: Number(row.version) - Number(row.layout_version),
	};
}

export function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

export async function listSheets(identity: Identity): Promise<SheetSummary[]> {
	const rows = await sql<Row>(`${visible} ORDER BY s.modified_on DESC`, [
		identity.email.toLowerCase(),
	]);
	return rows.map((r) => {
		const {
			definition: _d,
			version: _v,
			layoutVersion: _l,
			notesVersion: _n,
			...summary
		} = toSheet(r);
		return summary;
	});
}

// Null for a sheet that does not exist and for one the caller may not open,
// so asking is not a way to learn a sheet exists.
export async function getSheet(
	identity: Identity,
	id: string,
): Promise<Sheet | null> {
	if (!isUuid(id)) return null;
	const row = await sheetReads({ email: identity.email.toLowerCase(), id });
	if (!row) return null;
	// Any read by somebody who may open it counts as use for retention.
	noteOpened("sheet", id);
	return toSheet(row);
}

export async function createSheet(
	identity: Identity,
	title: string,
	definition: unknown,
): Promise<Sheet> {
	const email = identity.email.toLowerCase();
	const clean = definition ? cleanDefinition(definition) : emptyDefinition();
	const rows = await sql<{ sheet_id: string }>(
		`INSERT INTO sheets (owner_email, title, definition, modified_by)
		 VALUES ($1, $2, $3, $1)
		 RETURNING sheet_id::text`,
		[
			email,
			title.trim().slice(0, maxTitle) || "Untitled sheet",
			JSON.stringify(clean),
		],
	);
	return (await getSheet(identity, rows[0].sheet_id))!;
}

function mayEdit(sheet: Sheet): boolean {
	return sheet.permission === "owner" || sheet.permission === "edit";
}

// A change to the sheet itself. Refused when the caller's copy is behind, so
// two people changing the layout at once cannot silently undo each other: the
// second is told to take the newer version first. The check is against the
// layout version, which notes leave alone, since each note is its own row.
export async function updateSheet(
	identity: Identity,
	id: string,
	change: { title?: unknown; definition?: unknown; baseVersion?: unknown },
): Promise<Sheet> {
	const sheet = await getSheet(identity, id);
	if (!sheet) throw new SheetError("Sheet not found", 404);
	if (!mayEdit(sheet))
		throw new SheetError("This sheet is shared with you to view.", 403);

	const base = Number(change.baseVersion);
	const title =
		typeof change.title === "string"
			? change.title.trim().slice(0, maxTitle) || sheet.title
			: sheet.title;
	const definition =
		change.definition !== undefined
			? cleanDefinition(change.definition)
			: sheet.definition;

	const rows = await sql<{ version: string }>(
		`UPDATE sheets SET title = $3, definition = $4, version = version + 1,
		   layout_version = layout_version + 1,
		   modified_on = now(), modified_by = $5
		 WHERE sheet_id = $1 AND removed_on IS NULL
		   AND ($2::bigint IS NULL OR layout_version = $2)
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
		throw new SheetError(
			"Somebody else changed this sheet a moment ago. It has been reloaded with their change.",
			409,
		);
	}
	return (await getSheet(identity, id))!;
}

export async function deleteSheet(
	identity: Identity,
	id: string,
): Promise<void> {
	const sheet = await getSheet(identity, id);
	if (!sheet) throw new SheetError("Sheet not found", 404);
	if (sheet.permission !== "owner") {
		// Somebody it was shared with removes it from their own list.
		await sql(
			`DELETE FROM sheet_shares WHERE sheet_id = $1 AND email = $2`,
			[id, identity.email.toLowerCase()],
		);
		return;
	}
	await sql(`DELETE FROM sheets WHERE sheet_id = $1`, [id]);
}

// --- Notes -----------------------------------------------------------------

export interface Note {
	rowKey: string;
	noteId: string;
	value: string;
	modifiedBy: string;
	modifiedOn: string;
}

export const maxNoteLength = 4000;

export async function notesFor(
	sheetId: string,
	rowKeys: string[],
): Promise<Note[]> {
	if (rowKeys.length === 0) return [];
	const rows = await sql<{
		row_key: string;
		note_id: string;
		value: string;
		modified_by: string;
		modified_on: string;
	}>(
		`SELECT row_key, note_id, value, modified_by, modified_on::text
		 FROM sheet_cells WHERE sheet_id = $1 AND row_key = ANY($2::text[])`,
		[sheetId, rowKeys],
	);
	return rows.map((r) => ({
		rowKey: r.row_key,
		noteId: r.note_id,
		value: r.value,
		modifiedBy: r.modified_by,
		modifiedOn: r.modified_on,
	}));
}

// Writes or clears one note. The caller has already checked the row is one
// they can see.
export async function writeNote(
	identity: Identity,
	sheet: Sheet,
	rowKey: string,
	noteId: string,
	value: string,
): Promise<number> {
	if (!mayEdit(sheet))
		throw new SheetError("This sheet is shared with you to view.", 403);
	if (!sheet.definition.notes.some((n) => n.id === noteId)) {
		throw new SheetError("That note column is not on the sheet.");
	}
	const text = value.slice(0, maxNoteLength);
	return transaction(async (client) => {
		if (text.trim() === "") {
			await client.query(
				`DELETE FROM sheet_cells WHERE sheet_id = $1 AND row_key = $2 AND note_id = $3`,
				[sheet.id, rowKey, noteId],
			);
		} else {
			await client.query(
				`INSERT INTO sheet_cells (sheet_id, row_key, note_id, value, modified_by)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (sheet_id, row_key, note_id) DO UPDATE SET
				   value = EXCLUDED.value, modified_by = EXCLUDED.modified_by,
				   modified_on = now()`,
				[sheet.id, rowKey, noteId, text, identity.email.toLowerCase()],
			);
		}
		const bumped = await client.query<{ version: string }>(
			`UPDATE sheets SET version = version + 1 WHERE sheet_id = $1
			 RETURNING version::text`,
			[sheet.id],
		);
		return Number(bumped.rows[0]?.version ?? 0);
	});
}

// --- Sharing ---------------------------------------------------------------

export interface Share {
	email: string;
	permission: "edit" | "view";
	grantedOn: string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function listShares(sheetId: string): Promise<Share[]> {
	const rows = await sql<{
		email: string;
		permission: "edit" | "view";
		granted_on: string;
	}>(
		`SELECT email, permission, granted_on::text FROM sheet_shares
		 WHERE sheet_id = $1 ORDER BY granted_on`,
		[sheetId],
	);
	return rows.map((r) => ({
		email: r.email,
		permission: r.permission,
		grantedOn: r.granted_on,
	}));
}

// Names one person on a sheet. Only its owner may, so a sheet cannot travel
// further than the person who made it decided.
export async function shareSheet(
	identity: Identity,
	sheet: Sheet,
	email: string,
	permission: "edit" | "view",
): Promise<boolean> {
	if (sheet.permission !== "owner") {
		throw new SheetError("Only the owner can share this sheet.", 403);
	}
	const target = email.trim().toLowerCase();
	if (!emailPattern.test(target)) {
		throw new SheetError("That does not look like an email address.");
	}
	if (target === identity.email.toLowerCase()) {
		throw new SheetError("You already have this sheet.");
	}
	const existing = await sql(
		`SELECT 1 FROM sheet_shares WHERE sheet_id = $1 AND email = $2`,
		[sheet.id, target],
	);
	const count = await sql<{ n: string }>(
		`SELECT count(*)::text AS n FROM sheet_shares WHERE sheet_id = $1`,
		[sheet.id],
	);
	if (existing.length === 0 && Number(count[0]?.n ?? 0) >= 100) {
		throw new SheetError("A sheet can be shared with at most 100 people.");
	}
	await sql(
		`INSERT INTO sheet_shares (sheet_id, email, permission, granted_by)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (sheet_id, email) DO UPDATE SET permission = EXCLUDED.permission`,
		[sheet.id, target, permission, identity.email.toLowerCase()],
	);
	void insertLog({
		recordType: "sheet",
		recordId: sheet.id,
		action: "share_sheet",
		changedBy: identity.email,
		newValue: `${target}:${permission}`,
	});
	return existing.length === 0;
}

export async function unshareSheet(
	identity: Identity,
	sheet: Sheet,
	email: string,
): Promise<void> {
	if (sheet.permission !== "owner") {
		throw new SheetError(
			"Only the owner can change who has this sheet.",
			403,
		);
	}
	await sql(`DELETE FROM sheet_shares WHERE sheet_id = $1 AND email = $2`, [
		sheet.id,
		email.trim().toLowerCase(),
	]);
	void insertLog({
		recordType: "sheet",
		recordId: sheet.id,
		action: "unshare_sheet",
		changedBy: identity.email,
		oldValue: email.trim().toLowerCase(),
	});
}

// --- Who has it open -------------------------------------------------------

export interface Present {
	email: string;
	sessionId: string;
	// The cell they have selected, so it can be marked for everybody else.
	cell: { row: string; column: string } | null;
	self: boolean;
}

const leaseSeconds = 30;

// What a beat from an open sheet answers: the sheet's version and who last
// saved it, and everyone who has it open. Null when the caller may not open
// the sheet.
export interface Beat {
	version: number;
	modifiedBy: string;
	present: Present[];
}

interface BeatKey {
	email: string;
	sheetId: string;
	sessionId: string;
	state: string;
}

interface BeatRow {
	kind: "sheet" | "beat" | "listed";
	sheet_id: string;
	session_id: string;
	user_email: string;
	state: { cell?: { row: string; column: string } } | null;
	version: string | null;
	modified_by: string | null;
}

// Every open sheet beats every few seconds, so the beats arriving together
// are answered by one statement: who may open each sheet, its version, the
// renewed place of each session, and who else is there. See lib/data/batch.
//
// Each session's row is read as of before this statement's own writes, so a
// session's renewed row, as the write returned it, replaces the one read.
const beats = batchedRead<BeatKey, Beat | null>(
	async (keys) => {
		// One renewal per session in a statement. Two people sending the same
		// session id for one sheet are answered as unable to open it, since
		// only one of them can own the session.
		const claimed = new Map<string, BeatKey>();
		for (const key of keys) {
			const session = `${key.sheetId}|${key.sessionId}`;
			if (!claimed.has(session)) claimed.set(session, key);
		}
		const sent = [...claimed.values()];
		const rows = await sql<BeatRow>(
			`WITH k AS (
			   SELECT * FROM unnest($1::text[], $2::uuid[], $3::text[], $4::jsonb[])
			     AS k(email, sheet_id, session_id, state)
			 ),
			 allowed AS (
			   SELECT k.*, s.version, s.modified_by
			   FROM k
			   JOIN sheets s ON s.sheet_id = k.sheet_id AND s.removed_on IS NULL
			   WHERE s.owner_email = k.email
			      OR EXISTS (SELECT 1 FROM sheet_shares sh
			                 WHERE sh.sheet_id = s.sheet_id AND sh.email = k.email)
			 ),
			 beat AS (
			   INSERT INTO sheet_presence
			     (sheet_id, session_id, user_email, state, expires_on)
			   SELECT sheet_id, session_id, email, state,
			          now() + make_interval(secs => $5)
			   FROM allowed
			   ON CONFLICT (sheet_id, session_id) DO UPDATE SET
			     state = EXCLUDED.state, expires_on = EXCLUDED.expires_on
			   WHERE sheet_presence.left_on IS NULL
			     AND sheet_presence.user_email = EXCLUDED.user_email
			   RETURNING sheet_id, session_id, user_email, state
			 )
			 SELECT 'sheet' AS kind, a.sheet_id::text, a.session_id,
			        a.email AS user_email, NULL::jsonb AS state,
			        a.version::text AS version, a.modified_by
			 FROM allowed a
			 UNION ALL
			 SELECT 'beat', b.sheet_id::text, b.session_id, b.user_email, b.state,
			        NULL, NULL
			 FROM beat b
			 UNION ALL
			 SELECT 'listed', p.sheet_id::text, p.session_id, p.user_email,
			        p.state, NULL, NULL
			 FROM sheet_presence p
			 WHERE p.sheet_id IN (SELECT sheet_id FROM allowed)
			   AND p.expires_on > now() AND p.left_on IS NULL`,
			[
				sent.map((k) => k.email),
				sent.map((k) => k.sheetId),
				sent.map((k) => k.sessionId),
				sent.map((k) => k.state),
				leaseSeconds,
			],
		);

		const sessions = new Map<string, Map<string, BeatRow>>();
		const sheets = new Map<string, BeatRow>();
		for (const row of rows) {
			if (row.kind === "sheet") {
				sheets.set(
					`${row.sheet_id}|${row.session_id}|${row.user_email}`,
					row,
				);
				continue;
			}
			let held = sessions.get(row.sheet_id);
			if (!held) sessions.set(row.sheet_id, (held = new Map()));
			// A renewal replaces what was read before it.
			if (row.kind === "beat" || !held.has(row.session_id)) {
				held.set(row.session_id, row);
			}
		}

		const answers = new Map<string, Beat | null>();
		for (const key of sent) {
			const sheet = sheets.get(
				`${key.sheetId.toLowerCase()}|${key.sessionId}|${key.email}`,
			);
			if (!sheet) continue;
			answers.set(beatKeyOf(key), {
				version: Number(sheet.version),
				modifiedBy: sheet.modified_by ?? "",
				present: [
					...(sessions.get(sheet.sheet_id)?.values() ?? []),
				].map((r) => ({
					email: r.user_email,
					sessionId: r.session_id,
					cell: r.state?.cell ?? null,
					self: r.session_id === key.sessionId,
				})),
			});
		}
		return answers;
	},
	(key) => beatKeyOf(key),
	null,
);

function beatKeyOf(key: BeatKey): string {
	return JSON.stringify([
		key.email,
		key.sheetId.toLowerCase(),
		key.sessionId,
	]);
}

// Renews the caller's place on an open sheet and says who else is there.
// A session row belongs to the person who first wrote it, so nobody can move
// or mark somebody else's session by sending its id.
export async function beatSheet(
	identity: Identity,
	sheetId: string,
	sessionId: string,
	cell: unknown,
): Promise<Beat | null> {
	if (!isUuid(sheetId)) return null;
	const c = (cell ?? null) as { row?: unknown; column?: unknown } | null;
	const state =
		c && typeof c.row === "string" && typeof c.column === "string"
			? {
					cell: {
						row: c.row.slice(0, 2000),
						column: c.column.slice(0, 200),
					},
				}
			: {};
	const answer = await beats({
		email: identity.email.toLowerCase(),
		sheetId,
		sessionId: sessionId.slice(0, 64),
		state: JSON.stringify(state),
	});
	// An open sheet counts as use for retention, as any read of it does.
	if (answer) noteOpened("sheet", sheetId);
	return answer;
}

// Marked as left rather than deleted, so a heartbeat already on its way when
// the page closed cannot list the session again. See leave in
// lib/platform/presence.
export async function leaveSheet(
	identity: Identity,
	sheetId: string,
	sessionId: string,
): Promise<void> {
	await sql(
		`INSERT INTO sheet_presence
		   (sheet_id, session_id, user_email, expires_on, left_on)
		 VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval, now())
		 ON CONFLICT (sheet_id, session_id) DO UPDATE SET
		   left_on = now(),
		   expires_on = EXCLUDED.expires_on
		 WHERE sheet_presence.user_email = EXCLUDED.user_email`,
		[
			sheetId,
			sessionId.slice(0, 64),
			identity.email.toLowerCase(),
			String(leaseSeconds),
		],
	);
}

export { limits };
