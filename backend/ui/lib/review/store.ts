import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { displayNameFromEmail } from "../auth/names";
import { insertLog } from "../activityLog";
import { notify, safeLink } from "../notify/store";
import { canDo, isAdmin } from "../platform/access";
import { effectiveAdminGroups } from "../settings";
import { knownMembers, readThreadForReview } from "../messages/store";
import { shareableTranscript, type SharedTurn } from "../feedback/sharedLog";
import {
	reviewKinds,
	scopeAllows,
	scopeEmails,
	type ReviewKind,
	type ReviewScope,
} from "./scope";

// Reading conversations that are not one's own.
//
// Two kinds, each with its own role: conversations between people, such as
// questions to a report's maintainers, and conversations somebody had with the
// assistant. Neither role reads anything by holding it. A request names what,
// why and for how long, and an administrator decides it. An administrator can
// grant one to themselves, but has to give a reason the same way, the grant is
// marked as their own, and every other administrator is told.
//
// Every opening is recorded. The person whose conversation it is, or every
// member of a group conversation, is told it was read, unless the grant was
// approved as a security investigation. A reviewer reads a group conversation
// from here and never joins it, so its members see no trace of them, and an
// assistant conversation is shown without the rows its queries returned.

export class ReviewError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

const reasonCategories = ["quality", "complaint", "security", "other"] as const;
type ReasonCategory = (typeof reasonCategories)[number];

const capabilityFor: Record<
	ReviewKind,
	"review.groupChats" | "review.assistant"
> = {
	groupChats: "review.groupChats",
	assistant: "review.assistant",
};

const kindWords: Record<ReviewKind, string> = {
	groupChats: "group conversations",
	assistant: "assistant conversations",
};

// The longest a grant runs.
const maxDays = 30;

export async function mayRequest(
	policy: PolicyClass,
	identity: Identity,
	kind: ReviewKind,
): Promise<boolean> {
	return canDo(policy, identity, capabilityFor[kind]);
}

export async function decidesReviews(
	policy: PolicyClass,
	identity: Identity,
): Promise<boolean> {
	return isAdmin(policy) || canDo(policy, identity, "access.grant");
}

// Everybody who decides requests, to tell them of one.
async function deciders(): Promise<string[]> {
	const people = new Set<string>();
	const holders = await sql<{ subject_type: string; subject_id: string }>(
		`SELECT DISTINCT ra.subject_type, ra.subject_id
		 FROM role_assignments ra
		 JOIN role_capabilities rc ON rc.role_id = ra.role_id
		 JOIN roles r ON r.role_id = ra.role_id AND r.is_active
		 WHERE ra.is_active AND ra.scope_type = 'global'
		   AND rc.capability = 'access.grant'
		   AND (ra.expires_on IS NULL OR ra.expires_on > now())`,
	);
	const groups = new Set(effectiveAdminGroups());
	for (const holder of holders) {
		if (holder.subject_type === "user")
			people.add(holder.subject_id.toLowerCase());
		else if (holder.subject_type === "group") groups.add(holder.subject_id);
	}
	for (const members of Object.values(await knownMembers([...groups]))) {
		for (const email of members) people.add(email.toLowerCase());
	}
	return [...people];
}

function cleanScope(raw: unknown): ReviewScope {
	const held = (raw ?? {}) as Record<string, unknown>;
	const date = (value: unknown) =>
		typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
			? value
			: undefined;
	if (
		held.kind === "conversation" &&
		typeof held.id === "string" &&
		/^[0-9a-f-]{36}$/i.test(held.id)
	) {
		return { kind: "conversation", id: held.id };
	}
	if (
		held.kind === "person" &&
		typeof held.email === "string" &&
		held.email.includes("@")
	) {
		return {
			kind: "person",
			email: held.email.trim().toLowerCase(),
			from: date(held.from),
			to: date(held.to),
		};
	}
	if (held.kind === "people" && Array.isArray(held.emails)) {
		const emails = [
			...new Set(
				held.emails
					.filter((e): e is string => typeof e === "string")
					.map((e) => e.trim().toLowerCase())
					.filter((e) => e.includes("@")),
			),
		].slice(0, 50);
		if (emails.length > 0) {
			return {
				kind: "people",
				emails,
				from: date(held.from),
				to: date(held.to),
			};
		}
	}
	if (held.kind === "everyone") {
		return { kind: "everyone", from: date(held.from), to: date(held.to) };
	}
	throw new ReviewError(
		"Choose whose conversations: the people, or everyone.",
	);
}

interface RequestInput {
	kind: ReviewKind;
	scope: ReviewScope;
	reasonCategory: ReasonCategory;
	reason: string;
	durationDays: number;
	security: boolean;
}

function cleanRequest(raw: Record<string, unknown>): RequestInput {
	const kind = String(raw.kind);
	if (!(reviewKinds as readonly string[]).includes(kind)) {
		throw new ReviewError("Say which kind of conversations.");
	}
	const reasonCategory = String(raw.reasonCategory);
	if (!(reasonCategories as readonly string[]).includes(reasonCategory)) {
		throw new ReviewError("Choose why.");
	}
	const reason =
		typeof raw.reason === "string" ? raw.reason.trim().slice(0, 2000) : "";
	if (reason.length < 10) {
		throw new ReviewError("Write the reason in a sentence or two.");
	}
	const days = Math.floor(Number(raw.durationDays));
	if (!Number.isFinite(days) || days < 1 || days > maxDays) {
		throw new ReviewError(`Ask for between 1 and ${maxDays} days.`);
	}
	return {
		kind: kind as ReviewKind,
		scope: cleanScope(raw.scope),
		reasonCategory: reasonCategory as ReasonCategory,
		reason,
		durationDays: days,
		// Only an investigation can keep the people concerned from being told.
		security: raw.security === true && reasonCategory === "security",
	};
}

function describeScope(scope: ReviewScope): string {
	const range = (from?: string, to?: string) =>
		from || to ? ` from ${from ?? "the start"} to ${to ?? "now"}` : "";
	if (scope.kind === "conversation") return "one conversation";
	if (scope.kind === "person" || scope.kind === "people")
		return `${scopeEmails(scope).map(displayNameFromEmail).join(", ")}${range(scope.from, scope.to)}`;
	return `everyone's${range(scope.from, scope.to)}`;
}

export async function requestReview(
	policy: PolicyClass,
	identity: Identity,
	raw: Record<string, unknown>,
): Promise<string> {
	const input = cleanRequest(raw);
	if (!(await mayRequest(policy, identity, input.kind))) {
		throw new ReviewError(
			"You do not have a role that can ask for this.",
			403,
		);
	}
	const rows = await sql<{ request_id: string }>(
		`INSERT INTO review_requests
		   (requester_email, kind, scope, reason_category, reason, duration_days, security)
		 VALUES (lower($1), $2, $3::jsonb, $4, $5, $6, $7)
		 RETURNING request_id::text`,
		[
			identity.email,
			input.kind,
			JSON.stringify(input.scope),
			input.reasonCategory,
			input.reason,
			input.durationDays,
			input.security,
		],
	);
	const requestId = rows[0].request_id;
	await insertLog({
		recordType: "review",
		recordId: requestId,
		action: "review_requested",
		changedBy: identity.email,
		newValue: `${kindWords[input.kind]}: ${describeScope(input.scope)}`,
		notes: input.reason,
	});
	for (const person of await deciders()) {
		if (person === identity.email.toLowerCase()) continue;
		await notify(person, {
			kind: "system",
			title: `${identity.name} asked to read ${kindWords[input.kind]}`,
			body: `${describeScope(input.scope)}, for ${input.durationDays} days. ${input.reason}`.slice(
				0,
				300,
			),
			link: safeLink("/review"),
		}).catch(() => {});
	}
	return requestId;
}

// An administrator granting it to themselves: the same request and reason,
// approved at once, marked as their own, with every other administrator told.
export async function grantToSelf(
	policy: PolicyClass,
	identity: Identity,
	raw: Record<string, unknown>,
): Promise<string> {
	if (!(await decidesReviews(policy, identity))) {
		throw new ReviewError("Only an administrator can grant this.", 403);
	}
	const input = cleanRequest(raw);
	const rows = await sql<{ request_id: string }>(
		`INSERT INTO review_requests
		   (requester_email, kind, scope, reason_category, reason, duration_days,
		    security, state, self_granted, decided_by, decided_on, expires_on)
		 VALUES (lower($1), $2, $3::jsonb, $4, $5, $6, $7, 'approved', TRUE,
		         lower($1), now(), now() + make_interval(days => $6))
		 RETURNING request_id::text`,
		[
			identity.email,
			input.kind,
			JSON.stringify(input.scope),
			input.reasonCategory,
			input.reason,
			input.durationDays,
			input.security,
		],
	);
	const requestId = rows[0].request_id;
	await insertLog({
		recordType: "review",
		recordId: requestId,
		action: "review_self_granted",
		changedBy: identity.email,
		newValue: `${kindWords[input.kind]}: ${describeScope(input.scope)}`,
		notes: input.reason,
	});
	for (const person of await deciders()) {
		if (person === identity.email.toLowerCase()) continue;
		await notify(person, {
			kind: "system",
			title: `${identity.name} granted themselves access to ${kindWords[input.kind]}`,
			body: `${describeScope(input.scope)}, for ${input.durationDays} days. ${input.reason}`.slice(
				0,
				300,
			),
			link: safeLink("/review"),
		}).catch(() => {});
	}
	return requestId;
}

export async function decideReview(
	policy: PolicyClass,
	identity: Identity,
	requestId: string,
	decision: "approve" | "decline" | "revoke",
	note: string,
): Promise<void> {
	if (!(await decidesReviews(policy, identity))) {
		throw new ReviewError("Only an administrator can decide this.", 403);
	}
	const rows = await sql<{
		requester_email: string;
		kind: ReviewKind;
		state: string;
	}>(
		`SELECT requester_email, kind, state FROM review_requests WHERE request_id::text = $1`,
		[requestId],
	);
	const request = rows[0];
	if (!request) throw new ReviewError("Not found", 404);
	if (
		decision !== "revoke" &&
		request.requester_email === identity.email.toLowerCase()
	) {
		throw new ReviewError(
			"Somebody else has to decide your own request. Grant it to yourself instead, with your reason.",
			403,
		);
	}
	const from = decision === "revoke" ? "approved" : "pending";
	const to =
		decision === "approve"
			? "approved"
			: decision === "decline"
				? "declined"
				: "revoked";
	const updated = await sql(
		`UPDATE review_requests
		 SET state = $2, decided_by = lower($3), decided_on = now(), decision_note = $4,
		     expires_on = CASE WHEN $2 = 'approved'
		                       THEN now() + make_interval(days => duration_days)
		                       ELSE expires_on END
		 WHERE request_id::text = $1 AND state = $5
		 RETURNING request_id`,
		[requestId, to, identity.email, note.slice(0, 1000) || null, from],
	);
	if (updated.length === 0)
		throw new ReviewError("This was already decided.", 409);
	await insertLog({
		recordType: "review",
		recordId: requestId,
		action: `review_${to}`,
		changedBy: identity.email,
		notes: note || undefined,
	});
	await notify(request.requester_email, {
		kind: "system",
		title: `Your request to read ${kindWords[request.kind]} was ${to}`,
		body: note.slice(0, 300),
		link: safeLink("/review"),
	}).catch(() => {});
}

interface GrantRow {
	request_id: string;
	requester_email: string;
	kind: ReviewKind;
	scope: ReviewScope;
	reason_category: string;
	reason: string;
	duration_days: number;
	security: boolean;
	state: string;
	self_granted: boolean;
	decided_by: string | null;
	decided_on: string | null;
	decision_note: string | null;
	expires_on: string | null;
	created_on: string;
	views: number;
}

const grantColumns = `r.request_id::text, r.requester_email, r.kind, r.scope,
	r.reason_category, r.reason, r.duration_days, r.security, r.state,
	r.self_granted, r.decided_by, r.decided_on::text, r.decision_note,
	r.expires_on::text, r.created_on::text,
	(SELECT count(*)::int FROM review_views v WHERE v.request_id = r.request_id) AS views`;

// What a person sees on the review page: their own requests, and for an
// administrator everybody's with every reading.
export async function overview(policy: PolicyClass, identity: Identity) {
	const [mayGroup, mayAssistant, decides] = await Promise.all([
		mayRequest(policy, identity, "groupChats"),
		mayRequest(policy, identity, "assistant"),
		decidesReviews(policy, identity),
	]);
	const mine = await sql<GrantRow>(
		`SELECT ${grantColumns} FROM review_requests r
		 WHERE r.requester_email = lower($1) ORDER BY r.created_on DESC LIMIT 100`,
		[identity.email],
	);
	const all = decides
		? await sql<GrantRow>(
				`SELECT ${grantColumns} FROM review_requests r
				 ORDER BY (r.state = 'pending') DESC, r.created_on DESC LIMIT 300`,
			)
		: [];
	const views = decides
		? await sql<{
				viewer: string;
				kind: string;
				target_id: string;
				owner_email: string | null;
				viewed_on: string;
				request_id: string;
				title: string | null;
			}>(
				// The log names what was read by its title, so it reads without
				// opening anything.
				`SELECT v.viewer, v.kind, v.target_id, v.owner_email,
				        v.viewed_on::text, v.request_id::text,
				        CASE v.kind
				          WHEN 'assistant' THEN (SELECT c.title FROM assistant_conversations c
				                                 WHERE c.conversation_id::text = v.target_id)
				          ELSE (SELECT t.subject FROM threads t
				                WHERE t.thread_id::text = v.target_id)
				        END AS title
				 FROM review_views v ORDER BY v.viewed_on DESC LIMIT 300`,
			)
		: [];
	return {
		mayRequest: { groupChats: mayGroup, assistant: mayAssistant },
		decides,
		mine,
		all,
		views,
	};
}

async function activeGrant(
	identity: Identity,
	requestId: string,
): Promise<GrantRow> {
	const rows = await sql<GrantRow>(
		`SELECT ${grantColumns} FROM review_requests r
		 WHERE r.request_id::text = $1 AND r.requester_email = lower($2)
		   AND r.state = 'approved' AND r.expires_on > now()`,
		[requestId, identity.email],
	);
	if (!rows[0])
		throw new ReviewError(
			"You have no current access under this request.",
			403,
		);
	return rows[0];
}

// The conversations a grant reaches, newest first, without opening any.
export async function browse(identity: Identity, requestId: string) {
	const grant = await activeGrant(identity, requestId);
	const scope = grant.scope;
	const from = "from" in scope ? (scope.from ?? null) : null;
	const to = "to" in scope ? (scope.to ?? null) : null;
	if (grant.kind === "assistant") {
		return sql<{
			id: string;
			owner: string;
			title: string;
			modified_on: string;
			questions: number | null;
		}>(
			`SELECT conversation_id::text AS id, owner_email AS owner, title,
			        modified_on::text, questions
			 FROM assistant_conversations
			 WHERE ($1::text IS NULL OR conversation_id::text = $1)
			   AND ($2::text[] IS NULL OR owner_email = ANY($2::text[]))
			   AND ($3::date IS NULL OR modified_on >= $3::date)
			   AND ($4::date IS NULL OR created_on < $4::date + 1)
			 ORDER BY modified_on DESC LIMIT 200`,
			[
				scope.kind === "conversation" ? scope.id : null,
				scopeEmails(scope).length ? scopeEmails(scope) : null,
				from,
				to,
			],
		);
	}
	return sql<{
		id: string;
		owner: string;
		title: string;
		modified_on: string;
		questions: number | null;
	}>(
		`SELECT t.thread_id::text AS id, t.created_by AS owner, t.subject AS title,
		        t.last_message_on::text AS modified_on, NULL::int AS questions
		 FROM threads t
		 WHERE ($1::text IS NULL OR t.thread_id::text = $1)
		   AND ($2::text[] IS NULL OR t.created_by = ANY($2::text[]) OR EXISTS (
		         SELECT 1 FROM thread_members m WHERE m.thread_id = t.thread_id
		           AND m.member_type = 'user' AND m.member_id = ANY($2::text[])))
		   AND ($3::date IS NULL OR t.last_message_on >= $3::date)
		   AND ($4::date IS NULL OR t.created_on < $4::date + 1)
		 ORDER BY t.last_message_on DESC LIMIT 200`,
		[
			scope.kind === "conversation" ? scope.id : null,
			scopeEmails(scope).length ? scopeEmails(scope) : null,
			from,
			to,
		],
	);
}

export type Opened =
	| { kind: "assistant"; owner: string; title: string; turns: SharedTurn[] }
	| {
			kind: "groupChats";
			thread: NonNullable<
				Awaited<ReturnType<typeof readThreadForReview>>
			>;
	  };

// One conversation, read under a grant. Recorded every time, and the people it
// belongs to are told the first time each grant reads it, unless the grant is
// a security investigation.
export async function openUnderGrant(
	identity: Identity,
	requestId: string,
	targetId: string,
): Promise<Opened> {
	const grant = await activeGrant(identity, requestId);
	let opened: Opened;
	let owners: string[];
	let created: string;
	if (grant.kind === "assistant") {
		const rows = await sql<{
			owner_email: string;
			title: string;
			created_on: string;
		}>(
			`SELECT owner_email, title, created_on::text FROM assistant_conversations
			 WHERE conversation_id::text = $1`,
			[targetId],
		);
		const row = rows[0];
		if (!row) throw new ReviewError("Not found", 404);
		const messages = await sql<{ message: unknown }>(
			`SELECT message FROM assistant_messages WHERE conversation_id::text = $1
			 ORDER BY position, created_on, message_id`,
			[targetId],
		);
		opened = {
			kind: "assistant",
			owner: row.owner_email,
			title: row.title,
			turns: shareableTranscript(messages.map((m) => m.message)),
		};
		owners = [row.owner_email];
		created = row.created_on;
	} else {
		const thread = await readThreadForReview(targetId);
		if (!thread) throw new ReviewError("Not found", 404);
		opened = { kind: "groupChats", thread };
		owners = thread.thread.members
			.filter((member) => member.type === "user")
			.map((member) => member.id);
		created = thread.thread.createdOn;
	}
	if (
		!scopeAllows(grant.scope, { id: targetId, owners, createdOn: created })
	) {
		throw new ReviewError(
			"This conversation is outside what was granted.",
			403,
		);
	}
	const before = await sql(
		`SELECT 1 FROM review_views WHERE request_id::text = $1 AND target_id = $2 LIMIT 1`,
		[requestId, targetId],
	);
	await sql(
		`INSERT INTO review_views (request_id, viewer, kind, target_id, owner_email)
		 VALUES ($1, lower($2), $3, $4, $5)`,
		[requestId, identity.email, grant.kind, targetId, owners[0] ?? null],
	);
	await insertLog({
		recordType: "review",
		recordId: requestId,
		action: "review_opened",
		changedBy: identity.email,
		newValue: targetId,
	});
	if (before.length === 0 && !grant.security) {
		for (const owner of owners) {
			await notify(owner, {
				kind: "system",
				title:
					grant.kind === "assistant"
						? "One of your assistant conversations was read for a review"
						: "A conversation you are in was read for a review",
				body: `Read by ${identity.name}. Reason: ${grant.reason}`.slice(
					0,
					300,
				),
				link: null,
			}).catch(() => {});
		}
	}
	return opened;
}
