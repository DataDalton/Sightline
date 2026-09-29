import { sql } from "../data/lakebase";
import { deliverPush } from "./push";

// The inbox.
//
// Everything somebody is told lands here first. A push to their phone is sent
// after the row is written and is only a faster way of noticing it, so a
// device that is off, a browser that never allowed pushes, or a deployment
// with pushes turned off all still end with the message in the inbox.

export type NotificationKind =
	| "alert"
	| "share"
	| "message"
	| "delivery"
	| "data"
	| "system";

export const notificationKinds: NotificationKind[] = [
	"alert",
	"share",
	"message",
	"delivery",
	"data",
	"system",
];

export const kindLabel: Record<NotificationKind, string> = {
	alert: "Alerts",
	share: "Pages shared with you",
	message: "Conversations",
	delivery: "Scheduled pages",
	data: "Late data",
	system: "Announcements",
};

export interface InboxItem {
	id: string;
	kind: NotificationKind;
	title: string;
	body: string;
	link: string | null;
	data: Record<string, unknown>;
	createdOn: string;
	readOn: string | null;
}

interface Row {
	notification_id: string;
	kind: NotificationKind;
	title: string;
	body: string;
	link: string | null;
	data: Record<string, unknown>;
	created_on: string;
	read_on: string | null;
}

function toItem(row: Row): InboxItem {
	return {
		id: row.notification_id,
		kind: row.kind,
		title: row.title,
		body: row.body,
		link: row.link,
		data: row.data ?? {},
		createdOn: row.created_on,
		readOn: row.read_on,
	};
}

const maxTitle = 200;
const maxBody = 2000;

// Only a path inside this application. A link in a notification is followed
// from a lock screen, where nobody reads it first.
export function safeLink(link: string | null | undefined): string | null {
	if (typeof link !== "string") return null;
	return /^\/(?!\/)[^\s\\]*$/.test(link) ? link : null;
}

export interface NewNotification {
	kind: NotificationKind;
	title: string;
	body?: string;
	link?: string | null;
	data?: Record<string, unknown>;
}

// Writes one entry and starts the push behind it. Resolves once the entry is
// stored. The push is not waited for, and a push that fails is recorded
// against the device rather than against the notification.
export async function notify(
	ownerEmail: string,
	input: NewNotification,
): Promise<InboxItem> {
	const rows = await sql<Row>(
		`INSERT INTO notifications (owner_email, kind, title, body, link, data)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING notification_id::text, kind, title, body, link, data,
		           created_on::text, read_on::text`,
		[
			ownerEmail.toLowerCase(),
			input.kind,
			input.title.slice(0, maxTitle),
			(input.body ?? "").slice(0, maxBody),
			safeLink(input.link),
			JSON.stringify(input.data ?? {}),
		],
	);
	const item = toItem(rows[0]);

	void deliverPush(ownerEmail.toLowerCase(), item).catch((error) => {
		console.warn("Push delivery failed:", error);
	});

	return item;
}

export async function listInbox(
	ownerEmail: string,
	options: {
		unreadOnly?: boolean;
		kind?: NotificationKind | null;
		before?: string | null;
		limit?: number;
	} = {},
): Promise<InboxItem[]> {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
	const rows = await sql<Row>(
		`SELECT notification_id::text, kind, title, body, link, data,
		        created_on::text, read_on::text
		 FROM notifications
		 WHERE owner_email = $1
		   AND ($2::boolean IS NOT TRUE OR read_on IS NULL)
		   AND ($3::text IS NULL OR kind = $3)
		   AND ($4::timestamptz IS NULL OR created_on < $4)
		 ORDER BY created_on DESC
		 LIMIT $5`,
		[
			ownerEmail.toLowerCase(),
			options.unreadOnly === true,
			options.kind ?? null,
			options.before ?? null,
			limit,
		],
	);
	return rows.map(toItem);
}

export async function unreadCount(ownerEmail: string): Promise<number> {
	const rows = await sql<{ n: string }>(
		`SELECT count(*)::text AS n FROM notifications
		 WHERE owner_email = $1 AND read_on IS NULL`,
		[ownerEmail.toLowerCase()],
	);
	return Number(rows[0]?.n ?? 0);
}

// Marks entries read, or unread with read = false. Scoped to the owner in the
// statement itself, so an id belonging to somebody else changes nothing.
export async function markRead(
	ownerEmail: string,
	ids: string[] | "all",
	read = true,
): Promise<number> {
	if (ids !== "all" && ids.length === 0) return 0;
	const rows = await sql<{ notification_id: string }>(
		`UPDATE notifications
		 SET read_on = CASE WHEN $3 THEN coalesce(read_on, now()) ELSE NULL END
		 WHERE owner_email = $1
		   AND ($2::uuid[] IS NULL OR notification_id = ANY($2::uuid[]))
		 RETURNING notification_id::text`,
		[ownerEmail.toLowerCase(), ids === "all" ? null : ids, read],
	);
	return rows.length;
}

export async function removeNotifications(
	ownerEmail: string,
	ids: string[] | "read",
): Promise<number> {
	const rows = await sql<{ notification_id: string }>(
		ids === "read"
			? `DELETE FROM notifications
			   WHERE owner_email = $1 AND read_on IS NOT NULL
			   RETURNING notification_id::text`
			: `DELETE FROM notifications
			   WHERE owner_email = $1 AND notification_id = ANY($2::uuid[])
			   RETURNING notification_id::text`,
		ids === "read"
			? [ownerEmail.toLowerCase()]
			: [ownerEmail.toLowerCase(), ids],
	);
	return rows.length;
}

// Ids arrive from the browser, so anything that is not a UUID is dropped
// before it reaches a uuid[] cast that would fail the whole statement.
export function cleanIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(v): v is string =>
				typeof v === "string" &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
					v,
				),
		)
		.slice(0, 500);
}
