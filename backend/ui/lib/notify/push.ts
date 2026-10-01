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

type PushItem = Pick<InboxItem, "id" | "kind" | "title" | "body" | "link">;

// How many pushes are in flight at once for one batch.
const sendConcurrency = 8;

export async function deliverPush(
	ownerEmail: string,
	item: PushItem,
	options: { force?: boolean } = {},
): Promise<{ sent: number; failed: number }> {
	return deliverPushMany([{ ownerEmail, item }], options);
}

// Sends each entry to every device its owner allowed it on. Every owner's
// devices and preferences are read in one statement, the sends run a few at a
// time, and what each send found is written back together at the end.
export async function deliverPushMany(
	deliveries: { ownerEmail: string; item: PushItem }[],
	options: { force?: boolean } = {},
): Promise<{ sent: number; failed: number }> {
	if (!settings().pushEnabled || deliveries.length === 0) {
		return { sent: 0, failed: 0 };
	}
	const keys = await vapidKeys();
	if (!keys) return { sent: 0, failed: 0 };

	const owners = [
		...new Set(deliveries.map((d) => d.ownerEmail.toLowerCase())),
	];
	const devices = await sql<{
		owner_email: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		push: Partial<PushPreferences> | null;
	}>(
		`SELECT s.owner_email, s.endpoint, s.p256dh, s.auth, p.push
		 FROM push_subscriptions s
		 LEFT JOIN notification_prefs p ON p.owner_email = s.owner_email
		 WHERE s.owner_email = ANY($1::text[])`,
		[owners],
	);
	const byOwner = new Map<string, typeof devices>();
	for (const device of devices) {
		const held = byOwner.get(device.owner_email) ?? [];
		held.push(device);
		byOwner.set(device.owner_email, held);
	}

	const sends: {
		device: (typeof devices)[number];
		item: PushItem;
		payload: ReturnType<typeof payloadFor>;
	}[] = [];
	for (const { ownerEmail, item } of deliveries) {
		const theirs = byOwner.get(ownerEmail.toLowerCase()) ?? [];
		if (theirs.length === 0) continue;
		const payload = payloadFor(item);
		for (const device of theirs) {
			const prefs = { ...defaultPushPreferences, ...(device.push ?? {}) };
			if (options.force || prefs[item.kind]) {
				sends.push({ device, item, payload });
			}
		}
	}
	if (sends.length === 0) return { sent: 0, failed: 0 };

	const delivered: string[] = [];
	const gone: string[] = [];
	const failures = new Map<string, number>();
	const queue = [...sends];
	const workers = Array.from(
		{ length: Math.min(sendConcurrency, queue.length) },
		async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				const { device, item, payload } = next;
				const outcome = await send(
					{
						endpoint: device.endpoint,
						keys: { p256dh: device.p256dh, auth: device.auth },
					},
					payload,
					keys,
					item.kind === "alert" ? "high" : "normal",
				);
				if (outcome.kind === "sent") {
					delivered.push(device.endpoint);
				} else if (outcome.kind === "gone") {
					gone.push(device.endpoint);
				} else {
					console.warn(
						`Push to ${new URL(device.endpoint).host} failed (${outcome.status ?? "network"}): ${outcome.message}`,
					);
					failures.set(
						device.endpoint,
						(failures.get(device.endpoint) ?? 0) + 1,
					);
				}
			}
		},
	);
	await Promise.all(workers);

	if (failures.size > 0) {
		await sql(
			`UPDATE push_subscriptions s SET failures = s.failures + u.n
			 FROM unnest($1::text[], $2::int[]) AS u(endpoint, n)
			 WHERE s.endpoint = u.endpoint`,
			[[...failures.keys()], [...failures.values()]],
		);
		await sql(
			`DELETE FROM push_subscriptions
			 WHERE endpoint = ANY($1::text[]) AND failures >= $2`,
			[[...failures.keys()], maxFailures],
		);
	}
	if (gone.length > 0) {
		await sql(
			`DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])`,
			[gone],
		);
	}
	if (delivered.length > 0) {
		await sql(
			`UPDATE push_subscriptions SET last_sent_on = now(), failures = 0
			 WHERE endpoint = ANY($1::text[])`,
			[delivered],
		);
	}
	const failed =
		gone.length + [...failures.values()].reduce((a, b) => a + b, 0);
	return { sent: delivered.length, failed };
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
