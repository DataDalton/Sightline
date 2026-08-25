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
		   expires_on = EXCLUDED.expires_on`,
		[reportId, email, sessionId, JSON.stringify(state), String(leaseSeconds)],
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
		 WHERE report_id = $1 AND expires_on > now()
		 ORDER BY heartbeat_on DESC`,
		[reportId],
	);

	return rows.map((row) => ({
		userEmail: row.user_email,
		sessionId: row.session_id,
		state: row.state ?? {},
		ageSeconds: Math.round(Number(row.age_seconds) || 0),
		isSelf: row.session_id === sessionId,
	}));
}

// Called when a session leaves deliberately. The lease would expire anyway, so
// this only removes the delay.
export async function leave(
	reportId: string,
	sessionId: string,
): Promise<void> {
	await sql(
		`DELETE FROM presence WHERE report_id = $1 AND session_id = $2`,
		[reportId, sessionId],
	);
}
