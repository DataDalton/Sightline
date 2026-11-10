import { insertLog } from "../activityLog";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { notify, safeLink } from "../notify/store";
import {
	can,
	canOnReport,
	getAccessContext,
	getExplicitContext,
	resolveReportAccess,
} from "../platform/access";
import {
	cachedDefinition,
	invalidateDefinitions,
} from "../platform/definitionCache";
import { curatedReports, reportSubject } from "../platform/curated";
import { reachableSet } from "../platform/sources";
import { settings } from "../settings";
import {
	deprecationReminderDays,
	deprecationReminderDue,
	deprecationReminderTitle,
	automaticEntries,
	builtinTypes,
	cleanInput,
	followMatches,
	isShowing,
	posterName,
	quietSources,
	reaches,
	resolveAuthors,
	sourcesOf,
	timelineDate,
	type AutomaticKind,
	type PersonAlias,
	type Follow,
	type IncidentState,
	type Reader,
	type SyncDifferences,
	type Update,
	type UpdateInput,
	type UpdateTypeDefinition,
} from "./model";

// Storing updates, deciding who may post and who gets told, and answering the views.
// See lib/updates/model for the rules themselves.

export class UpdateError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

interface UpdateRow {
	update_id: string;
	type: string;
	title: string;
	body: string;
	impact: Update["impact"];
	status: Update["status"];
	about: Update["about"];
	before_value: string | null;
	after_value: string | null;
	links: Update["links"];
	tags: string[];
	reference: string | null;
	posted_on: string;
	effective_on: string | null;
	period_from: string | null;
	period_to: string | null;
	starts_on: string | null;
	ends_on: string | null;
	repeat_every: Update["repeat"];
	incident_state: IncidentState | null;
	audience: Update["audience"];
	delivery: Update["delivery"];
	show_from: string | null;
	expires_on: string | null;
	require_ack: boolean;
	automatic: boolean;
	reason: string | null;
	created_by: string;
	corrected_on: string | null;
	authors: Update["authors"];
	placement: Update["placement"];
	notify: boolean;
}

const columns = `update_id::text AS update_id, type, title, body, impact, status, about,
	before_value, after_value, links, tags, reference, posted_on, effective_on, period_from,
	period_to, starts_on, ends_on, repeat_every, incident_state, audience, delivery,
	show_from, expires_on, require_ack, automatic, reason, created_by, corrected_on,
	authors, placement, notify`;

function toUpdate(row: UpdateRow): Update {
	return {
		updateId: row.update_id,
		type: row.type,
		title: row.title,
		body: row.body,
		impact: row.impact,
		status: row.status,
		about: row.about,
		before: row.before_value,
		after: row.after_value,
		links: row.links,
		tags: row.tags,
		reference: row.reference,
		postedOn: row.posted_on,
		effectiveOn: row.effective_on,
		periodFrom: row.period_from,
		periodTo: row.period_to,
		startsOn: row.starts_on,
		endsOn: row.ends_on,
		repeat: row.repeat_every,
		incidentState: row.incident_state,
		audience: row.audience,
		delivery: row.delivery,
		showFrom: row.show_from,
		expiresOn: row.expires_on,
		requireAck: row.require_ack,
		automatic: row.automatic,
		reason: row.reason,
		createdBy: row.created_by,
		correctedOn: row.corrected_on,
		authors: row.authors ?? [],
		placement: row.placement === "history" ? "history" : "top",
		notify: row.notify !== false,
	};
}

const liveKey = "updates:live";

// Everything not retracted or in draft, held until something is written, since every
// page of every reader asks. Dropped across replicas by invalidateDefinitions.
async function publishedUpdates(): Promise<Update[]> {
	return cachedDefinition(liveKey, async () => {
		const rows = await sql<UpdateRow>(
			`SELECT ${columns} FROM updates
			 WHERE status = 'published'
			 ORDER BY posted_on DESC`,
		);
		return rows.map(toUpdate);
	});
}

// Also for an entry written outside these functions, such as the demo's own.
export function dropHeld(): void {
	invalidateDefinitions(liveKey);
}

// --- Types and templates -----------------------------------------------------------

export async function allTypes(): Promise<UpdateTypeDefinition[]> {
	const custom = await sql<{
		type_id: string;
		label: string;
		color: string;
		impact: UpdateTypeDefinition["impact"];
		delivery: UpdateTypeDefinition["delivery"];
		requires: string[];
	}>(
		`SELECT type_id, label, color, impact, delivery, requires
		 FROM update_types WHERE is_active = TRUE ORDER BY label`,
	);
	return [
		...builtinTypes,
		...custom.map((row) => ({
			typeId: row.type_id,
			label: row.label,
			color: row.color,
			impact: row.impact,
			delivery: row.delivery,
			requires: row.requires,
			isBuiltin: false,
		})),
	];
}

async function assertModerates(
	policy: PolicyClass,
	email: string,
): Promise<void> {
	const context = await getExplicitContext(policy, email);
	if (!can(context.capabilities, "update.moderate", null, context.denied)) {
		throw new UpdateError("Only an administrator can do this.", 403);
	}
}

export async function saveType(
	policy: PolicyClass,
	identity: Identity,
	raw: Record<string, unknown>,
): Promise<void> {
	await assertModerates(policy, identity.email);
	const label = String(raw.label ?? "").trim();
	if (!label) throw new UpdateError("A type needs a name.");
	if (builtinTypes.some((t) => t.typeId === raw.typeId)) {
		throw new UpdateError("A built-in type cannot be changed.");
	}
	const typeId =
		String(raw.typeId ?? "").trim() ||
		`custom-${label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")}`;
	await sql(
		`INSERT INTO update_types (type_id, label, color, impact, delivery, requires)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
		 ON CONFLICT (type_id) DO UPDATE SET
		   label = EXCLUDED.label, color = EXCLUDED.color, impact = EXCLUDED.impact,
		   delivery = EXCLUDED.delivery, requires = EXCLUDED.requires,
		   is_active = TRUE`,
		[
			typeId,
			label.slice(0, 100),
			String(raw.color || "var(--brand)").slice(0, 60),
			["info", "notable", "breaking"].includes(String(raw.impact))
				? raw.impact
				: "info",
			JSON.stringify(raw.delivery ?? builtinTypes[0].delivery),
			JSON.stringify(Array.isArray(raw.requires) ? raw.requires : []),
		],
	);
}

export async function removeType(
	policy: PolicyClass,
	identity: Identity,
	typeId: string,
): Promise<void> {
	await assertModerates(policy, identity.email);
	await sql(`UPDATE update_types SET is_active = FALSE WHERE type_id = $1`, [
		typeId,
	]);
}

export interface UpdateTemplate {
	templateId: string;
	name: string;
	type: string;
	fields: Record<string, unknown>;
}

export async function listTemplates(): Promise<UpdateTemplate[]> {
	const rows = await sql<{
		template_id: string;
		name: string;
		type: string;
		fields: Record<string, unknown>;
	}>(
		`SELECT template_id::text AS template_id, name, type, fields
		 FROM update_templates WHERE is_active = TRUE ORDER BY name`,
	);
	return rows.map((row) => ({
		templateId: row.template_id,
		name: row.name,
		type: row.type,
		fields: row.fields,
	}));
}

export async function saveTemplate(
	policy: PolicyClass,
	identity: Identity,
	raw: Record<string, unknown>,
): Promise<void> {
	await assertCanPost(policy, identity, String(raw.type ?? ""), []);
	const name = String(raw.name ?? "").trim();
	if (!name) throw new UpdateError("A template needs a name.");
	await sql(
		`INSERT INTO update_templates (name, type, fields, created_by)
		 VALUES ($1, $2, $3::jsonb, $4)`,
		[
			name.slice(0, 200),
			String(raw.type),
			JSON.stringify(raw.fields ?? {}),
			identity.email,
		],
	);
}

export async function removeTemplate(
	policy: PolicyClass,
	identity: Identity,
	templateId: string,
): Promise<void> {
	const held = (await listTemplates()).find(
		(template) => template.templateId === templateId,
	);
	if (!held) throw new UpdateError("Not found", 404);
	await assertCanPost(policy, identity, held.type, []);
	await sql(
		`UPDATE update_templates SET is_active = FALSE WHERE template_id = $1`,
		[templateId],
	);
}

// --- Who may post ------------------------------------------------------------------

// Anybody holding the right to post, everywhere or on what the update is about. An
// Editor can post about a report they can edit. Authors look after their own.
export async function assertCanPost(
	policy: PolicyClass,
	identity: Identity,
	type: string,
	about: Update["about"],
): Promise<void> {
	const context = await getExplicitContext(policy, identity.email);
	const allowed = (scope?: string | null) =>
		can(context.capabilities, "update.post", scope, context.denied);
	if (allowed()) return;

	if (about.length > 0) {
		const onAll = await Promise.all(
			about.map(async (item) => {
				if (item.kind === "source") return allowed(item.id);
				if (item.kind === "field") return allowed(item.sourceKey);
				if (item.kind === "category") return allowed(item.id);
				if (item.kind !== "report") return false;
				const subject = await reportSubject(item.id);
				if (!subject) return false;
				const ref = {
					reportId: item.id,
					categoryId: subject.category_id,
					tags: subject.tags,
				};
				return (
					canOnReport(
						context.capabilities,
						"update.post",
						ref,
						context.denied,
					) ||
					(type === "reportChange" &&
						canOnReport(
							context.capabilities,
							"report.edit",
							ref,
							context.denied,
						))
				);
			}),
		);
		if (onAll.every(Boolean)) return;
	}
	throw new UpdateError("You cannot post about that.", 403);
}

async function assertCanChange(
	policy: PolicyClass,
	identity: Identity,
	update: Update,
): Promise<void> {
	if (update.createdBy.toLowerCase() === identity.email.toLowerCase()) return;
	const context = await getExplicitContext(policy, identity.email);
	if (can(context.capabilities, "update.moderate", null, context.denied))
		return;
	await assertCanPost(policy, identity, update.type, update.about);
}

// --- Writing -----------------------------------------------------------------------

async function recordEvent(
	updateId: string,
	by: string,
	kind: string,
	note: string | null,
	snapshot: unknown,
): Promise<void> {
	await sql(
		`INSERT INTO update_events (update_id, by_email, kind, note, snapshot)
		 VALUES ($1, $2, $3, $4, $5::jsonb)`,
		[updateId, by, kind, note, JSON.stringify(snapshot ?? null)],
	);
}

const fieldValues = (input: UpdateInput) => [
	input.type,
	input.title,
	input.body,
	input.impact,
	input.status,
	JSON.stringify(input.about),
	input.before,
	input.after,
	JSON.stringify(input.links),
	input.tags,
	input.reference,
	input.effectiveOn,
	input.periodFrom,
	input.periodTo,
	input.startsOn,
	input.endsOn,
	input.repeat,
	input.incidentState,
	JSON.stringify(input.audience),
	JSON.stringify(input.delivery),
	input.showFrom,
	input.expiresOn,
	input.requireAck,
	input.reason,
];

// Creates it, or with a reference already on file, changes that one. An automation
// retrying after a dropped connection lands on the entry it already made.
export async function postUpdate(
	policy: PolicyClass,
	identity: Identity,
	raw: Record<string, unknown>,
): Promise<{ update: Update; created: boolean }> {
	const types = await allTypes();
	const input = cleanInput(
		raw,
		types.find((type) => type.typeId === raw.type),
	);
	await assertCanPost(policy, identity, input.type, input.about);

	if (input.reference) {
		const held = await sql<UpdateRow>(
			`SELECT ${columns} FROM updates WHERE reference = $1`,
			[input.reference],
		);
		if (held[0]) {
			const update = await changeUpdate(
				policy,
				identity,
				held[0].update_id,
				raw,
			);
			return { update, created: false };
		}
	}

	const rows = await sql<UpdateRow>(
		`INSERT INTO updates
		   (type, title, body, impact, status, about, before_value, after_value, links,
		    tags, reference, effective_on, period_from, period_to, starts_on, ends_on,
		    repeat_every, incident_state, audience, delivery, show_from, expires_on,
		    require_ack, reason, created_by, authors, placement, notify)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $13, $14,
		         $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21, $22, $23, $24, $25,
		         $26::jsonb, $27, $28)
		 RETURNING ${columns}`,
		[
			...fieldValues(input),
			identity.email,
			JSON.stringify(input.authors),
			input.placement,
			input.notify,
		],
	);
	const update = toUpdate(rows[0]);
	await recordEvent(update.updateId, identity.email, "created", null, null);
	await insertLog({
		recordType: "update",
		recordId: update.updateId,
		action: "post_update",
		changedBy: identity.email,
		newValue: update.title,
	});
	dropHeld();
	if (update.status === "published") await deliver(update);
	return { update, created: true };
}

// An edit keeps what it replaced, so history can say what the entry used to read. Once
// published, a change shows as corrected.
export async function changeUpdate(
	policy: PolicyClass,
	identity: Identity,
	updateId: string,
	raw: Record<string, unknown>,
): Promise<Update> {
	const held = await updateById(updateId);
	if (!held) throw new UpdateError("Not found", 404);
	await assertCanChange(policy, identity, held);

	const types = await allTypes();
	const input = cleanInput(
		{ ...held, ...raw, type: held.type },
		types.find((type) => type.typeId === held.type),
	);
	await assertCanPost(policy, identity, input.type, input.about).catch(
		async (error) => {
			if (held.createdBy.toLowerCase() !== identity.email.toLowerCase()) {
				throw error;
			}
		},
	);

	const wasDraft = held.status === "draft";
	const rows = await sql<UpdateRow>(
		`UPDATE updates SET
		   type = $1, title = $2, body = $3, impact = $4, status = $5, about = $6::jsonb,
		   before_value = $7, after_value = $8, links = $9::jsonb, tags = $10,
		   reference = $11,
		   reminded_days = CASE WHEN effective_on IS DISTINCT FROM $12
		     THEN NULL ELSE reminded_days END,
		   effective_on = $12, period_from = $13, period_to = $14,
		   starts_on = $15, ends_on = $16, repeat_every = $17, incident_state = $18,
		   audience = $19::jsonb, delivery = $20::jsonb, show_from = $21, expires_on = $22,
		   require_ack = $23, reason = $24,
		   authors = $27::jsonb, placement = $28, notify = $29,
		   corrected_on = CASE WHEN $26 THEN corrected_on ELSE now() END,
		   posted_on = CASE WHEN $26 THEN now() ELSE posted_on END
		 WHERE update_id = $25
		 RETURNING ${columns}`,
		[
			...fieldValues(input),
			updateId,
			wasDraft,
			JSON.stringify(input.authors),
			input.placement,
			input.notify,
		],
	);
	const update = toUpdate(rows[0]);
	await recordEvent(
		updateId,
		identity.email,
		wasDraft ? "published" : "corrected",
		typeof raw.note === "string" ? raw.note : null,
		held,
	);
	await insertLog({
		recordType: "update",
		recordId: updateId,
		action: "change_update",
		changedBy: identity.email,
		newValue: update.title,
	});
	dropHeld();
	if (wasDraft && update.status === "published") await deliver(update);
	return update;
}

export async function retractUpdate(
	policy: PolicyClass,
	identity: Identity,
	updateId: string,
	note: unknown,
): Promise<void> {
	const held = await updateById(updateId);
	if (!held) throw new UpdateError("Not found", 404);
	await assertCanChange(policy, identity, held);
	await sql(`UPDATE updates SET status = 'retracted' WHERE update_id = $1`, [
		updateId,
	]);
	await recordEvent(
		updateId,
		identity.email,
		"retracted",
		typeof note === "string" ? note : null,
		held,
	);
	await insertLog({
		recordType: "update",
		recordId: updateId,
		action: "retract_update",
		changedBy: identity.email,
	});
	dropHeld();
}

// Moves an incident on, adding to its timeline. Resolving also ends its banner, since
// there is no longer anything to warn about.
export async function moveIncident(
	policy: PolicyClass,
	identity: Identity,
	updateId: string,
	state: IncidentState,
	note: unknown,
): Promise<void> {
	const held = await updateById(updateId);
	if (!held || held.type !== "incident") {
		throw new UpdateError("Not found", 404);
	}
	await assertCanChange(policy, identity, held);
	await sql(
		`UPDATE updates SET incident_state = $2,
		   ends_on = CASE WHEN $2 = 'resolved' THEN now() ELSE ends_on END
		 WHERE update_id = $1`,
		[updateId, state],
	);
	await recordEvent(
		updateId,
		identity.email,
		state,
		typeof note === "string" ? note : null,
		null,
	);
	dropHeld();
}

export async function updateById(updateId: string): Promise<Update | null> {
	const rows = await sql<UpdateRow>(
		`SELECT ${columns} FROM updates WHERE update_id = $1`,
		[updateId],
	);
	return rows[0] ? toUpdate(rows[0]) : null;
}

export async function historyOf(updateId: string) {
	return sql<{
		kind: string;
		by_email: string;
		at: string;
		note: string | null;
		snapshot: { title?: string; body?: string } | null;
	}>(
		`SELECT kind, by_email, at, note, snapshot FROM update_events
		 WHERE update_id = $1 ORDER BY at`,
		[updateId],
	);
}

// --- Telling people ----------------------------------------------------------------

// Who to tell, among people who have used the app lately, since nothing can list who
// could read a source. Those who read the source lately stand in for readers of it.
async function peopleFor(update: Update): Promise<string[]> {
	const sources = sourcesOf(update.about);
	const rows =
		sources.length > 0 && update.audience.kind === "readers"
			? await sql<{ user_email: string }>(
					`SELECT DISTINCT user_email FROM usage_daily
					 WHERE day > now() - interval '90 days'
					   AND source_key = ANY($1::text[])`,
					[sources],
				)
			: await sql<{ user_email: string }>(
					`SELECT DISTINCT user_email FROM usage_daily
					 WHERE day > now() - interval '90 days'`,
				);
	return rows.map((row) => row.user_email);
}

async function followersOf(
	update: Update,
): Promise<{ instant: string[]; digest: string[] }> {
	const rows = await sql<{
		user_email: string;
		kind: Follow["kind"];
		value: string;
		mode: Follow["mode"];
	}>(`SELECT user_email, kind, value, mode FROM update_follows`);
	const matched = rows.filter((row) => followMatches(row, update));
	return {
		instant: matched
			.filter((row) => row.mode === "instant")
			.map((row) => row.user_email),
		digest: matched
			.filter((row) => row.mode === "digest")
			.map((row) => row.user_email),
	};
}

// Told about something held back for later when its time comes, by the sweep below.
export async function deliver(update: Update): Promise<void> {
	if (!isShowing(update, Date.now())) return;
	const claimed = await sql<{ update_id: string }>(
		`UPDATE updates SET delivered_on = now()
		 WHERE update_id = $1 AND delivered_on IS NULL
		 RETURNING update_id::text AS update_id`,
		[update.updateId],
	);
	if (claimed.length === 0) return;
	// Claimed all the same, so the sweep does not come back to send it later.
	if (!update.notify) return;

	const followers = await followersOf(update);
	const audience =
		update.delivery.inbox || update.delivery.push
			? await peopleFor(update)
			: [];
	const everyone = new Set(
		[...audience, ...followers.instant].map((person) =>
			person.toLowerCase(),
		),
	);
	everyone.delete(update.createdBy.toLowerCase());
	const digestOnly = followers.digest.filter(
		(person) => !everyone.has(person.toLowerCase()),
	);

	for (const person of everyone) {
		await notify(person, {
			kind:
				update.type === "maintenance" || update.type === "incident"
					? "data"
					: "system",
			title: update.title,
			body: textOf(update.body).slice(0, 300),
			link: safeLink(`/status?tab=updates&open=${update.updateId}`),
			data: { updateId: update.updateId },
		}).catch((error) => {
			console.warn("An update was not delivered:", error);
		});
	}
	if (digestOnly.length > 0) {
		await sql(
			`INSERT INTO update_digest_queue (update_id, user_email)
			 SELECT $1, u FROM unnest($2::text[]) AS u
			 ON CONFLICT DO NOTHING`,
			[update.updateId, digestOnly],
		);
	}
}

function textOf(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Deprecations coming up, to whoever was told of them and whoever wrote them. Someone who
// has acknowledged one has said they know. Claimed first, so replicas ticking together
// send one reminder between them.
async function remindOfDeprecations(): Promise<void> {
	const furthest = Math.max(...deprecationReminderDays);
	const rows = await sql<UpdateRow & { reminded_days: number | null }>(
		`SELECT ${columns}, reminded_days FROM updates
		 WHERE type = 'deprecation' AND status = 'published'
		   AND delivered_on IS NOT NULL
		   AND effective_on > now()
		   AND effective_on <= now() + make_interval(days => $1)
		   AND (expires_on IS NULL OR expires_on > now())`,
		[furthest],
	);
	for (const row of rows) {
		const update = toUpdate(row);
		const daysAhead = deprecationReminderDue(
			update.effectiveOn,
			update.postedOn,
			row.reminded_days,
			Date.now(),
		);
		if (daysAhead === null) continue;
		const claimed = await sql<{ update_id: string }>(
			`UPDATE updates SET reminded_days = $2
			 WHERE update_id = $1
			   AND (reminded_days IS NULL OR reminded_days > $2)
			 RETURNING update_id::text AS update_id`,
			[update.updateId, daysAhead],
		);
		if (claimed.length === 0) continue;

		const [followers, audience, acknowledged] = await Promise.all([
			followersOf(update),
			update.delivery.inbox || update.delivery.push
				? peopleFor(update)
				: Promise.resolve<string[]>([]),
			whoAcknowledged(update.updateId),
		]);
		const told = new Set(
			[
				...audience,
				...followers.instant,
				...followers.digest,
				update.createdBy,
			].map((person) => person.toLowerCase()),
		);
		for (const person of acknowledged) told.delete(person.toLowerCase());
		for (const person of told) {
			await notify(person, {
				kind: "system",
				title: deprecationReminderTitle(update.title, daysAhead),
				body: textOf(update.body).slice(0, 300),
				link: safeLink(`/status?tab=updates&open=${update.updateId}`),
				data: { updateId: update.updateId },
			}).catch((error) => {
				console.warn(
					"A deprecation reminder was not delivered:",
					error,
				);
			});
		}
	}
}

// Anything scheduled whose time has come, reminders of what is ending, and the day's digest
// for those who chose one.
export async function sweepUpdates(): Promise<void> {
	const due = await sql<UpdateRow>(
		`SELECT ${columns} FROM updates
		 WHERE status = 'published' AND delivered_on IS NULL
		   AND (show_from IS NULL OR show_from <= now())
		   AND (expires_on IS NULL OR expires_on > now())`,
	);
	for (const row of due) await deliver(toUpdate(row));

	await remindOfDeprecations();

	const owed = await sql<{ user_email: string; titles: string[] }>(
		`SELECT q.user_email, array_agg(u.title ORDER BY u.posted_on) AS titles
		 FROM update_digest_queue q
		 JOIN updates u ON u.update_id = q.update_id
		 WHERE q.queued_on < now() - interval '1 day'
		 GROUP BY q.user_email`,
	);
	for (const row of owed) {
		const sent = await sql<{ user_email: string }>(
			`DELETE FROM update_digest_queue
			 WHERE user_email = $1 AND queued_on < now() - interval '1 day'
			 RETURNING user_email`,
			[row.user_email],
		);
		if (sent.length === 0) continue;
		await notify(row.user_email, {
			kind: "system",
			title:
				row.titles.length === 1
					? "One update you follow"
					: `${row.titles.length} updates you follow`,
			body: row.titles.slice(0, 5).join(". "),
			link: "/status?tab=updates",
		}).catch((error) => {
			console.warn("A digest was not delivered:", error);
		});
	}
}

// --- Automatic entries ----------------------------------------------------------------

// Posted by the app itself after a field sync, so no one has to notice. Someone can add
// the reason afterwards, which is the only thing the app cannot know.
export async function postAutomatic(
	found: SyncDifferences,
	sourceTitle: string,
): Promise<void> {
	const held = settings();
	const enabled: Record<AutomaticKind, boolean> = {
		fieldAdded: held.autoUpdateFieldAdded,
		fieldRemoved: held.autoUpdateFieldRemoved,
		fieldRenamed: held.autoUpdateFieldRenamed,
		definitionChanged: held.autoUpdateDefinitionChanged,
	};
	const entries = automaticEntries(
		found,
		sourceTitle,
		enabled,
		new Date().toISOString().slice(0, 10),
	);
	const dataChange = builtinTypes.find((t) => t.typeId === "dataChange");
	for (const entry of entries) {
		const rows = await sql<UpdateRow>(
			`INSERT INTO updates
			   (type, title, body, impact, status, about, before_value, after_value,
			    links, tags, reference, audience, delivery, automatic, created_by,
			    effective_on)
			 VALUES ('dataChange', $1, '', $2, 'published', $3::jsonb, $4, $5, '[]'::jsonb,
			         '{}', $6, '{"kind":"readers"}'::jsonb, $7::jsonb, TRUE, 'Automatic',
			         now())
			 ON CONFLICT (reference) DO NOTHING
			 RETURNING ${columns}`,
			[
				entry.title,
				entry.impact,
				JSON.stringify(entry.about),
				entry.before,
				entry.after,
				entry.reference,
				JSON.stringify({
					...dataChange?.delivery,
					banner: entry.impact === "breaking",
				}),
			],
		);
		if (rows[0]) {
			dropHeld();
			await deliver(toUpdate(rows[0]));
		}
	}
}

// --- Reading ---------------------------------------------------------------------------

async function readerOf(
	policy: PolicyClass,
	identity: Identity,
): Promise<Reader> {
	const [reachable, context, curated] = await Promise.all([
		reachableSet(identity),
		getAccessContext(policy, identity),
		curatedReports(),
	]);
	const reports = new Set<string>();
	const categories = new Set<string>();
	for (const report of curated) {
		const access = resolveReportAccess(
			context.grants,
			{
				reportId: report.report_id,
				categoryId: report.category_id,
				isPersonal: false,
				ownerEmail: null,
				tags: report.tags,
			},
			context.email,
			"view",
			context.baseline,
		);
		if (!access.allowed) continue;
		reports.add(report.report_id);
		if (report.category_id) categories.add(report.category_id);
	}
	return {
		readableSources: reachable,
		groups: policy.grants,
		categories,
		reports,
	};
}

export interface UpdateView extends Update {
	read: boolean;
	acknowledged: boolean;
}

async function marksFor(
	email: string,
): Promise<Map<string, { read: boolean; acked: boolean }>> {
	const rows = await sql<{
		update_id: string;
		acked_on: string | null;
	}>(
		`SELECT update_id::text AS update_id, acked_on FROM update_reads
		 WHERE user_email = lower($1)`,
		[email],
	);
	return new Map(
		rows.map((row) => [
			row.update_id,
			{ read: true, acked: row.acked_on !== null },
		]),
	);
}

// What this person can see, right now.
export async function visibleUpdates(
	policy: PolicyClass,
	identity: Identity,
): Promise<UpdateView[]> {
	const [all, reader, marks] = await Promise.all([
		publishedUpdates(),
		readerOf(policy, identity),
		marksFor(identity.email),
	]);
	const now = Date.now();
	return (
		all
			.filter(
				(update) => isShowing(update, now) && reaches(update, reader),
			)
			.map((update) => ({
				...update,
				read: marks.get(update.updateId)?.read ?? false,
				acknowledged: marks.get(update.updateId)?.acked ?? false,
			}))
			// As times, since the driver hands dates back as dates rather than as text.
			.sort(
				(a, b) =>
					new Date(timelineDate(b)).getTime() -
					new Date(timelineDate(a)).getTime(),
			)
	);
}

// --- Names for authors and automations --------------------------------------------------

const aliasKey = "updates:aliases";

export async function listAliases(): Promise<PersonAlias[]> {
	return cachedDefinition(aliasKey, async () => {
		const rows = await sql<{
			alias: string;
			kind: PersonAlias["kind"];
			email: string | null;
			display_name: string | null;
		}>(
			`SELECT alias, kind, email, display_name FROM update_people_aliases
			 ORDER BY kind, alias`,
		);
		return rows.map((row) => ({
			alias: row.alias,
			kind: row.kind,
			email: row.email,
			displayName: row.display_name,
		}));
	});
}

// GitHub names on updates that nobody has matched to a person yet.
export async function unmatchedGithubNames(): Promise<string[]> {
	const rows = await sql<{ login: string }>(
		`SELECT DISTINCT author->>'github' AS login
		 FROM updates, jsonb_array_elements(authors) AS author
		 WHERE author->>'github' IS NOT NULL AND author->>'email' IS NULL
		   AND NOT EXISTS (
		     SELECT 1 FROM update_people_aliases a
		     WHERE a.kind = 'github' AND lower(a.alias) = lower(author->>'github')
		   )
		 ORDER BY 1`,
	);
	return rows.map((row) => row.login);
}

export async function saveAlias(
	policy: PolicyClass,
	identity: Identity,
	raw: Record<string, unknown>,
): Promise<void> {
	await assertModerates(policy, identity.email);
	const kind = raw.kind === "principal" ? "principal" : "github";
	const alias = String(raw.alias ?? "").trim();
	if (!alias) {
		throw new UpdateError(
			kind === "github"
				? "Say which GitHub name."
				: "Say which service principal.",
		);
	}
	const email =
		String(raw.email ?? "")
			.trim()
			.toLowerCase() || null;
	const displayName = String(raw.displayName ?? "").trim() || null;
	if (kind === "github" && !email && !displayName) {
		throw new UpdateError("Give the person's email or a name to show.");
	}
	if (kind === "principal" && !displayName) {
		throw new UpdateError("Give it a name to show.");
	}
	await sql(
		`INSERT INTO update_people_aliases (alias, kind, email, display_name, set_by)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (alias) DO UPDATE SET
		   kind = EXCLUDED.kind, email = EXCLUDED.email,
		   display_name = EXCLUDED.display_name, set_by = EXCLUDED.set_by,
		   set_on = now()`,
		[alias, kind, email, displayName, identity.email],
	);
	await insertLog({
		recordType: "update",
		recordId: alias,
		action: "save_update_alias",
		changedBy: identity.email,
		newValue: JSON.stringify({ kind, email, displayName }),
	});
	invalidateDefinitions(aliasKey);
}

export async function removeAlias(
	policy: PolicyClass,
	identity: Identity,
	alias: string,
): Promise<void> {
	await assertModerates(policy, identity.email);
	await sql(`DELETE FROM update_people_aliases WHERE alias = $1`, [alias]);
	await insertLog({
		recordType: "update",
		recordId: alias,
		action: "remove_update_alias",
		changedBy: identity.email,
	});
	invalidateDefinitions(aliasKey);
}

// Authors and poster in words, for the screens.
export async function withNames<T extends Update>(
	updates: T[],
): Promise<
	(T & {
		authorsShown: ReturnType<typeof resolveAuthors>;
		poster: string;
	})[]
> {
	const aliases = await listAliases();
	return updates.map((update) => ({
		...update,
		authorsShown: resolveAuthors(update.authors, aliases),
		poster: posterName(update.createdBy, aliases),
	}));
}

// Drafts and retracted entries on top, for whoever may see them. A person's own and
// everything for a moderator, so the timeline can show what is being worked on.
export async function ownDrafts(
	policy: PolicyClass,
	identity: Identity,
): Promise<Update[]> {
	const context = await getExplicitContext(policy, identity.email);
	const moderates = can(
		context.capabilities,
		"update.moderate",
		null,
		context.denied,
	);
	const rows = await sql<UpdateRow>(
		`SELECT ${columns} FROM updates
		 WHERE status = 'draft' AND ($1 OR lower(created_by) = lower($2))
		 ORDER BY posted_on DESC`,
		[moderates, identity.email],
	);
	return rows.map(toUpdate);
}

export async function noteRead(
	email: string,
	updateId: string,
	acknowledged: boolean,
): Promise<void> {
	await sql(
		`INSERT INTO update_reads (update_id, user_email, acked_on)
		 VALUES ($1, lower($2), CASE WHEN $3 THEN now() END)
		 ON CONFLICT (update_id, user_email) DO UPDATE
		 SET acked_on = COALESCE(update_reads.acked_on, EXCLUDED.acked_on)`,
		[updateId, email, acknowledged],
	);
}

export async function readCounts(): Promise<
	Map<string, { reads: number; acks: number }>
> {
	const rows = await sql<{ update_id: string; reads: string; acks: string }>(
		`SELECT update_id::text AS update_id, count(*)::text AS reads,
		        count(acked_on)::text AS acks
		 FROM update_reads GROUP BY update_id`,
	);
	return new Map(
		rows.map((row) => [
			row.update_id,
			{ reads: Number(row.reads), acks: Number(row.acks) },
		]),
	);
}

// A line anyone who can read an update adds to its history, such as what they did about it.
export async function noteOnUpdate(
	policy: PolicyClass,
	identity: Identity,
	updateId: string,
	raw: unknown,
): Promise<void> {
	const note = typeof raw === "string" ? raw.trim().slice(0, 2000) : "";
	if (!note) throw new UpdateError("Write the note first.");
	const visible = await visibleUpdates(policy, identity);
	if (!visible.some((update) => update.updateId === updateId)) {
		throw new UpdateError("Not found", 404);
	}
	await recordEvent(updateId, identity.email, "note", note, null);
}

export async function whoAcknowledged(updateId: string): Promise<string[]> {
	const rows = await sql<{ user_email: string }>(
		`SELECT user_email FROM update_reads
		 WHERE update_id = $1 AND acked_on IS NOT NULL ORDER BY acked_on`,
		[updateId],
	);
	return rows.map((row) => row.user_email);
}

// --- Following ---------------------------------------------------------------------

export async function listFollows(email: string): Promise<Follow[]> {
	return sql<Follow>(
		`SELECT kind, value, mode FROM update_follows
		 WHERE user_email = lower($1) ORDER BY kind, value`,
		[email],
	);
}

export async function setFollow(
	email: string,
	follow: Follow,
	on: boolean,
): Promise<void> {
	if (!on) {
		await sql(
			`DELETE FROM update_follows
			 WHERE user_email = lower($1) AND kind = $2 AND value = $3`,
			[email, follow.kind, follow.value],
		);
		return;
	}
	await sql(
		`INSERT INTO update_follows (user_email, kind, value, mode)
		 VALUES (lower($1), $2, $3, $4)
		 ON CONFLICT (user_email, kind, value) DO UPDATE SET mode = EXCLUDED.mode`,
		[email, follow.kind, follow.value, follow.mode],
	);
}

// --- Maintenance going quiet -----------------------------------------------------------

// Sources expected to be off right now. Read by late data, data rules and alerts, each of
// which keeps recording and just does not tell anyone.
export async function sourcesInMaintenance(): Promise<Set<string>> {
	const all = await publishedUpdates();
	return quietSources(all, Date.now());
}
