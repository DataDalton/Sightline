import { DBSQLClient } from "@databricks/sql";
import type IDBSQLSession from "@databricks/sql/dist/contracts/IDBSQLSession";
import type IOperation from "@databricks/sql/dist/contracts/IOperation";
import type { DBSQLParameterValue } from "@databricks/sql/dist/DBSQLParameter";
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
}

const pool = new Map<string, PooledSession>();

// Sessions idle longer than this are closed. Kept well under the typical
// forwarded-token lifetime so a stale token is discarded rather than reused.
const idleTimeoutMs = 5 * 60 * 1000;
const maxPooledSessions = 200;

// Sessions are keyed by the token itself. A hash was considered and rejected:
// a collision would hand one user a warehouse session opened with another
// user token, which is a direct identity-confusion bug. The key never leaves
// this module and is never logged.

async function closeEntry(key: string, entry: PooledSession): Promise<void> {
	pool.delete(key);
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
		if (now - entry.lastUsed > idleTimeoutMs) {
			void closeEntry(key, entry);
		}
	}
	// Hard ceiling so a spike in distinct tokens cannot exhaust warehouse
	// connections. Evicts least-recently-used first.
	if (pool.size > maxPooledSessions) {
		const entries = Array.from(pool.entries()).sort(
			(a, b) => a[1].lastUsed - b[1].lastUsed,
		);
		for (const [key, entry] of entries.slice(
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

function acquire(token: string): PooledSession {
	ensureSweeping();

	let entry = pool.get(token);
	if (!entry) {
		entry = openSession(token);
		pool.set(token, entry);
		enforceCeiling();
	}
	entry.lastUsed = Date.now();
	return entry;
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

	return { session, client, lastUsed: Date.now() };
}

// Runs a query as the given user. The token is passed per call rather than
// captured once, because a forwarded token goes stale across long-lived
// connections and websocket reconnects.
export async function queryAsUser(
	userToken: string,
	sql: string,
	params?: QueryParams,
): Promise<Row[]> {
	if (!userToken) {
		throw new Error("A user token is required to query user-facing data.");
	}

	const key = userToken;
	const entry = acquire(userToken);

	const namedParameters = params as
		| Record<string, DBSQLParameterValue>
		| undefined;

	let operation: IOperation | null = null;
	try {
		const session = await entry.session;
		operation = await session.executeStatement(
			sql,
			namedParameters ? { namedParameters } : undefined,
		);
		return (await operation.fetchAll()) as Row[];
	} catch (error) {
		// Drop the pooled session so the next call reconnects with a fresh
		// token. An expired token surfaces here and must not be retried
		// against the same dead session.
		void closeEntry(key, entry);
		throw error;
	} finally {
		if (operation) {
			await operation.close().catch(() => {});
		}
	}
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
): Promise<number> {
	if (!userToken) {
		throw new Error("A user token is required to query user-facing data.");
	}

	const key = userToken;
	const entry = acquire(userToken);

	const namedParameters = params as
		| Record<string, DBSQLParameterValue>
		| undefined;

	let operation: IOperation | null = null;
	let total = 0;
	try {
		const session = await entry.session;
		operation = await session.executeStatement(
			sql,
			namedParameters ? { namedParameters } : undefined,
		);

		// hasMoreRows is only meaningful after a fetch, so this is a do-while
		// rather than a while: asking first would skip a single-batch result.
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
	} catch (error) {
		void closeEntry(key, entry);
		throw error;
	} finally {
		if (operation) {
			await operation.close().catch(() => {});
		}
	}
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
