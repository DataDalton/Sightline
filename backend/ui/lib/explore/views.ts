import { sql } from "../data/lakebase";
import { cleanState, type ExploreState } from "./state";

// Explorations people saved to come back to.
//
// Private to whoever saved them, matched on their email in lowercase, so an id
// guessed or copied from somebody else's address opens nothing. Sharing is the
// address itself, which carries the exploration and runs it under the reader's
// own access.
//
// A view in the retention bin is left out of every read and write here. Its
// owner restores it through lib/retention.

export interface SavedView {
	id: string;
	name: string;
	state: ExploreState;
	modifiedOn: string;
	// Its owner marked it to be kept however long it goes unused.
	keep: boolean;
}

const maxName = 120;

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function owner(email: string): string {
	return email.trim().toLowerCase();
}

interface Row {
	view_id: string;
	name: string;
	state: unknown;
	modified_on: string;
	keep: boolean;
}

function toView(row: Row): SavedView | null {
	const state = cleanState(row.state);
	return state
		? {
				id: row.view_id,
				name: row.name,
				state,
				modifiedOn: new Date(row.modified_on).toISOString(),
				keep: row.keep === true,
			}
		: null;
}

export async function listViews(email: string): Promise<SavedView[]> {
	const rows = await sql<Row>(
		`SELECT view_id::text AS view_id, name, state, modified_on, keep
		 FROM explore_views
		 WHERE owner_email = $1 AND removed_on IS NULL
		 ORDER BY modified_on DESC`,
		[owner(email)],
	);
	return rows.map(toView).filter((v): v is SavedView => v !== null);
}

export async function createView(
	email: string,
	name: string,
	state: ExploreState,
): Promise<SavedView | null> {
	const rows = await sql<Row>(
		`INSERT INTO explore_views (owner_email, name, state)
		 VALUES ($1, $2, $3::jsonb)
		 RETURNING view_id::text AS view_id, name, state, modified_on, keep`,
		[
			owner(email),
			name.trim().slice(0, maxName) || "Untitled",
			JSON.stringify(state),
		],
	);
	return rows[0] ? toView(rows[0]) : null;
}

// Renames it, replaces what it holds, or both. Only the owner's row is touched.
export async function updateView(
	email: string,
	id: string,
	change: { name?: string; state?: ExploreState },
): Promise<SavedView | null> {
	if (!uuidPattern.test(id)) return null;
	const rows = await sql<Row>(
		`UPDATE explore_views
		 SET name = COALESCE($3, name),
		     state = COALESCE($4::jsonb, state),
		     modified_on = now()
		 WHERE view_id = $1 AND owner_email = $2 AND removed_on IS NULL
		 RETURNING view_id::text AS view_id, name, state, modified_on, keep`,
		[
			id,
			owner(email),
			change.name?.trim().slice(0, maxName) || null,
			change.state ? JSON.stringify(change.state) : null,
		],
	);
	return rows[0] ? toView(rows[0]) : null;
}

export async function deleteView(email: string, id: string): Promise<boolean> {
	if (!uuidPattern.test(id)) return false;
	const rows = await sql<{ view_id: string }>(
		`DELETE FROM explore_views
		 WHERE view_id = $1 AND owner_email = $2 AND removed_on IS NULL
		 RETURNING view_id`,
		[id, owner(email)],
	);
	return rows.length > 0;
}
