import { sql, transaction } from "../data/lakebase";
import { notify, safeLink } from "../notify/store";
import { WorkError, loadConfig, type WorkActor } from "./access";
import { formatKey } from "./model";
import { recordEvent, setStatus, rowByKey, visibleRow } from "./store";

// Releases, saved views, the queue's numbers, and the pass that keeps requests
// moving on their own: released when an update that resolves them is out,
// reminders for work sitting too long, and files nothing uses any more.

// --- Releases ----------------------------------------------------------------

export interface Release {
	id: string;
	name: string;
	target: string | null;
	notes: string;
	shippedOn: string | null;
	updateId: string | null;
	items: number;
	done: number;
}

export async function listReleases(): Promise<Release[]> {
	const rows = await sql<{
		release_id: string;
		name: string;
		target_on: string | null;
		notes: string;
		shipped_on: string | null;
		update_id: string | null;
		items: number;
		done: number;
	}>(
		`SELECT r.release_id::text, r.name, r.target_on::text, r.notes,
		        r.shipped_on::text, r.update_id::text,
		        (SELECT count(*)::int FROM work_items w WHERE w.release_id = r.release_id) AS items,
		        (SELECT count(*)::int FROM work_items w WHERE w.release_id = r.release_id AND w.status = 'done') AS done
		 FROM work_releases r
		 ORDER BY r.shipped_on NULLS FIRST, r.target_on NULLS LAST, r.created_on DESC
		 LIMIT 200`,
	);
	return rows.map((row) => ({
		id: row.release_id,
		name: row.name,
		target: row.target_on,
		notes: row.notes,
		shippedOn: row.shipped_on,
		updateId: row.update_id,
		items: row.items,
		done: row.done,
	}));
}

export async function saveRelease(
	actor: WorkActor,
	input: {
		id?: string | null;
		name: string;
		target: string | null;
		notes?: string;
	},
): Promise<string> {
	if (!actor.engineer)
		throw new WorkError("Only the engineers manage releases.", 403);
	const name = input.name.trim().slice(0, 120);
	if (!name) throw new WorkError("Name the release.");
	const target =
		input.target && /^\d{4}-\d{2}-\d{2}$/.test(input.target)
			? input.target
			: null;
	if (input.id) {
		await transaction(async (client) => {
			await client.query(
				`UPDATE work_releases SET name = $2, target_on = $3::date, notes = $4
				 WHERE release_id::text = $1`,
				[input.id, name, target, (input.notes ?? "").slice(0, 20_000)],
			);
			// Everything in it takes its date as their target.
			await client.query(
				`UPDATE work_items SET target_on = $2::date, modified_on = now()
				 WHERE release_id::text = $1 AND target_on IS DISTINCT FROM $2::date`,
				[input.id, target],
			);
		});
		return input.id;
	}
	const rows = await sql<{ release_id: string }>(
		`INSERT INTO work_releases (name, target_on, notes, created_by)
		 VALUES ($1, $2::date, $3, $4) RETURNING release_id::text`,
		[name, target, (input.notes ?? "").slice(0, 20_000), actor.email],
	);
	return rows[0].release_id;
}

// Marks a release shipped and links the update its notes were posted as, which
// resolves every request in it.
export async function markShipped(
	actor: WorkActor,
	releaseId: string,
	updateId: string | null,
): Promise<void> {
	if (!actor.engineer)
		throw new WorkError("Only the engineers ship releases.", 403);
	const items = await sql<{ item_id: string }>(
		`SELECT item_id::text FROM work_items WHERE release_id::text = $1 AND closed_as IS NULL`,
		[releaseId],
	);
	await transaction(async (client) => {
		await client.query(
			`UPDATE work_releases SET shipped_on = now(), update_id = $2::uuid WHERE release_id::text = $1`,
			[releaseId, updateId],
		);
		if (updateId) {
			for (const item of items) {
				await client.query(
					`INSERT INTO work_links (item_id, kind, target, detail, created_by)
					 VALUES ($1, 'update', $2, 'resolves', $3)
					 ON CONFLICT (item_id, kind, target) DO UPDATE SET detail = 'resolves'`,
					[item.item_id, updateId, actor.email],
				);
			}
		}
	});
	await resolveFromUpdates();
}

// --- Saved views -------------------------------------------------------------

export async function listViews(actor: WorkActor) {
	return sql<{
		view_id: string;
		owner_email: string;
		name: string;
		shared: boolean;
		state: unknown;
	}>(
		`SELECT view_id::text, owner_email, name, shared, state FROM work_views
		 WHERE owner_email = $1 OR shared ORDER BY name`,
		[actor.email],
	);
}

export async function saveView(
	actor: WorkActor,
	input: {
		id?: string | null;
		name: string;
		shared: boolean;
		state: unknown;
	},
): Promise<string> {
	const name = input.name.trim().slice(0, 80);
	if (!name) throw new WorkError("Name the view.");
	const state = JSON.stringify(input.state ?? {});
	if (state.length > 20_000) throw new WorkError("That view holds too much.");
	if (input.id) {
		const updated = await sql<{ view_id: string }>(
			`UPDATE work_views SET name = $3, shared = $4, state = $5::jsonb
			 WHERE view_id::text = $1 AND owner_email = $2 RETURNING view_id::text`,
			[input.id, actor.email, name, input.shared, state],
		);
		if (!updated[0])
			throw new WorkError("Only its owner changes a view.", 403);
		return updated[0].view_id;
	}
	const rows = await sql<{ view_id: string }>(
		`INSERT INTO work_views (owner_email, name, shared, state) VALUES ($1, $2, $3, $4::jsonb)
		 RETURNING view_id::text`,
		[actor.email, name, input.shared, state],
	);
	return rows[0].view_id;
}

export async function removeView(
	actor: WorkActor,
	viewId: string,
): Promise<void> {
	await sql(
		`DELETE FROM work_views WHERE view_id::text = $1 AND owner_email = $2`,
		[viewId, actor.email],
	);
}

// --- Numbers -----------------------------------------------------------------

export async function metrics(actor: WorkActor, days = 90) {
	if (!actor.engineer)
		throw new WorkError("Only the engineers see the queue's numbers.", 403);
	const config = await loadConfig();
	const [throughput, cycle, open, inStatus, estimates] = await Promise.all([
		sql<{ week: string; done: number }>(
			`SELECT date_trunc('week', closed_on)::date::text AS week, count(*)::int AS done
			 FROM work_items WHERE status = 'done' AND closed_as IS NULL
			   AND closed_on > now() - make_interval(days => $1)
			 GROUP BY 1 ORDER BY 1`,
			[days],
		),
		sql<{
			domain: string | null;
			work_type: string | null;
			median_days: number | null;
			count: number;
		}>(
			`SELECT domain, work_type,
			        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_on - started_on) / 86400) AS median_days,
			        count(*)::int AS count
			 FROM work_items
			 WHERE status = 'done' AND started_on IS NOT NULL
			   AND closed_on > now() - make_interval(days => $1)
			 GROUP BY GROUPING SETS ((domain), (work_type), ())`,
			[days],
		),
		sql<{
			status: string;
			count: number;
			blocked: number;
			oldest_days: number | null;
		}>(
			`SELECT status, count(*)::int AS count,
			        count(*) FILTER (WHERE blocked)::int AS blocked,
			        max(extract(epoch FROM now() - status_since) / 86400) AS oldest_days
			 FROM work_items WHERE closed_as IS NULL AND status <> 'done'
			 GROUP BY status`,
		),
		// Time spent in each column, from consecutive moves.
		sql<{ status: string; median_days: number | null }>(
			`WITH moves AS (
			   SELECT item_id, data->>'to' AS status, at,
			          lead(at) OVER (PARTITION BY item_id ORDER BY at) AS left_at
			   FROM work_events WHERE kind = 'moved' AND at > now() - make_interval(days => $1))
			 SELECT status,
			        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM left_at - at) / 86400) AS median_days
			 FROM moves WHERE left_at IS NOT NULL GROUP BY status`,
			[days],
		),
		sql<{ effort: string; count: number; median_days: number | null }>(
			`SELECT effort, count(*)::int AS count,
			        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_on - started_on) / 86400) AS median_days
			 FROM work_items
			 WHERE status = 'done' AND started_on IS NOT NULL AND effort IS NOT NULL
			   AND closed_on > now() - make_interval(days => $1)
			 GROUP BY effort`,
			[days],
		),
	]);
	return {
		days,
		throughput,
		cycle,
		open,
		inStatus,
		// Estimates set against what the work took, in working days of eight
		// hours, so a team sees whether its sizes run long or short.
		estimates: estimates.map((row) => {
			const effort = config.efforts.find((e) => e.id === row.effort);
			return {
				effort: row.effort,
				label: effort?.label ?? row.effort,
				count: row.count,
				medianDays: row.median_days,
				estimatedDays: effort
					? {
							min: effort.minHours / 8,
							max:
								effort.maxHours === null
									? null
									: effort.maxHours / 8,
						}
					: null,
			};
		}),
	};
}

// --- Keeping requests moving -------------------------------------------------

// Requests linked to an update that resolves them: Ready to deploy while the
// update is not out yet, and Done once it is published and in effect.
export async function resolveFromUpdates(): Promise<void> {
	const config = await loadConfig();
	const order = config.columns.map((column) => column.id);
	const readyAt = order.indexOf("readyToDeploy");
	const due = await sql<{
		number: string;
		status: string;
		update_title: string;
		created_by: string;
		in_effect: boolean;
	}>(
		`SELECT DISTINCT ON (w.item_id) w.number::text, w.status, u.title AS update_title,
		        u.created_by, (u.effective_on IS NULL OR u.effective_on <= now()) AS in_effect
		 FROM work_links l
		 JOIN work_items w ON w.item_id = l.item_id
		 JOIN updates u ON u.update_id::text = l.target
		 WHERE l.kind = 'update' AND l.detail = 'resolves'
		   AND u.status = 'published' AND w.closed_as IS NULL AND w.status <> 'done'
		 ORDER BY w.item_id, u.effective_on NULLS FIRST`,
	);
	for (const item of due) {
		const row = await rowByKey(`X-${item.number}`);
		if (!row) continue;
		if (item.in_effect) {
			await setStatus(
				row,
				"done",
				item.created_by,
				config,
				`Released in "${item.update_title}"`,
			);
		} else if (readyAt >= 0 && order.indexOf(row.status) < readyAt) {
			await setStatus(
				row,
				"readyToDeploy",
				item.created_by,
				config,
				`Waiting for "${item.update_title}" to take effect`,
			);
		}
	}
}

// Reminds the people on a request that has sat in one column longer than the
// queue's rules allow, once per stay in that column.
async function remindAgeing(): Promise<void> {
	const config = await loadConfig();
	for (const [status, days] of Object.entries(config.rules.ageingDays)) {
		if (!days || days <= 0) continue;
		const stale = await sql<{
			item_id: string;
			number: string;
			title: string;
			assignees: string[];
			reviewer: string | null;
		}>(
			`UPDATE work_items SET reminded_on = now()
			 WHERE status = $1 AND closed_as IS NULL
			   AND status_since < now() - make_interval(days => $2)
			   AND (reminded_on IS NULL OR reminded_on < status_since)
			 RETURNING item_id::text, number::text, title, assignees, reviewer`,
			[status, days],
		);
		const label =
			config.columns.find((c) => c.id === status)?.label ?? status;
		for (const item of stale) {
			const key = formatKey(config.prefix, Number(item.number));
			const people = new Set([
				...(item.assignees ?? []),
				...(item.reviewer ? [item.reviewer] : []),
			]);
			for (const person of people) {
				await notify(person, {
					kind: "system",
					title: `${key} has been in ${label} for ${days} days`,
					body: item.title,
					link: safeLink(`/work/${key}`),
					data: { workKey: key },
				}).catch(() => {});
			}
			await recordEvent(item.item_id, "Assistant", "reminded", {
				status,
				days,
			});
		}
	}
}

// Bytes no attachment points at any more, such as those of a deleted request.
async function clearUnusedFiles(): Promise<void> {
	await sql(
		`DELETE FROM work_attachment_data d
		 WHERE NOT EXISTS (SELECT 1 FROM work_attachments a WHERE a.hash = d.hash)`,
	);
}

export async function runWorkPass(): Promise<void> {
	for (const step of [resolveFromUpdates, remindAgeing, clearUnusedFiles]) {
		await step().catch((error) => {
			console.warn("A work queue pass did not complete:", error);
		});
	}
}

// Links updates to requests by key, as an update posted with resolves does.
export async function linkUpdateToRequests(
	updateId: string,
	keys: string[],
	by: string,
	resolves: boolean,
): Promise<string[]> {
	const linked: string[] = [];
	const update = await sql<{ title: string }>(
		`SELECT title FROM updates WHERE update_id::text = $1`,
		[updateId],
	);
	for (const key of keys.slice(0, 50)) {
		const row = await rowByKey(key);
		if (!row) continue;
		await sql(
			`INSERT INTO work_links (item_id, kind, target, detail, label, created_by)
			 VALUES ($1, 'update', $2, $3, $4, $5)
			 ON CONFLICT (item_id, kind, target) DO UPDATE SET detail = EXCLUDED.detail`,
			[
				row.item_id,
				updateId,
				resolves ? "resolves" : "relates",
				update[0]?.title ?? null,
				by,
			],
		);
		await recordEvent(row.item_id, by, "linked", {
			kind: "update",
			target: updateId,
			detail: resolves ? "resolves" : "relates",
			label: update[0]?.title ?? null,
		});
		linked.push(key);
	}
	if (resolves) await resolveFromUpdates();
	return linked;
}

// The requests linked to an update that this reader can see, for showing on it.
export async function requestsForUpdate(actor: WorkActor, updateId: string) {
	const config = await loadConfig();
	const rows = await sql<{ number: string; detail: string | null }>(
		`SELECT w.number::text, l.detail FROM work_links l JOIN work_items w ON w.item_id = l.item_id
		 WHERE l.kind = 'update' AND l.target = $1`,
		[updateId],
	);
	const shown: {
		key: string;
		title: string;
		status: string;
		resolves: boolean;
	}[] = [];
	for (const row of rows) {
		try {
			const { row: item } = await visibleRow(actor, `X-${row.number}`);
			shown.push({
				key: formatKey(config.prefix, Number(item.number)),
				title: item.title,
				status: item.status,
				resolves: row.detail === "resolves",
			});
		} catch {
			// Not one this reader can see.
		}
	}
	return shown;
}
