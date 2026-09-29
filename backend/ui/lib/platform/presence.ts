import { sql } from "../data/lakebase";

// Who else is in a report right now.
//
// Presence is expressed as a lease rather than a connection: a session writes a
// row with an expiry and refreshes it on a heartbeat. A session that dies, a
// laptop that sleeps, or a replica that is killed all stop refreshing, and the
// row ages out on its own.
//
// A disconnect signal would be simpler but is not reliable here. The app runs
// on several replicas behind a proxy and Lakebase closes idle connections, so
// there is no single place that reliably observes a session ending.

// How long a heartbeat keeps a session listed. Long enough to survive a slow
// network round trip, short enough that a closed tab disappears quickly.
const leaseSeconds = 45;

export interface PresenceState {
	// What the person is looking at or editing, for cursors and highlights.
	pageId?: string | null;
	visualId?: string | null;
	editing?: boolean;
}

export interface PresentUser {
	userEmail: string;
	sessionId: string;
	state: PresenceState;
	// Seconds since the last heartbeat, so the UI can fade a stale participant
	// rather than dropping them abruptly.
	ageSeconds: number;
	isSelf: boolean;
}

// Longest session id and id-like value kept. Enough for any generated id,
// short enough that a heartbeat cannot be used to store arbitrary text.
const maxIdLength = 64;

function sessionKey(sessionId: string): string {
	return String(sessionId).slice(0, maxIdLength);
}

// Only the fields a cursor needs, each bounded. The state arrives from a
// client and is shown to everybody else in the report, so nothing else in it
// is stored.
function boundedState(state: PresenceState): PresenceState {
	const id = (value: unknown): string | null =>
		typeof value === "string" ? value.slice(0, maxIdLength) : null;
	const out: PresenceState = {};
	if (state && typeof state === "object") {
		if (state.pageId !== undefined) out.pageId = id(state.pageId);
		if (state.visualId !== undefined) out.visualId = id(state.visualId);
		if (typeof state.editing === "boolean") out.editing = state.editing;
	}
	return out;
}

// A session row belongs to the person who first wrote it. Every write matches
// on the email as well as the session id, so nobody can move, mark or relabel
// somebody else's session by sending its id.
export async function heartbeat(
	reportId: string,
	email: string,
	sessionId: string,
	state: PresenceState = {},
): Promise<void> {
	await sql(
		`INSERT INTO presence
		   (report_id, user_email, session_id, state, heartbeat_on, expires_on)
		 VALUES ($1, $2, $3, $4, now(), now() + ($5 || ' seconds')::interval)
		 ON CONFLICT (report_id, session_id) DO UPDATE SET
		   state = EXCLUDED.state,
		   heartbeat_on = now(),
		   expires_on = EXCLUDED.expires_on
		 WHERE presence.left_on IS NULL
		   AND presence.user_email = EXCLUDED.user_email`,
		[
			reportId,
			email,
			sessionKey(sessionId),
			JSON.stringify(boundedState(state)),
			String(leaseSeconds),
		],
	);
}

export async function listPresent(
	reportId: string,
	sessionId: string,
): Promise<PresentUser[]> {
	const rows = await sql<{
		user_email: string;
		session_id: string;
		state: PresenceState;
		age_seconds: string;
	}>(
		`SELECT user_email, session_id, state,
		        EXTRACT(EPOCH FROM (now() - heartbeat_on))::text AS age_seconds
		 FROM presence
		 WHERE report_id = $1 AND expires_on > now() AND left_on IS NULL
		 ORDER BY heartbeat_on DESC`,
		[reportId],
	);

	return rows.map((row) => ({
		userEmail: row.user_email,
		sessionId: row.session_id,
		state: row.state ?? {},
		ageSeconds: Math.round(Number(row.age_seconds) || 0),
		isSelf: row.session_id === sessionKey(sessionId),
	}));
}

// Called when a session leaves deliberately. The lease would expire anyway, so
// this only removes the delay.
//
// Marked as left rather than deleted. A page being reloaded often has a
// heartbeat already on its way, and requests do not arrive in the order they
// were sent: a heartbeat landing after a delete wrote the row straight back,
// and the session stayed listed beside the one the reload started. A marked
// row refuses that heartbeat, and is swept once its lease is up, by which time
// nothing sent before the leave can still be arriving. A leave that lands
// before the session's first heartbeat writes the mark for it to meet.
export async function leave(
	reportId: string,
	email: string,
	sessionId: string,
): Promise<void> {
	await sql(
		`INSERT INTO presence
		   (report_id, user_email, session_id, heartbeat_on, expires_on, left_on)
		 VALUES ($1, $2, $3, now(), now() + ($4 || ' seconds')::interval, now())
		 ON CONFLICT (report_id, session_id) DO UPDATE SET
		   left_on = now(),
		   expires_on = EXCLUDED.expires_on
		 WHERE presence.user_email = EXCLUDED.user_email`,
		[reportId, email, sessionKey(sessionId), String(leaseSeconds)],
	);
}
