import type { PoolClient } from "pg";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { notify, safeLink } from "../notify/store";
import { listReports } from "../platform/reports";

// Changes linked to an update, and the people watching it.
//
// A change made because of an update is recorded against it the way a pull
// request is linked to the issue it closes: the report version or new report,
// with the message of what it did and who did it. The update lists them, and
// the report's history says which update a version was made because of.
//
// Who sees a link follows who can see the report. Somebody who cannot open the
// report does not see the entry at all, since even its title is not theirs to
// read. Somebody who can open it but not edit it is taken to the report, and
// only somebody who can edit it is taken to the version in its history.

export type LinkKind = "reportVersion" | "report" | "item";

export interface LinkInput {
	updateId: string;
	kind: LinkKind;
	reportId?: string | null;
	version?: number | null;
	// The id of an item that is not a report, such as an alert.
	targetId?: string | null;
	title: string;
	message: string;
	actor: string;
}

export async function linkChange(
	input: LinkInput,
	client?: PoolClient,
): Promise<void> {
	const text = `INSERT INTO update_links
		 (update_id, kind, report_id, version, target_id, title, message, actor)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
	const params = [
		input.updateId,
		input.kind,
		input.reportId ?? null,
		input.version ?? null,
		input.targetId ?? null,
		input.title.slice(0, 200),
		input.message.slice(0, 2000),
		input.actor,
	];
	if (client) await client.query(text, params);
	else await sql(text, params);
}

export interface ShownLink {
	kind: LinkKind;
	title: string;
	message: string;
	actor: string;
	createdOn: string;
	version: number | null;
	// Where following it goes for this viewer: the version in the report's
	// history for an editor, the report itself for a reader, nowhere for an
	// item without a page of its own.
	href: string | null;
}

export async function linksFor(
	updateId: string,
	policy: PolicyClass,
	identity: Identity,
): Promise<ShownLink[]> {
	const rows = await sql<{
		kind: LinkKind;
		report_id: string | null;
		version: string | null;
		title: string;
		message: string;
		actor: string;
		created_on: string;
	}>(
		`SELECT kind, report_id::text, version::text, title, message, actor,
		        created_on::text
		 FROM update_links WHERE update_id = $1 ORDER BY created_on`,
		[updateId],
	);
	if (rows.length === 0) return [];
	const readable = new Map(
		(await listReports(policy, identity)).map((report) => [
			report.reportId,
			report,
		]),
	);
	const shown: ShownLink[] = [];
	for (const row of rows) {
		const report = row.report_id ? readable.get(row.report_id) : null;
		// A link about a report this viewer cannot read is not shown.
		if (row.report_id && !report) continue;
		const version = row.version === null ? null : Number(row.version);
		const editor =
			report?.permission === "edit" || report?.permission === "admin";
		const href = report
			? editor && version !== null
				? `/r/${report.slug}?edit=1&history=${version}`
				: `/r/${report.slug}`
			: null;
		shown.push({
			kind: row.kind,
			title: row.title,
			message: row.message,
			actor: row.actor,
			createdOn: row.created_on,
			version,
			href,
		});
	}
	return shown;
}

// --- Watching --------------------------------------------------------------

// Starts watching unless the person turned watching off for this update before.
export async function autoWatch(
	updateId: string,
	email: string,
): Promise<void> {
	await sql(
		`INSERT INTO update_watchers (update_id, user_email)
		 VALUES ($1, lower($2)) ON CONFLICT DO NOTHING`,
		[updateId, email],
	);
}

export async function setWatching(
	updateId: string,
	email: string,
	on: boolean,
): Promise<void> {
	await sql(
		`INSERT INTO update_watchers (update_id, user_email, watching)
		 VALUES ($1, lower($2), $3)
		 ON CONFLICT (update_id, user_email) DO UPDATE SET watching = $3`,
		[updateId, email, on],
	);
}

export async function isWatching(
	updateId: string,
	email: string,
): Promise<boolean> {
	const rows = await sql<{ watching: boolean }>(
		`SELECT watching FROM update_watchers
		 WHERE update_id = $1 AND user_email = lower($2)`,
		[updateId, email],
	);
	return rows[0]?.watching === true;
}

export async function watchersOf(updateId: string): Promise<string[]> {
	const rows = await sql<{ user_email: string }>(
		`SELECT user_email FROM update_watchers WHERE update_id = $1 AND watching`,
		[updateId],
	);
	return rows.map((row) => row.user_email);
}

// Tells everybody watching an update about something new on it, except whoever
// did it.
export async function tellWatchers(
	updateId: string,
	except: string,
	title: string,
	body: string,
): Promise<string[]> {
	const told: string[] = [];
	for (const person of await watchersOf(updateId)) {
		if (person === except.toLowerCase()) continue;
		await notify(person, {
			kind: "system",
			title,
			body: body.slice(0, 300),
			link: safeLink(`/status?tab=updates&open=${updateId}`),
			data: { updateId },
		}).catch((error) => {
			console.warn("A watcher was not told:", error);
		});
		told.push(person);
	}
	return told;
}
