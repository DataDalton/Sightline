import { queryAsUser } from "../data/userSession";
import { listSources } from "../semantic/registry";
import { sourceRef } from "../semantic/types";
import { settings } from "../settings";
import type { Identity } from "./identity";

// Which sources a reader can actually read, asked of Unity Catalog rather than
// recorded here.
//
// A SELECT grant on the data a report is built from is already a statement that
// the grantee should see that report. Keeping a second list in this platform
// that says the same thing means two lists to maintain and one of them silently
// going stale, so the question is put to the catalogue instead.
//
// This decides reachability only. Which rows come back is still decided by
// Unity Catalog on the real query, under the same token.

const ttlMs = 5 * 60 * 1000;

interface CacheEntry {
	readable: Set<string>;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Set<string>>>();

// Unity Catalog reports a missing privilege in the message rather than in a
// code the driver surfaces separately. Matching on it is what separates "this
// reader may not see this" from "the warehouse is down", and the two must not
// be treated alike: the first is an answer and the second is a failure that
// should reach the caller rather than quietly emptying somebody's home page.
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

// Sources this reader holds SELECT on. Throws if the catalogue could not be
// asked, so an outage reads as an outage.
export async function readableSources(
	identity: Identity,
): Promise<Set<string>> {
	// No token means no way to ask, and no dataset query could run either.
	if (!identity.userToken) return new Set();

	// Keyed by reader, not by policy class. A policy class is built from group
	// membership, and a Unity Catalog grant can name one person, so two members
	// of the same class do not necessarily read the same sources.
	const key = identity.email.toLowerCase();
	const now = Date.now();

	const cached = cache.get(key);
	if (cached && cached.expiresAt > now) return cached.readable;

	const existing = inflight.get(key);
	if (existing) return existing;

	const pending = (async () => {
		try {
			const sources = listSources();
			const token = identity.userToken as string;

			// Probed together rather than in sequence: this runs before the
			// first page a reader sees, and one round trip per source in
			// series is the difference between a pause and a wait.
			const answers = await Promise.all(
				sources.map(async (source) => ({
					key: source.sourceKey,
					readable: await canRead(token, sourceRef(source)),
				})),
			);

			const readable = new Set(
				answers.filter((a) => a.readable).map((a) => a.key),
			);
			cache.set(key, { readable, expiresAt: now + ttlMs });
			return readable;
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, pending);
	return pending;
}

export function catalogAccessEnabled(): boolean {
	return settings().accessModel === "catalog";
}

export function invalidateSourceAccess(): void {
	cache.clear();
}
