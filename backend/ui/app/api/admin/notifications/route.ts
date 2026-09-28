import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { insertLog } from "@/lib/activityLog";
import { sql } from "@/lib/data/lakebase";
import { canDo } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { pushStats, rotateVapidKeys } from "@/lib/notify/push";
import { notify, safeLink } from "@/lib/notify/store";
import { checkWriteRateLimit } from "@/lib/rateLimit";

// Notifications and alerts, seen from the administration screen: how many
// alerts and devices there are, what is failing, and the two actions that
// act on everyone: replacing the push keys and sending an announcement.

async function administrator(request: NextRequest) {
	await ensureReadyOrDegrade();
	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}
	const policy = await resolvePolicyClass(identity);
	if (!(await canDo(policy, identity, "settings.manage"))) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	return identity;
}

// Who an announcement reaches: everyone who has used the app in the last
// quarter. The platform has no directory of its own, and somebody who has not
// signed in for longer is not reading an inbox.
const announceWindow = "90 days";

export async function GET(request: NextRequest) {
	const identity = await administrator(request);
	if (identity instanceof NextResponse) return identity;

	const [alerts, inbox, push, reach] = await Promise.all([
		sql<{
			total: string;
			enabled: string;
			owners: string;
			failing: string;
			fired_week: string;
		}>(
			`SELECT count(*)::text AS total,
			        count(*) FILTER (WHERE enabled)::text AS enabled,
			        count(DISTINCT owner_email)::text AS owners,
			        count(*) FILTER (WHERE enabled AND last_status = 'error')::text AS failing,
			        (SELECT count(*) FROM alert_events
			         WHERE fired_on > now() - interval '7 days')::text AS fired_week
			 FROM alert_rules`,
		),
		sql<{ week: string; unread: string }>(
			`SELECT count(*) FILTER (WHERE created_on > now() - interval '7 days')::text AS week,
			        count(*) FILTER (WHERE read_on IS NULL)::text AS unread
			 FROM notifications`,
		),
		pushStats(),
		sql<{ people: string }>(
			`SELECT count(DISTINCT user_email)::text AS people FROM usage_daily
			 WHERE day > now() - interval '${announceWindow}'`,
		).catch(() => [{ people: "0" }]),
	]);

	const failing = await sql<{
		name: string;
		owner_email: string;
		last_error: string | null;
	}>(
		`SELECT name, owner_email, last_error FROM alert_rules
		 WHERE enabled AND last_status = 'error'
		 ORDER BY last_checked_on DESC NULLS LAST LIMIT 20`,
	);

	const a = alerts[0];
	return NextResponse.json({
		alerts: {
			total: Number(a?.total ?? 0),
			enabled: Number(a?.enabled ?? 0),
			owners: Number(a?.owners ?? 0),
			failing: Number(a?.failing ?? 0),
			firedThisWeek: Number(a?.fired_week ?? 0),
		},
		inbox: {
			sentThisWeek: Number(inbox[0]?.week ?? 0),
			unread: Number(inbox[0]?.unread ?? 0),
		},
		push,
		announceReach: Number(reach[0]?.people ?? 0),
		failing: failing.map((f) => ({
			name: f.name,
			owner: f.owner_email,
			error: f.last_error,
		})),
	});
}

// { action: "rotate" } or { action: "announce", title, body, link }
export async function POST(request: NextRequest) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;
	const identity = await administrator(request);
	if (identity instanceof NextResponse) return identity;

	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) ?? {};
	} catch {
		return NextResponse.json(
			{ error: "Malformed request" },
			{ status: 400 },
		);
	}

	if (body.action === "rotate") {
		await rotateVapidKeys(identity.email);
		void insertLog({
			recordType: "platform_settings",
			recordId: "push_keys",
			action: "rotate_push_keys",
			changedBy: identity.email,
		});
		return NextResponse.json({ push: await pushStats() });
	}

	if (body.action === "announce") {
		const title = typeof body.title === "string" ? body.title.trim() : "";
		const text = typeof body.body === "string" ? body.body.trim() : "";
		if (!title) {
			return NextResponse.json(
				{ error: "An announcement needs a title." },
				{ status: 400 },
			);
		}
		const people = await sql<{ user_email: string }>(
			`SELECT DISTINCT user_email FROM usage_daily
			 WHERE day > now() - interval '${announceWindow}'`,
		);
		// One at a time, so a large population is not a burst of pushes
		// arriving at the push services together.
		let sent = 0;
		for (const person of people) {
			try {
				await notify(person.user_email, {
					kind: "system",
					title,
					body: text,
					link: safeLink(body.link as string),
					data: { from: identity.email },
				});
				sent++;
			} catch (error) {
				console.warn(
					`Announcement to ${person.user_email} failed:`,
					error,
				);
			}
		}
		void insertLog({
			recordType: "platform_settings",
			recordId: "announcement",
			action: "send_announcement",
			changedBy: identity.email,
			newValue: title,
		});
		return NextResponse.json({ sent });
	}

	return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
