import { sql } from "../data/lakebase";

// When a sheet, board or saved exploration was last opened, for retention.
//
// Written at most about once a day per item, so opening one does not cost a
// write each time. Each replica remembers what it wrote recently and skips
// the statement altogether, and the statement itself only writes when the
// stored time is older than a day, which covers the other replicas. Nothing
// here is waited for, and a failure is logged rather than reported to the
// person opening the item.

export type OpenedKind = "sheet" | "board" | "exploreView";

const tables: Record<OpenedKind, { table: string; key: string }> = {
	sheet: { table: "sheets", key: "sheet_id" },
	board: { table: "boards", key: "board_id" },
	exploreView: { table: "explore_views", key: "view_id" },
};

// How long this replica skips an item it already stamped.
const skipMs = 12 * 60 * 60 * 1000;

// The most entries remembered before the oldest half is dropped.
const maxRemembered = 20000;

const stamped = new Map<string, number>();

function remember(key: string, now: number): void {
	stamped.delete(key);
	stamped.set(key, now);
	if (stamped.size <= maxRemembered) return;
	// Insertion order is oldest first, since each stamp is moved to the end.
	let drop = stamped.size - maxRemembered / 2;
	for (const old of stamped.keys()) {
		if (drop-- <= 0) break;
		stamped.delete(old);
	}
}

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Records an open of an item the caller has already checked may be opened.
export function noteOpened(kind: OpenedKind, id: string): void {
	if (!uuidPattern.test(id)) return;
	const key = `${kind}:${id.toLowerCase()}`;
	const now = Date.now();
	const last = stamped.get(key);
	if (last !== undefined && now - last < skipMs) return;
	remember(key, now);
	const { table, key: column } = tables[kind];
	void sql(
		`UPDATE ${table} SET last_opened_on = now()
		 WHERE ${column} = $1 AND removed_on IS NULL
		   AND (last_opened_on IS NULL
		        OR last_opened_on < now() - interval '20 hours')`,
		[id],
	).catch((error) => {
		stamped.delete(key);
		console.warn(`Could not record that a ${kind} was opened:`, error);
	});
}

// Records an open of a saved exploration by its owner, the only person who
// may open one. Answers whether the view exists for them, so asking is not a
// way to learn that somebody else's does.
export async function noteExploreViewOpened(
	email: string,
	id: string,
): Promise<boolean> {
	if (!uuidPattern.test(id)) return false;
	const rows = await sql<{ view_id: string }>(
		`SELECT view_id::text AS view_id FROM explore_views
		 WHERE view_id = $1 AND owner_email = $2 AND removed_on IS NULL`,
		[id, email.trim().toLowerCase()],
	);
	if (rows.length === 0) return false;
	noteOpened("exploreView", id);
	return true;
}
