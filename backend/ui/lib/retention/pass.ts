import { insertLog } from "../activityLog";
import { sql, transaction } from "../data/lakebase";
import { claimRun } from "../freshness/claim";
import {
	notifyInTransaction,
	pushNotifications,
	type InboxItem,
} from "../notify/store";
import { settings } from "../settings";
import {
	binDays,
	candidateCutoff,
	conversationCutoff,
	decide,
	itemLink,
	kindNoun,
	type RetentionItem,
	type RetentionKind,
} from "./rules";
import { forgetPages } from "./store";

// The daily retention pass.
//
// Reads and writes the platform store only. Nothing here touches the
// warehouse, so a pass never starts one that has stopped. One replica runs it
// a day, by a claim every replica asks for on the hour.
//
// Each kind is read in the same shape: owner, title, the latest moment that
// counts as use, whether anything still reads the item, and whether its owner
// kept it. What to do with each is decided in lib/retention/rules, and every
// write repeats the conditions it was decided on, so an item opened or kept
// while the pass was running is left alone.

const claimName = "retention-pass";

// How long the claim holds, which spaces one pass from the next. A little
// under a day, so the hourly ask that follows a full day always finds it free.
const claimSeconds = 23 * 60 * 60;

// The most items of one kind looked at in one pass. Anything left over is
// reached on the next.
const batch = 2000;

interface Candidate {
	id: string;
	owner_email: string;
	title: string;
	slug: string | null;
	keep: boolean;
	live: boolean;
	last_used_ms: number | null;
	// The same moment at full precision, which each write compares against.
	last_used: string | null;
}

// What counts as use of each kind, as one expression over its row, and what
// still reads it. Pages read their opens from usage events, by anyone.
const pageLastUse = `greatest(r.created_on, r.modified_on, r.restored_on,
	(SELECT max(e.occurred_on) FROM usage_events e
	 WHERE e.report_id = r.report_id AND e.event_type = 'page_view'))`;

// A scheduled delivery, a page alert, or a figure pinned to somebody's
// briefing each read the page on their own.
const pageLive = `(EXISTS (SELECT 1 FROM deliveries d
	                   WHERE d.report_id = r.report_id AND d.enabled)
	 OR EXISTS (SELECT 1 FROM page_alerts a
	            WHERE a.report_id = r.report_id AND a.is_active)
	 OR EXISTS (SELECT 1 FROM briefing_choices b
	            WHERE b.report_id = r.report_id AND b.choice = 'pin'))`;

const plain: Record<
	Exclude<RetentionKind, "page">,
	{ table: string; key: string; title: string }
> = {
	sheet: { table: "sheets", key: "sheet_id", title: "title" },
	board: { table: "boards", key: "board_id", title: "title" },
	exploreView: { table: "explore_views", key: "view_id", title: "name" },
};

function plainLastUse(alias: string): string {
	return `greatest(${alias}.created_on, ${alias}.modified_on, ${alias}.last_opened_on)`;
}

async function candidates(
	kind: RetentionKind,
	cutoff: Date,
): Promise<Candidate[]> {
	if (kind === "page") {
		return sql<Candidate>(
			`SELECT id, owner_email, title, slug, keep, live,
			        (extract(epoch FROM last_used) * 1000)::float8 AS last_used_ms,
			        last_used::text AS last_used
			 FROM (
			   SELECT r.report_id::text AS id, lower(r.owner_email) AS owner_email,
			          r.title, r.slug, r.keep, ${pageLive} AS live,
			          ${pageLastUse} AS last_used
			   FROM reports r
			   WHERE r.is_personal = TRUE AND r.is_active = TRUE
			     AND r.removed_on IS NULL AND r.keep = FALSE
			     AND greatest(r.created_on, r.modified_on, r.restored_on) < $1
			     AND NOT EXISTS (
			       SELECT 1 FROM usage_events e
			       WHERE e.report_id = r.report_id
			         AND e.event_type = 'page_view' AND e.occurred_on >= $1)
			     AND NOT ${pageLive}
			 ) c
			 ORDER BY last_used
			 LIMIT $2`,
			[cutoff, batch],
		);
	}
	const { table, key, title } = plain[kind];
	return sql<Candidate>(
		`SELECT ${key}::text AS id, lower(owner_email) AS owner_email,
		        ${title} AS title, NULL AS slug, keep, FALSE AS live,
		        (extract(epoch FROM ${plainLastUse("t")}) * 1000)::float8
		          AS last_used_ms,
		        ${plainLastUse("t")}::text AS last_used
		 FROM ${table} t
		 WHERE removed_on IS NULL AND keep = FALSE
		   AND ${plainLastUse("t")} < $1
		 ORDER BY ${plainLastUse("t")}
		 LIMIT $2`,
		[cutoff, batch],
	);
}

async function warningsFor(
	kind: RetentionKind,
	ids: string[],
): Promise<Map<string, RetentionItem["warnings"]>> {
	const byItem = new Map<string, RetentionItem["warnings"]>();
	if (ids.length === 0) return byItem;
	const rows = await sql<{
		item_id: string;
		due_on: string;
		warned_ms: number;
	}>(
		`SELECT item_id, due_on::text AS due_on,
		        (extract(epoch FROM warned_on) * 1000)::float8 AS warned_ms
		 FROM retention_warnings
		 WHERE kind = $1 AND item_id = ANY($2::text[])`,
		[kind, ids],
	);
	for (const row of rows) {
		const list = byItem.get(row.item_id) ?? [];
		list.push({ dueOn: row.due_on, warnedOn: new Date(row.warned_ms) });
		byItem.set(row.item_id, list);
	}
	return byItem;
}

const dateWords = new Intl.DateTimeFormat("en", {
	dateStyle: "long",
	timeZone: "UTC",
});

// Records the warning for one due date and writes the inbox entry beside it,
// in one transaction, so a warning is never recorded without being sent or
// sent twice for the same date.
async function warn(
	kind: RetentionKind,
	item: Candidate,
	dueOn: string,
	removeOn: Date,
	months: number,
): Promise<{ email: string; item: InboxItem } | null> {
	const noun = kindNoun[kind];
	return transaction(async (client) => {
		const recorded = await client.query(
			`INSERT INTO retention_warnings (kind, item_id, due_on)
			 VALUES ($1, $2, $3::date)
			 ON CONFLICT (kind, item_id, due_on) DO NOTHING
			 RETURNING 1`,
			[kind, item.id, dueOn],
		);
		if (recorded.rows.length === 0) return null;
		const entry = await notifyInTransaction(client, item.owner_email, {
			kind: "system",
			title: `Your ${noun} ${item.title} will be removed on ${dateWords.format(removeOn)}`,
			body:
				`Nobody has used it for close to ${months} ${months === 1 ? "month" : "months"}. ` +
				"Open it, or mark it Keep, to hold on to it. Once removed it waits " +
				`under Recently removed in My pages for ${binDays} days, and then it is deleted.`,
			link: itemLink(kind, item.id, item.slug),
			data: {
				retention: { kind, id: item.id },
				removeOn: removeOn.toISOString(),
			},
		});
		return { email: item.owner_email, item: entry };
	});
}

// Moves one item to the bin, provided it is still not kept and not used since
// it was read, and for a page that nothing has come to read it since.
async function remove(kind: RetentionKind, item: Candidate): Promise<boolean> {
	if (!item.last_used) return false;
	if (kind === "page") {
		const removed = await transaction(async (client) => {
			const rows = await client.query(
				`UPDATE reports r
				 SET is_active = FALSE, removed_on = now()
				 WHERE r.report_id = $1 AND r.is_personal = TRUE
				   AND r.is_active = TRUE AND r.removed_on IS NULL
				   AND r.keep = FALSE
				   AND ${pageLastUse} <= $2::timestamptz
				   AND NOT ${pageLive}
				 RETURNING 1`,
				[item.id, item.last_used],
			);
			if (rows.rows.length === 0) return false;
			// Withdrawn while it is in the bin, so nobody it was shared with
			// reaches it by any route, and marked so a restore puts back
			// exactly these.
			await client.query(
				`UPDATE access_policies
				 SET is_active = FALSE, retention_held = TRUE
				 WHERE resource_type = 'report' AND resource_id = $1
				   AND is_active = TRUE`,
				[item.id],
			);
			return true;
		});
		if (removed) forgetPages(item.id);
		return removed;
	}
	const { table, key } = plain[kind];
	const rows = await sql(
		`UPDATE ${table} t SET removed_on = now()
		 WHERE ${key} = $1 AND removed_on IS NULL AND keep = FALSE
		   AND ${plainLastUse("t")} <= $2::timestamptz
		 RETURNING 1`,
		[item.id, item.last_used],
	);
	return rows.length > 0;
}

// Deletes for good whatever has sat in the bin for the whole bin period.
async function purge(kind: RetentionKind): Promise<number> {
	if (kind === "page") {
		const ids = await sql<{ id: string }>(
			`SELECT report_id::text AS id FROM reports
			 WHERE is_personal = TRUE AND is_active = FALSE
			   AND removed_on IS NOT NULL
			   AND removed_on < now() - make_interval(days => $1)
			 LIMIT $2`,
			[binDays, batch],
		);
		let purged = 0;
		for (const { id } of ids) {
			const done = await transaction(async (client) => {
				const rows = await client.query(
					`DELETE FROM reports
					 WHERE report_id = $1 AND is_active = FALSE
					   AND removed_on IS NOT NULL
					   AND removed_on < now() - make_interval(days => $2)
					 RETURNING 1`,
					[id, binDays],
				);
				if (rows.rows.length === 0) return false;
				// Grants and favourites name the page by id with no key to
				// cascade from, so they go with it here.
				await client.query(
					`DELETE FROM access_policies
					 WHERE resource_type = 'report' AND resource_id = $1`,
					[id],
				);
				await client.query(
					`DELETE FROM favourites WHERE report_id = $1::uuid`,
					[id],
				);
				await client.query(
					`DELETE FROM retention_warnings
					 WHERE kind = 'page' AND item_id = $1`,
					[id],
				);
				return true;
			});
			if (done) purged++;
		}
		return purged;
	}
	const { table, key } = plain[kind];
	const rows = await sql<{ id: string }>(
		`DELETE FROM ${table}
		 WHERE ${key} IN (
		   SELECT ${key} FROM ${table}
		   WHERE removed_on IS NOT NULL
		     AND removed_on < now() - make_interval(days => $1)
		   LIMIT $2)
		 RETURNING ${key}::text AS id`,
		[binDays, batch],
	);
	if (rows.length > 0) {
		await sql(
			`DELETE FROM retention_warnings
			 WHERE kind = $1 AND item_id = ANY($2::text[])`,
			[kind, rows.map((r) => r.id)],
		);
	}
	return rows.length;
}

// Conversations unused for the period, removed with no warning and no bin.
// Their messages go with them by cascade.
async function expireConversations(cutoff: Date): Promise<number> {
	let removed = 0;
	for (;;) {
		const rows = await sql(
			`DELETE FROM assistant_conversations
			 WHERE conversation_id IN (
			   SELECT conversation_id FROM assistant_conversations
			   WHERE modified_on < $1
			   LIMIT 500)
			 RETURNING 1`,
			[cutoff],
		);
		removed += rows.length;
		if (rows.length < 500) return removed;
	}
}

export interface PassResult {
	warned: number;
	removed: number;
	purged: number;
	conversations: number;
}

// One pass over every kind, whatever the claim says. Called by runRetention,
// and directly by anything that has already decided this replica runs it.
export async function retentionPass(now = new Date()): Promise<PassResult> {
	const result: PassResult = {
		warned: 0,
		removed: 0,
		purged: 0,
		conversations: 0,
	};
	const months = settings().retentionMonths;
	if (!(months > 0)) return result;

	const cutoff = candidateCutoff(months, now);
	// A page's opens are known only while usage is being recorded. With it off
	// every page would look unused, so pages are left alone.
	const kinds: RetentionKind[] = settings().telemetryEnabled
		? ["page", "sheet", "board", "exploreView"]
		: ["sheet", "board", "exploreView"];

	const sent: { email: string; item: InboxItem }[] = [];
	for (const kind of kinds) {
		try {
			const found = await candidates(kind, cutoff);
			const warnings = await warningsFor(
				kind,
				found.map((c) => c.id),
			);
			for (const item of found) {
				const decision = decide(
					{
						lastUsed:
							item.last_used_ms === null
								? null
								: new Date(item.last_used_ms),
						liveReference: item.live,
						keep: item.keep,
						removedOn: null,
						warnings: warnings.get(item.id) ?? [],
					},
					months,
					now,
				);
				if (decision.action === "warn") {
					const entry = await warn(
						kind,
						item,
						decision.dueOn,
						decision.removeOn,
						months,
					);
					if (entry) {
						sent.push(entry);
						result.warned++;
					}
				} else if (decision.action === "remove") {
					if (await remove(kind, item)) {
						result.removed++;
						void insertLog({
							recordType: kind === "page" ? "report" : kind,
							recordId: item.id,
							action: "retention_remove",
							changedBy: "retention",
						});
					}
				}
			}
		} catch (error) {
			console.warn(
				`Retention could not review ${kindNoun[kind]}s:`,
				error,
			);
		}
	}
	pushNotifications(sent);

	// The bin empties for every kind, pages included, since what is there has
	// already waited out its period.
	for (const kind of ["page", "sheet", "board", "exploreView"] as const) {
		try {
			result.purged += await purge(kind);
		} catch (error) {
			console.warn(
				`Retention could not empty the bin of ${kindNoun[kind]}s:`,
				error,
			);
		}
	}

	const conversationsBefore = conversationCutoff(months, now);
	if (conversationsBefore) {
		try {
			result.conversations =
				await expireConversations(conversationsBefore);
		} catch (error) {
			console.warn(
				"Retention could not remove old conversations:",
				error,
			);
		}
	}

	// A warning matters only until the removal it announced, so ones long past
	// are dropped.
	await sql(
		`DELETE FROM retention_warnings
		 WHERE warned_on < now() - interval '1 year'`,
	).catch(() => {});

	return result;
}

// Runs the pass when this replica wins the day's claim. Every replica calls it
// on the hour, and all but one find the claim taken.
export async function runRetention(): Promise<void> {
	if (!(settings().retentionMonths > 0)) return;
	if (!(await claimRun(claimName, claimSeconds))) return;
	const result = await retentionPass();
	if (
		result.warned + result.removed + result.purged + result.conversations >
		0
	) {
		console.log(
			`Retention warned about ${result.warned}, removed ${result.removed}, ` +
				`deleted ${result.purged} from the bin and removed ` +
				`${result.conversations} conversation(s).`,
		);
	}
}
