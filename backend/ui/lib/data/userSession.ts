import { DBSQLClient } from "@databricks/sql";
import type IDBSQLSession from "@databricks/sql/dist/contracts/IDBSQLSession";
import type IOperation from "@databricks/sql/dist/contracts/IOperation";
import type { DBSQLParameterValue } from "@databricks/sql/dist/DBSQLParameter";
import OperationStateError, {
	OperationStateErrorCode,
} from "@databricks/sql/dist/errors/OperationStateError";
import { resolveWarehousePath, serverHostname } from "../runtime";
import type { QueryParams, Row } from "./types";

// Every query that touches user-facing data runs through here, under the
// caller forwarded token. That is what makes Unity Catalog row filters and
// column masks apply: the warehouse evaluates them for the real user, not for
// the app service principal.
//
// Nothing else queries user-facing data. The service principal holds SELECT on
// the catalogue so the row filter walk can read it, so the separation is a
// property of which code runs where rather than of what that principal may
// reach. See lib/data/appSession.

// Sessions are pooled per token so a burst of queries from one user reuses a
// single warehouse connection instead of reconnecting each time. Tokens are
// short-lived and rotate, so idle entries are swept quickly.
interface PooledSession {
	session: Promise<IDBSQLSession>;
	client: DBSQLClient;
	lastUsed: number;
	// The token the connection was opened with. The connection keeps it for
	// its whole life, so once it expires every statement on the session fails
	// even though the caller already holds a newer one.
	token: string;
	// Statements running on the session. A busy session is never evicted,
	// because closing it would fail the statements still reading from it.
	active: number;
}

const pool = new Map<string, PooledSession>();

// Sessions idle longer than this are closed. Kept well under the typical
// forwarded-token lifetime so a stale token is discarded rather than reused.
const idleTimeoutMs = 5 * 60 * 1000;
const maxPooledSessions = 200;

// The share of the pool speculative warming may fill. Past this, slots are kept
// for readers who are actually querying.
const warmHeadroom = 0.75;

// Sessions are keyed by the caller's own address rather than by their token.
//
// The token was the obvious key and it is the wrong one, because it changes
// while the person does not. A forwarded token rotates, and every rotation
// orphaned a perfectly good session and opened another, so a reader who stayed
// all morning kept paying to connect. At any size where the pool is contended
// that turns it from a cache into a queue of connects.
//
// A hash of the token was considered and rejected, and this is not that: a
// hash can collide and hand one person a session opened under somebody else's
// token, while an address cannot collide with a different person's. The token
// is still what opens the session and still what the warehouse evaluates
// is_member against, so nothing about whose rows come back changes. The key
// never leaves this module and is never logged.

// Removes the key only while it still holds this entry. A query that fails on
// a session already replaced would otherwise drop the replacement from the
// pool without closing it, leaving its warehouse connection open with nothing
// left to close it.
async function closeEntry(key: string, entry: PooledSession): Promise<void> {
	if (pool.get(key) === entry) pool.delete(key);
	try {
		const session = await entry.session;
		await session.close();
	} catch {
		// A session that fails to close is already unusable.
	}
	try {
		await entry.client.close();
	} catch {
		// Same.
	}
}

// How often idle sessions are looked for. On a timer rather than on the query
// path: sweeping there walked the whole pool once per statement, and sorted it
// whenever the pool was full, to find entries whose staleness is a function of
// elapsed time and not of anything the query did.
const sweepIntervalMs = 30 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function sweepIdle(): void {
	const now = Date.now();
	for (const [key, entry] of pool) {
		if (entry.active === 0 && now - entry.lastUsed > idleTimeoutMs) {
			void closeEntry(key, entry);
		}
	}
	// Hard ceiling so a spike in distinct tokens cannot exhaust warehouse
	// connections. Evicts least-recently-used first, and only sessions with
	// nothing running. Busy sessions are left to finish, so the pool can sit
	// over the ceiling until they do.
	if (pool.size > maxPooledSessions) {
		const idle = Array.from(pool.entries())
			.filter(([, entry]) => entry.active === 0)
			.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		for (const [key, entry] of idle.slice(
			0,
			pool.size - maxPooledSessions,
		)) {
			void closeEntry(key, entry);
		}
	}
}

// Started on first use rather than at import, so a module instance that never
// queries never holds a timer.
function ensureSweeping(): void {
	if (sweepTimer) return;
	sweepTimer = setInterval(sweepIdle, sweepIntervalMs);
	sweepTimer.unref?.();
}

// The ceiling is the one thing that cannot wait for the timer: past it the pool
// is holding more warehouse connections than it is allowed to.
function enforceCeiling(): void {
	if (pool.size <= maxPooledSessions) return;
	sweepIdle();
}

// Takes the caller's session for one statement, opening it if needed. The
// statement is counted as running until release is called.
function acquire(key: string, token: string): PooledSession {
	ensureSweeping();

	let entry = pool.get(key);
	if (!entry) {
		entry = openSession(token);
		pool.set(key, entry);
		// Counted before the ceiling is enforced, so the new session is never
		// the one evicted to make room.
		entry.active++;
		enforceCeiling();
	} else {
		entry.active++;
	}
	entry.lastUsed = Date.now();
	return entry;
}

// Marks one statement on the session as finished. Idle time counts from here,
// so a long statement does not leave its session looking idle the moment it
// ends.
function release(entry: PooledSession): void {
	entry.active = Math.max(0, entry.active - 1);
	entry.lastUsed = Date.now();
}

function openSession(token: string): PooledSession {
	// Resolved per session rather than read once at startup, so a warehouse
	// changed in the administration settings takes effect on the next session
	// instead of at the next restart.
	const path = resolveWarehousePath();

	if (!serverHostname || !path) {
		throw new Error(
			"No SQL warehouse available. Bind a warehouse resource in app.yaml, " +
				"set one in Administration -> Configuration, or set " +
				"DATABRICKS_HTTP_PATH for local development.",
		);
	}

	const client = new DBSQLClient();
	const session = (async () => {
		await client.connect({
			host: serverHostname,
			path,
			token,
		});
		return client.openSession();
	})();

	return { session, client, lastUsed: Date.now(), token, active: 0 };
}

// Whether an error is the statement itself failing, such as a query the
// warehouse refused, rather than the session or its token. The driver reports
// a statement that ran and ended in error with the ERROR operation state.
function statementFailed(error: unknown): boolean {
	return (
		error instanceof OperationStateError &&
		error.errorCode === OperationStateErrorCode.Error
	);
}

// Runs one statement on the caller's pooled session.
//
// A failure of the session itself, rather than of the statement, drops the
// session so the next call reconnects. Where that session was opened with a
// different token than the one the caller now holds, the failure is most
// likely the old token expiring, so the statement is run once more on a
// session opened with the current token. canRetry says whether the attempt
// that failed had already handed rows on, in which case running again would
// hand them twice and the error is passed on instead.
async function onSession<T>(
	key: string,
	token: string,
	run: (session: IDBSQLSession) => Promise<T>,
	canRetry: () => boolean,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const entry = acquire(key, token);
		try {
			return await run(await entry.session);
		} catch (error) {
			// An expired token surfaces here and must not be retried against
			// the same dead session. A statement the warehouse ran and refused
			// leaves the session healthy, and closing it would fail every
			// other query the same reader has running on it.
			if (statementFailed(error)) throw error;
			void closeEntry(key, entry);
			const rotated = entry.token !== token;
			if (attempt > 0 || !rotated || !canRetry()) throw error;
		} finally {
			release(entry);
		}
	}
}

// Runs a query as the given user. The token is passed per call rather than
// captured once, because a forwarded token goes stale across long-lived
// connections and websocket reconnects.
export async function queryAsUser(
	userToken: string,
	sql: string,
	params?: QueryParams,
	// Who is asking. Sessions are pooled against this rather than the token, so
	// a rotated token reuses the session the same person already has.
	sessionKey?: string,
): Promise<Row[]> {
	if (!userToken) {
		throw new Error("A user token is required to query user-facing data.");
	}

	const key = sessionKey ?? userToken;

	const namedParameters = params as
		| Record<string, DBSQLParameterValue>
		| undefined;

	// fetchAll hands nothing on until it has every row, so a failed attempt
	// can always be run again.
	return onSession(
		key,
		userToken,
		async (session) => {
			let operation: IOperation | null = null;
			try {
				operation = await session.executeStatement(
					sql,
					namedParameters ? { namedParameters } : undefined,
				);
				return (await operation.fetchAll()) as Row[];
			} finally {
				if (operation) {
					await operation.close().catch(() => {});
				}
			}
		},
		() => true,
	);
}

// Runs a query and hands back its rows in batches.
//
// fetchAll materializes the whole result before the caller sees any of it,
// which is right for a visual and wrong for an export: fifty thousand rows is
// tens of megabytes resident, and the caller only ever needs the batch it is
// writing. onBatch is awaited, so a slow consumer applies backpressure rather
// than letting batches pile up behind it.
export async function queryAsUserBatches(
	userToken: string,
	sql: string,
	params: QueryParams | undefined,
	batchSize: number,
	onBatch: (rows: Row[]) => Promise<void>,
	sessionKey?: string,
): Promise<number> {
	if (!userToken) {
		throw new Error("A user token is required to query user-facing data.");
	}

	const key = sessionKey ?? userToken;

	const namedParameters = params as
		| Record<string, DBSQLParameterValue>
		| undefined;

	let total = 0;
	return onSession(
		key,
		userToken,
		async (session) => {
			let operation: IOperation | null = null;
			try {
				operation = await session.executeStatement(
					sql,
					namedParameters ? { namedParameters } : undefined,
				);

				// hasMoreRows is only meaningful after a fetch, so this is a
				// do-while rather than a while. Asking first would skip a
				// single-batch result.
				do {
					const rows = (await operation.fetchChunk({
						maxRows: batchSize,
					})) as Row[];
					if (rows.length > 0) {
						total += rows.length;
						await onBatch(rows);
					}
				} while (await operation.hasMoreRows());

				return total;
			} finally {
				if (operation) {
					await operation.close().catch(() => {});
				}
			}
		},
		// Run again only while no batch has been handed on.
		() => total === 0,
	);
}

// Opens this caller's warehouse session without running anything on it.
//
// A session costs a connect and an openSession, which is hundreds of
// milliseconds and is paid by whichever query happens to be first. That is
// normally a visual, so the reader waits for it after the page has already
// drawn.
//
// A returning reader is the case worth catching: their policy class is read
// back from the platform store, so nothing has touched the warehouse and the
// session is still cold when the first visual asks. Started during the document
// render, it is usually connected by the time anything needs it.
//
// Errors are swallowed on purpose. This is an optimisation, and the query that
// actually needs the session is the one that should report a failure.
export function warmUserSession(
	userToken: string | null,
	sessionKey?: string,
): void {
	if (!userToken) return;
	ensureSweeping();

	const key = sessionKey ?? userToken;
	const existing = pool.get(key);
	if (existing) {
		existing.lastUsed = Date.now();
		return;
	}

	// Only while the pool has room to spare.
	//
	// This runs for every reader the shell renders for, and a session is a real
	// warehouse connection held against a fixed number of slots. With more
	// readers than slots that turns an optimisation into its opposite: each
	// arrival opens a session, evicts somebody else's, and the evicted reader
	// opens another when their next query lands. The pool stops being a cache
	// and becomes a queue of connects.
	//
	// Speculative work is the first thing to give up when the resource it
	// speculates on is contended. A reader who is skipped here is not slower
	// than they would have been without any warming at all: their first query
	// opens the session, which is what it always did.
	if (pool.size >= maxPooledSessions * warmHeadroom) return;

	const entry = openSession(userToken);
	pool.set(key, entry);
	enforceCeiling();
	void entry.session.catch(() => {
		// A session that will not open is dropped, so the next caller tries
		// again rather than awaiting a promise that already rejected.
		void closeEntry(key, entry);
	});
}

export function userSessionStats(): { pooled: number } {
	return { pooled: pool.size };
}

export async function closeAllUserSessions(): Promise<void> {
	await Promise.all(
		Array.from(pool.entries()).map(([key, entry]) =>
			closeEntry(key, entry),
		),
	);
}
