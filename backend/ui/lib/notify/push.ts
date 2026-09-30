import { sql } from "../data/lakebase";
import { settings } from "../settings";
import {
	fitPayload,
	generateVapidKeys,
	isPushEndpoint,
	send,
	type VapidKeys,
} from "./webPush";
import type { InboxItem, NotificationKind } from "./store";

// Pushes to phones and browsers.
//
// A push is an extra copy of an inbox entry, sent to every device the owner
// allowed, for the kinds they want pushed. It carries the title, the body and
// the link, encrypted to the device, through the push service of whichever
// browser subscribed.

// --- Signing keys ----------------------------------------------------------

let keysMemo: { keys: VapidKeys | null; readAt: number } | null = null;
const keysTtlMs = 60 * 1000;

export async function vapidKeys(): Promise<VapidKeys | null> {
	const now = Date.now();
	if (keysMemo && now - keysMemo.readAt < keysTtlMs) return keysMemo.keys;
	const rows = await sql<{
		public_key: string;
		private_key: string;
		subject: string;
	}>(
		`SELECT public_key, private_key, subject FROM push_keys WHERE key_id = 1`,
	);
	const row = rows[0];
	const keys = row
		? {
				publicKey: row.public_key,
				privateKey: row.private_key,
				subject: row.subject,
			}
		: null;
	keysMemo = { keys, readAt: now };
	return keys;
}

// Creates the pair once. A second call finds the first and keeps it, because
// every subscription was made against that public key.
export async function ensureVapidKeys(contact: string): Promise<VapidKeys> {
	const existing = await vapidKeys();
	if (existing) return existing;
	const fresh = generateVapidKeys(`mailto:${contact}`);
	await sql(
		`INSERT INTO push_keys (key_id, public_key, private_key, subject)
		 VALUES (1, $1, $2, $3)
		 ON CONFLICT (key_id) DO NOTHING`,
		[fresh.publicKey, fresh.privateKey, fresh.subject],
	);
	keysMemo = null;
	return (await vapidKeys()) ?? fresh;
}

// Replaces the pair. Every existing subscription was signed for against the old
// one and is dropped with it, so each device has to turn pushes on again.
export async function rotateVapidKeys(contact: string): Promise<VapidKeys> {
	const fresh = generateVapidKeys(`mailto:${contact}`);
	await sql(`DELETE FROM push_subscriptions`);
	await sql(
		`INSERT INTO push_keys (key_id, public_key, private_key, subject)
		 VALUES (1, $1, $2, $3)
		 ON CONFLICT (key_id) DO UPDATE SET
		   public_key = EXCLUDED.public_key,
		   private_key = EXCLUDED.private_key,
		   subject = EXCLUDED.subject,
		   created_on = now()`,
		[fresh.publicKey, fresh.privateKey, fresh.subject],
	);
	keysMemo = null;
	return fresh;
}

// The key a browser subscribes with, or null when pushes are off.
export async function pushPublicKey(): Promise<string | null> {
	if (!settings().pushEnabled) return null;
	return (await vapidKeys())?.publicKey ?? null;
}

// --- Devices ---------------------------------------------------------------

export interface Device {
	endpoint: string;
	device: string;
	createdOn: string;
	lastSentOn: string | null;
	failing: boolean;
}

export class PushSubscriptionError extends Error {}

export async function saveSubscription(
	ownerEmail: string,
	raw: unknown,
	device: string,
): Promise<void> {
	const r = (raw ?? {}) as {
		endpoint?: unknown;
		keys?: { p256dh?: unknown; auth?: unknown };
	};
	const endpoint = typeof r.endpoint === "string" ? r.endpoint : "";
	const p256dh = typeof r.keys?.p256dh === "string" ? r.keys.p256dh : "";
	const auth = typeof r.keys?.auth === "string" ? r.keys.auth : "";
	if (!isPushEndpoint(endpoint) || endpoint.length > 1000) {
		throw new PushSubscriptionError(
			"This browser's push service is not one the app can send to.",
		);
	}
	if (
		!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) ||
		!/^[A-Za-z0-9_-]{16,32}$/.test(auth)
	) {
		throw new PushSubscriptionError("The subscription keys are not valid.");
	}

	// An endpoint belongs to one browser profile. If somebody else signed in on
	// the same browser before, the device is now theirs.
	await sql(
		`INSERT INTO push_subscriptions (endpoint, owner_email, p256dh, auth, device)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (endpoint) DO UPDATE SET
		   owner_email = EXCLUDED.owner_email,
		   p256dh = EXCLUDED.p256dh,
		   auth = EXCLUDED.auth,
		   device = EXCLUDED.device,
		   failures = 0`,
		[
			endpoint,
			ownerEmail.toLowerCase(),
			p256dh,
			auth,
			device.slice(0, 120),
		],
	);
}

export async function removeSubscription(
	ownerEmail: string,
	endpoint: string,
): Promise<void> {
	await sql(
		`DELETE FROM push_subscriptions WHERE owner_email = $1 AND endpoint = $2`,
		[ownerEmail.toLowerCase(), endpoint],
	);
}

export async function listDevices(ownerEmail: string): Promise<Device[]> {
	const rows = await sql<{
		endpoint: string;
		device: string;
		created_on: string;
		last_sent_on: string | null;
		failures: number;
	}>(
		`SELECT endpoint, device, created_on::text, last_sent_on::text, failures
		 FROM push_subscriptions WHERE owner_email = $1
		 ORDER BY created_on DESC`,
		[ownerEmail.toLowerCase()],
	);
	return rows.map((r) => ({
		endpoint: r.endpoint,
		device: r.device,
		createdOn: r.created_on,
		lastSentOn: r.last_sent_on,
		failing: r.failures > 0,
	}));
}

// --- Preferences -----------------------------------------------------------

export type PushPreferences = Record<NotificationKind, boolean>;

export const defaultPushPreferences: PushPreferences = {
	alert: true,
	share: true,
	message: true,
	delivery: true,
	data: true,
	schema: true,
	system: true,
};

export async function pushPreferences(
	ownerEmail: string,
): Promise<PushPreferences> {
	const rows = await sql<{ push: Partial<PushPreferences> }>(
		`SELECT push FROM notification_prefs WHERE owner_email = $1`,
		[ownerEmail.toLowerCase()],
	);
	return { ...defaultPushPreferences, ...(rows[0]?.push ?? {}) };
}

export async function savePushPreferences(
	ownerEmail: string,
	raw: unknown,
): Promise<PushPreferences> {
	const r = (raw ?? {}) as Record<string, unknown>;
	const next = { ...(await pushPreferences(ownerEmail)) };
	for (const kind of Object.keys(
		defaultPushPreferences,
	) as NotificationKind[]) {
		if (typeof r[kind] === "boolean") next[kind] = r[kind] as boolean;
	}
	await sql(
		`INSERT INTO notification_prefs (owner_email, push, modified_on)
		 VALUES ($1, $2, now())
		 ON CONFLICT (owner_email) DO UPDATE SET push = EXCLUDED.push, modified_on = now()`,
		[ownerEmail.toLowerCase(), JSON.stringify(next)],
	);
	return next;
}

// --- Sending ---------------------------------------------------------------

// A device that has failed this many times in a row is dropped. A push service
// that is briefly down costs one or two, and this many is a device that is gone
// without the service having said so.
const maxFailures = 10;

// What the service worker receives. Kept small, because some push services cap
// the payload, and the inbox has the full text. The kind tells the worker
// which actions to offer, such as a reply on a message.
function payloadFor(
	item: Pick<InboxItem, "id" | "kind" | "title" | "body" | "link">,
) {
	return fitPayload({
		id: item.id,
		kind: item.kind,
		title: item.title,
		body: item.body,
		link: item.link ?? "/inbox/",
	});
}

export async function deliverPush(
	ownerEmail: string,
	item: Pick<InboxItem, "id" | "kind" | "title" | "body" | "link">,
	options: { force?: boolean } = {},
): Promise<{ sent: number; failed: number }> {
	if (!settings().pushEnabled) return { sent: 0, failed: 0 };
	const keys = await vapidKeys();
	if (!keys) return { sent: 0, failed: 0 };

	if (!options.force) {
		const prefs = await pushPreferences(ownerEmail);
		if (!prefs[item.kind]) return { sent: 0, failed: 0 };
	}

	const targets = await sql<{
		endpoint: string;
		p256dh: string;
		auth: string;
	}>(
		`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE owner_email = $1`,
		[ownerEmail.toLowerCase()],
	);

	let sent = 0;
	let failed = 0;
	const payload = payloadFor(item);
	await Promise.all(
		targets.map(async (t) => {
			const outcome = await send(
				{
					endpoint: t.endpoint,
					keys: { p256dh: t.p256dh, auth: t.auth },
				},
				payload,
				keys,
				item.kind === "alert" ? "high" : "normal",
			);
			if (outcome.kind === "sent") {
				sent++;
				await sql(
					`UPDATE push_subscriptions SET last_sent_on = now(), failures = 0
					 WHERE endpoint = $1`,
					[t.endpoint],
				);
			} else if (outcome.kind === "gone") {
				failed++;
				await sql(
					`DELETE FROM push_subscriptions WHERE endpoint = $1`,
					[t.endpoint],
				);
			} else {
				failed++;
				console.warn(
					`Push to ${new URL(t.endpoint).host} failed (${outcome.status ?? "network"}): ${outcome.message}`,
				);
				await sql(
					`UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = $1`,
					[t.endpoint],
				);
				await sql(
					`DELETE FROM push_subscriptions WHERE endpoint = $1 AND failures >= $2`,
					[t.endpoint, maxFailures],
				);
			}
		}),
	);
	return { sent, failed };
}

export async function pushStats(): Promise<{
	devices: number;
	people: number;
	failing: number;
	keysCreatedOn: string | null;
}> {
	const [counts, keys] = await Promise.all([
		sql<{ devices: string; people: string; failing: string }>(
			`SELECT count(*)::text AS devices,
			        count(DISTINCT owner_email)::text AS people,
			        count(*) FILTER (WHERE failures > 0)::text AS failing
			 FROM push_subscriptions`,
		),
		sql<{ created_on: string }>(
			`SELECT created_on::text FROM push_keys WHERE key_id = 1`,
		),
	]);
	return {
		devices: Number(counts[0]?.devices ?? 0),
		people: Number(counts[0]?.people ?? 0),
		failing: Number(counts[0]?.failing ?? 0),
		keysCreatedOn: keys[0]?.created_on ?? null,
	};
}
