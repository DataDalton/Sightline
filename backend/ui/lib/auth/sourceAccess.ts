import { sql } from "../data/lakebase";
import { queryAsUser } from "../data/userSession";
import { listSources } from "../semantic/registry";
import { sourceRef } from "../semantic/types";
import { settings } from "../settings";
import type { Identity } from "./identity";

// Which sources a reader can read, as Unity Catalog answers it.
//
// A SELECT grant on the data a report is built from is already a statement that
// the grantee should see that report. Keeping a second list in this platform
// that says the same thing means two lists to maintain and one of them silently
// going stale, so the question is put to the catalogue instead.
//
// This decides reachability only. Which rows come back is still decided by
// Unity Catalog on the real query, under the same token.
//
// Held in three tiers, because asking costs a warehouse round trip and reading
// the answer back costs a Postgres one, and those differ by a factor of a
// hundred:
//
//   memory    per replica, nanoseconds, lost on restart
//   Lakebase  shared by every replica, milliseconds, survives a restart
//   warehouse the actual question, seconds
//
// A reader waits for the warehouse once, ever. After that the answer is read
// back and refreshed behind whatever request happened to need it.

// How long an answer is served before it is refreshed behind the request. A
// catalogue privilege changes rarely, and the refresh is invisible.
const softTtlMs = 30 * 60 * 1000;

// How long an answer may still be served while a refresh runs. Past this a
// reader waits, which should only happen to somebody who has not visited in a
// day.
const hardTtlMs = 24 * 60 * 60 * 1000;

interface Entry {
	readable: Set<string>;
	computedAt: number;
}

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<Set<string>>>();
const refreshing = new Set<string>();

// One entry per reader who has ever asked on this replica. Age decides whether
// an entry may be served and on its own removes nothing, so without a ceiling
// the map grows with everybody who has ever signed in rather than with whoever
// is signed in now.
const maxReaders = 20000;

// Swept on write rather than on a timer, so a replica nobody is asking stops
// doing work.
const sweepIntervalMs = 5 * 60 * 1000;
let sweptAt = 0;

// Holds an answer, dropping whatever is past serving to make room.
function remember(email: string, entry: Entry): void {
	memory.set(email, entry);

	const now = Date.now();
	if (now - sweptAt >= sweepIntervalMs) {
		sweptAt = now;
		for (const [key, held] of memory) {
			if (now - held.computedAt >= hardTtlMs) memory.delete(key);
		}
	}

	if (memory.size <= maxReaders) return;
	// Oldest first. A dropped answer costs its reader one round trip, which is
	// what they would have paid had they not visited recently.
	const byAge = Array.from(memory.entries()).sort(
		(a, b) => a[1].computedAt - b[1].computedAt,
	);
	for (const [key] of byAge.slice(0, memory.size - maxReaders)) {
		memory.delete(key);
	}
}

// Asked as one statement.
//
// This used to test each source with its own SELECT, nineteen of them at once.
// That is the exact question worth asking and it does not survive contact with
// the driver: the statements share one Thrift session per token, and running
// them together returned a Spark error rather than an answer, which propagated
// out and left the reader with no grants at all.
//
// information_schema is filtered to what the caller may see, so one query
// answers for every source. The difference is that it reports visibility rather
// than SELECT specifically, so somebody holding BROWSE alone would reach a
// report and then be refused its rows. That is a worse answer for an unusual
// grant, in exchange for an answer at all for everybody else, and the refusal
// still happens where it must: on the real query, under their own token.
async function probe(identity: Identity): Promise<Set<string>> {
	const token = identity.userToken as string;
	const sources = listSources();
	if (sources.length === 0) return new Set();

	// Only the schemas something is actually registered in.
	const scopes = new Map<string, Set<string>>();
	for (const source of sources) {
		const schemas = scopes.get(source.catalog) ?? new Set<string>();
		schemas.add(source.schema);
		scopes.set(source.catalog, schemas);
	}

	const visible = new Set<string>();
	for (const [catalog, schemas] of scopes) {
		const list = Array.from(schemas)
			.map((s) => `'${s.replace(/'/g, "''")}'`)
			.join(", ");
		const rows = await queryAsUser(
			token,
			`SELECT table_schema, table_name
			 FROM ${catalog}.information_schema.tables
			 WHERE table_schema IN (${list})`,
		);
		for (const row of rows) {
			visible.add(
				`${catalog}.${String(row.table_schema)}.${String(row.table_name)}`.toLowerCase(),
			);
		}
	}

	return new Set(
		sources
			.filter((s) => visible.has(sourceRef(s).toLowerCase()))
			.map((s) => s.sourceKey),
	);
}

async function readStored(email: string): Promise<Entry | null> {
	try {
		const rows = await sql<{ source_keys: string[]; computed_on: string }>(
			`SELECT source_keys, computed_on FROM reader_access
			 WHERE user_email = $1 AND expires_on > now()`,
			[email],
		);
		const row = rows[0];
		if (!row) return null;
		return {
			readable: new Set(row.source_keys ?? []),
			computedAt: new Date(row.computed_on).getTime(),
		};
	} catch (error) {
		// A cache read that fails is a miss, never an error the reader sees.
		console.warn("Reader access read failed:", error);
		return null;
	}
}

async function writeStored(
	email: string,
	readable: Set<string>,
): Promise<void> {
	try {
		await sql(
			`INSERT INTO reader_access
			   (user_email, source_keys, computed_on, expires_on)
			 VALUES ($1, $2::jsonb, now(), now() + make_interval(secs => $3))
			 ON CONFLICT (user_email) DO UPDATE SET
			   source_keys = EXCLUDED.source_keys,
			   computed_on = EXCLUDED.computed_on,
			   expires_on = EXCLUDED.expires_on`,
			[email, JSON.stringify(Array.from(readable)), hardTtlMs / 1000],
		);
	} catch (error) {
		// Costs the next request a round trip, never correctness.
		console.warn("Reader access write failed:", error);
	}
}

async function resolve(
	email: string,
	identity: Identity,
): Promise<Set<string>> {
	const readable = await probe(identity);
	remember(email, { readable, computedAt: Date.now() });
	await writeStored(email, readable);
	return readable;
}

// Refreshes behind whatever request noticed the entry was getting old. Not
// awaited by that request: the point is that nobody waits for it.
function refreshBehind(email: string, identity: Identity): void {
	if (refreshing.has(email)) return;
	refreshing.add(email);
	void resolve(email, identity)
		.catch((error) => {
			console.warn(`Reader access refresh failed for ${email}:`, error);
		})
		.finally(() => refreshing.delete(email));
}

// Sources this reader holds SELECT on. Throws only when there is no stored
// answer and the catalogue cannot be asked, so an outage reads as an outage
// rather than as an empty home page.
export async function readableSources(
	identity: Identity,
): Promise<Set<string>> {
	// No token means no way to ask, and no dataset query could run either.
	if (!identity.userToken) return new Set();

	// Keyed by reader, not by policy class. A policy class is built from group
	// membership, and a Unity Catalog grant can name one person, so two members
	// of the same class do not necessarily read the same sources.
	const email = identity.email.toLowerCase();
	const now = Date.now();

	const held = memory.get(email);
	if (held && now - held.computedAt < softTtlMs) return held.readable;
	if (held && now - held.computedAt < hardTtlMs) {
		refreshBehind(email, identity);
		return held.readable;
	}
	// Past the hard ceiling the answer is not served at all, which is what the
	// ceiling was always documented to mean. Refreshing behind the request only
	// helps while the refresh is succeeding, and when the catalogue is
	// unreachable the refresh is the call that is failing: serving on regardless
	// meant a day-old answer was served indefinitely, so a withdrawn grant kept
	// working for as long as the outage lasted. Dropped instead, which falls
	// through to the stored answer and then to a fresh probe.
	if (held) memory.delete(email);

	// One resolution per reader, however many requests arrive at once.
	const existing = inflight.get(email);
	if (existing) return existing;

	const pending = (async () => {
		try {
			const stored = await readStored(email);
			if (stored) {
				remember(email, stored);
				if (now - stored.computedAt >= softTtlMs) {
					refreshBehind(email, identity);
				}
				return stored.readable;
			}
			return await resolve(email, identity);
		} finally {
			inflight.delete(email);
		}
	})();

	inflight.set(email, pending);
	return pending;
}

export function catalogAccessEnabled(): boolean {
	return settings().accessModel === "catalog";
}

// Resolves the answer without waiting for it, so the cost is paid while the
// shell is still rendering rather than in front of the first navigation.
//
// Errors are swallowed on purpose: this is an optimisation, and the request
// that actually needs the answer is the one that should report a failure.
export function warmSourceAccess(identity: Identity): void {
	if (!identity.userToken) return;
	void readableSources(identity).catch(() => {});
}

export function sourceAccessStats(): { readers: number; refreshing: number } {
	return { readers: memory.size, refreshing: refreshing.size };
}

export function invalidateSourceAccess(): void {
	memory.clear();
	void sql(`DELETE FROM reader_access`).catch(() => {});
}
