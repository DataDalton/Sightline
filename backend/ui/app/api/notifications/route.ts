import { NextRequest, NextResponse } from "next/server";
import {
	cleanIds,
	listInbox,
	markRead,
	notificationKinds,
	removeNotifications,
	unreadCount,
	type NotificationKind,
} from "@/lib/notify/store";
import { caller, privateJson, readJson } from "./guard";

// The caller's inbox: read a page of it, mark entries read or unread, or
// remove them.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	const params = request.nextUrl.searchParams;
	const kind = params.get("kind");
	const before = params.get("before");
	try {
		const [items, unread] = await Promise.all([
			listInbox(identity.email, {
				unreadOnly: params.get("unread") === "1",
				kind: notificationKinds.includes(kind as NotificationKind)
					? (kind as NotificationKind)
					: null,
				before:
					before && !Number.isNaN(Date.parse(before)) ? before : null,
				limit: Number(params.get("limit")) || 50,
			}),
			unreadCount(identity.email),
		]);
		return privateJson({ items, unread });
	} catch (error) {
		console.error("Inbox read failed:", error);
		return privateJson({ error: "Could not load your inbox" }, 500);
	}
}

// { ids: [...] | "all", read: boolean }
export async function PATCH(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	const body = (await readJson(request)) as {
		ids?: unknown;
		read?: unknown;
	} | null;
	const ids = body?.ids === "all" ? "all" : cleanIds(body?.ids);
	const changed = await markRead(identity.email, ids, body?.read !== false);
	return privateJson({ changed, unread: await unreadCount(identity.email) });
}

// { ids: [...] }, or { ids: "read" } to clear everything already read.
export async function DELETE(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;

	const body = (await readJson(request)) as { ids?: unknown } | null;
	const ids = body?.ids === "read" ? "read" : cleanIds(body?.ids);
	if (ids !== "read" && ids.length === 0) {
		return privateJson({ removed: 0 });
	}
	const removed = await removeNotifications(identity.email, ids);
	return privateJson({ removed, unread: await unreadCount(identity.email) });
}
