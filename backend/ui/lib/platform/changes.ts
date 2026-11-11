import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { openDedicatedClient, sql } from "../data/lakebase";
import { perProcess } from "../perProcess";

// Telling every running copy of the app that something changed, so each can
// drop what it holds about it.
//
// Caches in this app live in each process's memory. Several replicas run in a
// deployment, each replica may run a process per core, and a deploy runs old
// and new side by side for a while. A change made in any of them would
// otherwise be seen only by the process that made it, which is why caches had
// to expire after a short while. With every process told, a cache can be held
// until what it holds changes.
//
// Each process listens on one Postgres channel over a connection of its own.
// A change is applied where it happens straight away and then announced, and
// every other process applies it as the notification arrives. A process that
// loses its connection drops everything it holds once it reconnects,
// since it may have missed something meanwhile.

const channel = "sightline_changes";

// Postgres refuses a notification payload past this length, so a longer key
// is announced as its prefix up to here, which drops more and never less.
const maxPayload = 7000;

type Handler = (key: string) => void;
type ClearAll = () => void;

// One listening connection for the whole process, shared by every copy of
// this module, as the caches it keeps current are shared. See lib/perProcess.
// One handler is kept for each kind of change, since every copy registers the
// same one over the same shared cache.
const shared = perProcess("changes", () => ({
	// Where announcements this process made come back from, so it does not
	// apply its own change twice.
	origin: randomUUID(),
	handlers: new Map<string, Handler>(),
	clearers: new Map<string, ClearAll>(),
	client: null as Client | null,
	starting: null as Promise<void> | null,
	retryTimer: null as ReturnType<typeof setTimeout> | null,
	retryMs: 1000,
}));
const retryCeilingMs = 60_000;

// Registers what an instance does when a change of this kind arrives, and
// what it does to drop everything of this kind after a lost connection.
export function onChange(kind: string, apply: Handler, clearAll: ClearAll) {
	shared.handlers.set(kind, apply);
	shared.clearers.set(kind, clearAll);
	listen();
}

// Changes waiting to be announced. Requests change things in bursts, such as a page
// leave writing figures and reads together, so changes made close together go out as
// one notification rather than one statement each.
let waiting: [string, string][] = [];
const announceWindowMs = 20;

// Tells every other instance about a change already applied here. Not waited
// for, and a failed announcement only means the other instances drop the
// entry when it expires instead.
export function announce(kind: string, key: string): void {
	if (waiting.length === 0) {
		setTimeout(sendWaiting, announceWindowMs).unref?.();
	}
	waiting.push([kind, key.slice(0, maxPayload)]);
}

// Sends what is waiting as few notifications as fit. Over the listening connection when it
// is open, so announcing never waits for a connection from the shared pool.
function sendWaiting(): void {
	const changes = waiting;
	waiting = [];
	const batches: [string, string][][] = [[]];
	let length = 0;
	for (const change of changes) {
		const size = change[0].length + change[1].length + 8;
		if (length + size > maxPayload && batches[batches.length - 1].length) {
			batches.push([]);
			length = 0;
		}
		batches[batches.length - 1].push(change);
		length += size;
	}
	for (const batch of batches) {
		const payload = JSON.stringify({ o: shared.origin, c: batch });
		const send = shared.client
			? shared.client.query(`SELECT pg_notify($1, $2)`, [
					channel,
					payload,
				])
			: sql(`SELECT pg_notify($1, $2)`, [channel, payload]);
		void send.catch(() => {});
	}
}

function clearEverything(): void {
	for (const clear of shared.clearers.values()) {
		try {
			clear();
		} catch {
			// One cache failing to clear does not stop the others.
		}
	}
}

function scheduleRetry(): void {
	if (shared.retryTimer) return;
	shared.retryTimer = setTimeout(() => {
		shared.retryTimer = null;
		listen();
	}, shared.retryMs);
	shared.retryTimer.unref?.();
	shared.retryMs = Math.min(shared.retryMs * 2, retryCeilingMs);
}

function dropClient(): void {
	const held = shared.client;
	shared.client = null;
	if (held) void held.end().catch(() => {});
	scheduleRetry();
}

function listen(): void {
	if (shared.client || shared.starting) return;
	// Nothing to listen for while the app is being built.
	if (process.env.NEXT_PHASE === "phase-production-build") return;
	shared.starting = (async () => {
		try {
			const connected = await openDedicatedClient();
			connected.on("notification", (message) => {
				if (message.channel !== channel || !message.payload) return;
				try {
					const change = JSON.parse(message.payload) as {
						o: string;
						c: [string, string][];
					};
					if (change.o === shared.origin) return;
					for (const [kind, key] of change.c) {
						shared.handlers.get(kind)?.(key);
					}
				} catch {
					// A payload that is not a change is ignored.
				}
			});
			connected.on("error", dropClient);
			connected.on("end", dropClient);
			await connected.query(`LISTEN ${channel}`);
			const reconnected = shared.client === null && shared.retryMs > 1000;
			shared.client = connected;
			shared.retryMs = 1000;
			// Anything announced while the connection was down was missed.
			if (reconnected) clearEverything();
		} catch {
			scheduleRetry();
		} finally {
			shared.starting = null;
		}
	})();
}
