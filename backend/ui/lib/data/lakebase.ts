import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Client as PgClient, Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { perProcess } from "../perProcess";
import { lakebase } from "../runtime";
import type { QueryParams } from "./types";

// Connection to the transactional store. Everything the app writes at request
// latency goes through here.
//
// Lakebase has no static password. Authentication is a short-lived OAuth token
// minted from the Databricks workspace credentials and used as the Postgres
// password. Tokens last an hour, so they are cached and re-minted before
// expiry rather than fetched per connection.
//
// The official @databricks/lakebase pool helper is not used: it speaks only
// the newer projects/branches/endpoints addressing, while this workspace runs
// a database instance, which mints credentials through instance_names. The
// underlying SDK call is the same one that helper uses.

// --- Token minting ---------------------------------------------------------

interface CachedToken {
	token: string;
	expiresAt: number;
}

// The pool and the credential it connects with, one of each for the process.
// See lib/perProcess.
const shared = perProcess("lakebase", () => ({
	pool: null as Promise<Pool> | null,
	token: null as CachedToken | null,
	minting: null as Promise<string> | null,
}));

// Re-mint this long before the token actually expires, so a connection opened
// at the boundary does not get a credential that dies mid-handshake.
const tokenRefreshBufferMs = 5 * 60 * 1000;

async function mintToken(): Promise<string> {
	const { WorkspaceClient } = await import("@databricks/sdk-experimental");

	// Empty config uses the standard Databricks auth chain: injected service
	// principal credentials in a deployed app, and .databrickscfg or
	// environment variables locally. The app never handles a raw secret here.
	const workspace = new WorkspaceClient({});

	const credential = await workspace.database.generateDatabaseCredential({
		instance_names: [lakebase.instanceName],
		request_id: randomUUID(),
	});

	if (!credential.token) {
		throw new Error("Lakebase credential response contained no token");
	}

	const expiresAt = credential.expiration_time
		? new Date(credential.expiration_time).getTime()
		: Date.now() + 60 * 60 * 1000;

	shared.token = { token: credential.token, expiresAt };
	return credential.token;
}

async function getToken(): Promise<string> {
	const now = Date.now();
	const held = shared.token;
	if (held && held.expiresAt - tokenRefreshBufferMs > now) {
		return held.token;
	}

	// Share one mint between concurrent connection attempts.
	if (shared.minting) return shared.minting;

	shared.minting = mintToken().finally(() => {
		shared.minting = null;
	});
	return shared.minting;
}

// --- Pool ------------------------------------------------------------------

// Connections are retired on this schedule whether or not they are busy, so
// one is never left for the server to end. Well inside the hour the credential
// they were opened with lasts, and long against the idle reaper, which ends
// most of them first anyway.
const connectionLifetimeSeconds = 30 * 60;

// What happens to a connection nobody is holding.
//
// A client checked back in sits open until it is next asked for, and in that
// time the server can close it: an instance ends a session, a load balancer
// drops a socket it has seen no traffic on, a network path fails. pg raises
// that as an error on the idle client, and pg-pool drops the client and raises
// it again on the pool. With nothing listening, Node treats an error event as
// fatal, and the whole server went down over a connection that had already
// been discarded.
//
// The client is gone by the time this runs. All that is left is to say so, and
// only the message, because the error carries the whole client and serialising
// that is ten kilobytes of socket internals per line.
function watchIdleFailures(pool: Pool): Pool {
	pool.on("error", (error) => {
		console.warn(
			"Idle platform store connection closed by the server:",
			error.message,
		);
	});
	return pool;
}

async function createPool(): Promise<Pool> {
	const { Pool: PgPool } = await import("pg");

	// Local development against any Postgres, bypassing Databricks auth.
	if (lakebase.localUrl) {
		return watchIdleFailures(
			new PgPool({
				connectionString: lakebase.localUrl,
				max: lakebase.poolMax,
				idleTimeoutMillis: 30000,
				connectionTimeoutMillis: 10000,
			}),
		);
	}

	if (!lakebase.host || !lakebase.instanceName) {
		throw new Error(
			"Lakebase is not configured. Set PGHOST and LAKEBASE_INSTANCE, " +
				"or bind a database resource in app.yaml.",
		);
	}

	const pool = new PgPool({
		host: lakebase.host,
		port: lakebase.port,
		database: lakebase.database,
		user: lakebase.user,
		// Applied during connection startup rather than in a "connect" event
		// handler. pg does not await that handler, so a query could otherwise
		// run against the default search_path before the SET landed.
		options: `-c search_path=${lakebase.schema},public`,
		// pg calls this for every new connection, so a rotated token is picked
		// up without recycling the pool.
		password: getToken,
		ssl: { rejectUnauthorized: true },
		// Every replica holds its own pool, so the real ceiling is this number
		// times the replica count and the instance has its own limit. Set with
		// PGPOOLMAX rather than guessed, because the right number is a property
		// of the deployment.
		max: lakebase.poolMax,
		idleTimeoutMillis: 30000,
		connectionTimeoutMillis: 15000,
		maxLifetimeSeconds: connectionLifetimeSeconds,
	});

	return watchIdleFailures(pool);
}

// A connection of its own, outside the pool, for a caller that holds it open
// for a long time, such as one listening for notifications. Made the way the
// pool makes its connections, with the same credentials and settings. The
// caller ends it.
export async function openDedicatedClient(): Promise<PgClient> {
	const { Client } = await import("pg");
	if (lakebase.localUrl) {
		const client = new Client({ connectionString: lakebase.localUrl });
		await client.connect();
		return client;
	}
	if (!lakebase.host || !lakebase.instanceName) {
		throw new Error("Lakebase is not configured.");
	}
	const client = new Client({
		host: lakebase.host,
		port: lakebase.port,
		database: lakebase.database,
		user: lakebase.user,
		options: `-c search_path=${lakebase.schema},public`,
		password: await getToken(),
		ssl: { rejectUnauthorized: true },
	});
	await client.connect();
	return client;
}

export function getPool(): Promise<Pool> {
	if (!shared.pool) {
		shared.pool = createPool().catch((err) => {
			shared.pool = null;
			throw err;
		});
	}
	return shared.pool;
}

export type SqlParams = unknown[];

// Runs a query and returns its rows. Values bind as $1, $2 and are never
// interpolated: the platform composes SQL from admin-authored field
// expressions, but every value on the request path is bound.
export async function sql<T = Record<string, unknown>>(
	text: string,
	params?: SqlParams,
): Promise<T[]> {
	const pool = await getPool();
	if (!queryStats) {
		const result = await pool.query(text, params);
		return result.rows as T[];
	}
	const started = performance.now();
	try {
		const result = await pool.query(text, params);
		return result.rows as T[];
	} finally {
		noteQuery(text, performance.now() - started, pool.waitingCount);
	}
}

// Counts of every statement this process sends, for finding what fills the
// pool under load. Off unless SQL_QUERY_STATS is set, and then printed to the
// log every minute, slowest in total first. Time includes waiting for a
// connection, which is what a full pool costs each statement.
const queryStats = process.env.SQL_QUERY_STATS === "1";
// Gathered for the whole process, so one log covers every statement sent.
const stats = perProcess("lakebase-stats", () => ({
	totals: new Map<
		string,
		{ count: number; totalMs: number; queuedPeak: number }
	>(),
	timer: null as ReturnType<typeof setInterval> | null,
	loopDelay: monitorEventLoopDelay({ resolution: 20 }),
}));

function noteQuery(text: string, ms: number, waiting: number): void {
	const key = text.replace(/\s+/g, " ").trim().slice(0, 110);
	const held = stats.totals.get(key) ?? {
		count: 0,
		totalMs: 0,
		queuedPeak: 0,
	};
	held.count++;
	held.totalMs += ms;
	held.queuedPeak = Math.max(held.queuedPeak, waiting);
	stats.totals.set(key, held);
	if (stats.timer) return;
	stats.loopDelay.enable();
	stats.timer = setInterval(() => {
		const top = [...stats.totals.entries()]
			.sort((a, b) => b[1].totalMs - a[1].totalMs)
			.slice(0, 25);
		// How late the request thread ran callbacks, which is how long every
		// request and every statement result waited behind other work.
		console.log(
			`Request thread delay in the last minute, typical ${Math.round(stats.loopDelay.percentile(50) / 1e6)}ms, ` +
				`slowest 1% ${Math.round(stats.loopDelay.percentile(99) / 1e6)}ms`,
		);
		stats.loopDelay.reset();
		void getPool().then((pool) =>
			console.log(
				`Pool: ${pool.totalCount} open, ${pool.idleCount} idle, ` +
					`${pool.waitingCount} waiting`,
			),
		);
		console.log("Statements in the last minute, by total time:");
		for (const [statement, t] of top) {
			console.log(
				`  ${Math.round(t.totalMs)}ms total, ${t.count}x, ` +
					`${Math.round(t.totalMs / t.count)}ms each, ` +
					`${t.queuedPeak} waiting at most  ${statement}`,
			);
		}
		stats.totals.clear();
	}, 60_000);
}

// Runs several statements in one transaction, rolling back on any failure.
// Used where writes must land together, such as saving a report with its
// visuals, or appending a collaboration op while bumping the report version.
export async function transaction<T>(
	fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const pool = await getPool();
	const client = await pool.connect();
	// Set when the connection cannot be trusted with the next caller's work,
	// so it is closed rather than returned to the pool.
	let broken: Error | undefined;
	try {
		await client.query("BEGIN");
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		// A rollback that fails leaves the session inside an aborted
		// transaction, and every statement the next borrower sends would be
		// refused until it ended.
		await client.query("ROLLBACK").catch((failure: unknown) => {
			broken =
				failure instanceof Error ? failure : new Error(String(failure));
		});
		throw error;
	} finally {
		client.release(broken);
	}
}

// Runs work while holding a named lock, shared by every process and replica
// pointed at this database.
//
// Postgres advisory locks are held by a session rather than by a transaction
// here, so the work inside runs on its own pooled connections and is free to
// fail and carry on. The lock only decides who is allowed to be doing it.
//
// Released in a finally, and released explicitly rather than left to the
// connection closing, because the connection goes back to the pool rather than
// away and would carry the lock with it.
export async function withAdvisoryLock<T>(
	key: number,
	fn: () => Promise<T>,
): Promise<T> {
	const pool = await getPool();
	const client = await pool.connect();
	let broken: Error | undefined;
	try {
		await client.query("SELECT pg_advisory_lock($1)", [key]);
		return await fn();
	} finally {
		try {
			await client.query("SELECT pg_advisory_unlock($1)", [key]);
		} catch (failure) {
			// The session may still be open and still hold the lock, so it is
			// closed rather than pooled. Closing it is what releases the lock.
			broken =
				failure instanceof Error ? failure : new Error(String(failure));
		}
		client.release(broken);
	}
}

// Runs work only if the named lock is free, and skips it otherwise. For
// background work every replica runs on the same schedule, where whoever holds
// the lock is already doing it and waiting would only repeat it. Returns
// whether the work ran.
export async function tryAdvisoryLock(
	key: number,
	fn: () => Promise<void>,
): Promise<boolean> {
	const pool = await getPool();
	const client = await pool.connect();
	let broken: Error | undefined;
	try {
		const taken = await client.query<{ taken: boolean }>(
			"SELECT pg_try_advisory_lock($1) AS taken",
			[key],
		);
		if (!taken.rows[0]?.taken) return false;
		try {
			await fn();
			return true;
		} finally {
			try {
				await client.query("SELECT pg_advisory_unlock($1)", [key]);
			} catch (failure) {
				// The session may still be open and still hold the lock, so
				// it is closed rather than pooled. Closing it is what
				// releases the lock.
				broken =
					failure instanceof Error
						? failure
						: new Error(String(failure));
			}
		}
	} finally {
		client.release(broken);
	}
}

export async function closePool(): Promise<void> {
	if (!shared.pool) return;
	const pool = await shared.pool;
	shared.pool = null;
	shared.token = null;
	await pool.end().catch(() => {});
}

export function lakebaseStats(): {
	configured: boolean;
	tokenExpiresAt: number | null;
} {
	return {
		configured: Boolean(lakebase.host || lakebase.localUrl),
		tokenExpiresAt: shared.token?.expiresAt ?? null,
	};
}

// Named parameters are not used against Postgres; this keeps the shared type
// import meaningful for callers that pass through both stores.
export type { QueryParams };
