import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { openDedicatedClient, sql } from "../data/lakebase";

// Telling every running copy of the app that something changed, so each can
// drop what it holds about it.
//
// Caches in this app live in each process's memory. Several replicas run in a
// deployment, a deploy runs old and new side by side for a while, and even
// one process keeps its background work in a module instance of its own,
// apart from the one serving requests. A change made in any of them would
// otherwise be seen only by the instance that made it, which is why caches
// had to expire after a short while. With every instance told, a cache can be
// held until what it holds changes.
//
// Each instance listens on one Postgres channel over a connection of its own.
// A change is applied where it happens straight away and then announced, and
// every other instance applies it as the notification arrives. An instance
// that loses its connection drops everything it holds once it reconnects,
// since it may have missed something meanwhile.

const channel = "sightline_changes";

// Postgres refuses a notification payload past this length, so a longer key
// is announced as its prefix up to here, which drops more and never less.
const maxPayload = 7000;

// Where announcements this instance made come back from, so it does not
// apply its own change twice.
const origin = randomUUID();

type Handler = (key: string) => void;
type ClearAll = () => void;

const handlers = new Map<string, Handler>();
const clearers: ClearAll[] = [];

let client: Client | null = null;
let starting: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 1000;
const retryCeilingMs = 60_000;

// Registers what an instance does when a change of this kind arrives, and
// what it does to drop everything of this kind after a lost connection.
export function onChange(kind: string, apply: Handler, clearAll: ClearAll) {
	handlers.set(kind, apply);
	clearers.push(clearAll);
	listen();
}

// Tells every other instance about a change already applied here. Not waited
// for, and a failed announcement only means the other instances drop the
// entry when it expires instead.
export function announce(kind: string, key: string): void {
	const payload = JSON.stringify({
		o: origin,
		k: kind,
		p: key.slice(0, maxPayload),
	});
	void sql(`SELECT pg_notify($1, $2)`, [channel, payload]).catch(() => {});
}

function clearEverything(): void {
	for (const clear of clearers) {
		try {
			clear();
		} catch {
			// One cache failing to clear does not stop the others.
		}
	}
}

function scheduleRetry(): void {
	if (retryTimer) return;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		listen();
	}, retryMs);
	retryTimer.unref?.();
	retryMs = Math.min(retryMs * 2, retryCeilingMs);
}

function dropClient(): void {
	const held = client;
	client = null;
	if (held) void held.end().catch(() => {});
	scheduleRetry();
}

function listen(): void {
	if (client || starting) return;
	// Nothing to listen for while the app is being built.
	if (process.env.NEXT_PHASE === "phase-production-build") return;
	starting = (async () => {
		try {
			const connected = await openDedicatedClient();
			connected.on("notification", (message) => {
				if (message.channel !== channel || !message.payload) return;
				try {
					const change = JSON.parse(message.payload) as {
						o: string;
						k: string;
						p: string;
					};
					if (change.o === origin) return;
					handlers.get(change.k)?.(change.p);
				} catch {
					// A payload that is not a change is ignored.
				}
			});
			connected.on("error", dropClient);
			connected.on("end", dropClient);
			await connected.query(`LISTEN ${channel}`);
			const reconnected = client === null && retryMs > 1000;
			client = connected;
			retryMs = 1000;
			// Anything announced while the connection was down was missed.
			if (reconnected) clearEverything();
		} catch {
			scheduleRetry();
		} finally {
			starting = null;
		}
	})();
}
