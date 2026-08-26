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

// Unity Catalog reports a missing privilege in the message rather than in a
// code the driver surfaces separately. Matching on it is what separates "this
// reader may not see this" from "the warehouse is down", and the two must not
// be treated alike: the first is an answer, the second is a failure that should
// reach the caller rather than quietly emptying somebody home page.
const denialPattern =
	/permission|privilege|not authorized|unauthorized|access denied|insufficient/i;

async function canRead(token: string, ref: string): Promise<boolean> {
	try {
		// Plans and returns nothing. The privilege is checked during analysis,
		// so the answer arrives without scanning a row.
		await queryAsUser(token, `SELECT 1 FROM ${ref} LIMIT 0`);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (denialPattern.test(message)) return false;
		throw error;
	}
}

// Asked of the warehouse. Every source at once: they are independent questions
// and the driver runs them on one session, so the whole set costs about what
// the slowest single one does.
async function probe(identity: Identity): Promise<Set<string>> {
	const token = identity.userToken as string;
	const answers = await Promise.all(
		listSources().map(async (source) => ({
			key: source.sourceKey,
			readable: await canRead(token, sourceRef(source)),
		})),
	);
	return new Set(answers.filter((a) => a.readable).map((a) => a.key));
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
	memory.set(email, { readable, computedAt: Date.now() });
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
	if (held) {
		refreshBehind(email, identity);
		return held.readable;
	}

	// One resolution per reader, however many requests arrive at once.
	const existing = inflight.get(email);
	if (existing) return existing;

	const pending = (async () => {
		try {
			const stored = await readStored(email);
			if (stored) {
				memory.set(email, stored);
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
