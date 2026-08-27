import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
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

let poolPromise: Promise<Pool> | null = null;

// --- Token minting ---------------------------------------------------------

interface CachedToken {
	token: string;
	expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let tokenInflight: Promise<string> | null = null;

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

	cachedToken = { token: credential.token, expiresAt };
	return credential.token;
}

async function getToken(): Promise<string> {
	const now = Date.now();
	if (cachedToken && cachedToken.expiresAt - tokenRefreshBufferMs > now) {
		return cachedToken.token;
	}

	// Share one mint between concurrent connection attempts.
	if (tokenInflight) return tokenInflight;

	tokenInflight = mintToken().finally(() => {
		tokenInflight = null;
	});
	return tokenInflight;
}

// --- Pool ------------------------------------------------------------------

async function createPool(): Promise<Pool> {
	const { Pool: PgPool } = await import("pg");

	// Local development against any Postgres, bypassing Databricks auth.
	if (lakebase.localUrl) {
		return new PgPool({
			connectionString: lakebase.localUrl,
			max: 10,
			idleTimeoutMillis: 30000,
			connectionTimeoutMillis: 10000,
		});
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
		// Modest on purpose: every replica holds its own pool, so the real
		// ceiling is this number times the replica count.
		max: 10,
		idleTimeoutMillis: 30000,
		connectionTimeoutMillis: 15000,
	});

	return pool;
}

export function getPool(): Promise<Pool> {
	if (!poolPromise) {
		poolPromise = createPool().catch((err) => {
			poolPromise = null;
			throw err;
		});
	}
	return poolPromise;
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
	const result = await pool.query(text, params);
	return result.rows as T[];
}

// Runs several statements in one transaction, rolling back on any failure.
// Used where writes must land together, such as saving a report with its
// visuals, or appending a collaboration op while bumping the report version.
export async function transaction<T>(
	fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const pool = await getPool();
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

export async function closePool(): Promise<void> {
	if (!poolPromise) return;
	const pool = await poolPromise;
	poolPromise = null;
	cachedToken = null;
	await pool.end().catch(() => {});
}

export function lakebaseStats(): {
	configured: boolean;
	tokenExpiresAt: number | null;
} {
	return {
		configured: Boolean(lakebase.host || lakebase.localUrl),
		tokenExpiresAt: cachedToken?.expiresAt ?? null,
	};
}

// Named parameters are not used against Postgres; this keeps the shared type
// import meaningful for callers that pass through both stores.
export type { QueryParams };
