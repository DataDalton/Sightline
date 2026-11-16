import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql } from "../data/lakebase";
import { canDo } from "../platform/access";
import { reachableSet } from "../platform/sources";
import { withDefaults, type WorkConfig } from "./model";

// Who may do what in the work queue, and the queue's configuration.
//
// Engineers and DevSecOps see every request. Anybody else sees what they asked
// for or watch, and any request that is not restricted and is about a dataset
// they can read, or about no dataset at all. A restricted request stays with
// the people who asked and the engineers.

export class WorkError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export interface WorkActor {
	email: string;
	name: string;
	engineer: boolean;
	devSecOps: boolean;
	mayRequest: boolean;
	// The datasets this person can read, or null when every one is readable.
	readable: Set<string> | null;
}

export async function actorOf(
	policy: PolicyClass,
	identity: Identity,
): Promise<WorkActor> {
	const [engineer, devSecOps, mayRequest, readable] = await Promise.all([
		canDo(policy, identity, "work.engineer"),
		canDo(policy, identity, "work.devsecops"),
		canDo(policy, identity, "work.request"),
		reachableSet(identity),
	]);
	return {
		email: identity.email.toLowerCase(),
		name: identity.name,
		engineer: engineer || devSecOps,
		devSecOps,
		mayRequest,
		readable,
	};
}

// --- Configuration -----------------------------------------------------------

let held: { config: WorkConfig; at: number } | null = null;
const heldForMs = 30_000;

export async function loadConfig(): Promise<WorkConfig> {
	if (held && Date.now() - held.at < heldForMs) return held.config;
	const rows = await sql<{ value: Partial<WorkConfig> }>(
		`SELECT value FROM work_config WHERE key = 'config'`,
	);
	const config = withDefaults(rows[0]?.value ?? null);
	held = { config, at: Date.now() };
	return config;
}

export async function saveConfig(
	actor: WorkActor,
	config: WorkConfig,
): Promise<void> {
	await sql(
		`INSERT INTO work_config (key, value, modified_by, modified_on)
		 VALUES ('config', $1::jsonb, $2, now())
		 ON CONFLICT (key) DO UPDATE
		 SET value = EXCLUDED.value, modified_by = EXCLUDED.modified_by,
		     modified_on = now()`,
		[JSON.stringify(config), actor.email],
	);
	held = null;
}

// --- Seeing a request --------------------------------------------------------

export interface VisibilityFacts {
	visibility: string;
	createdBy: string;
	requesters: string[];
	watchers: string[];
	assignees: string[];
	sources: string[];
}

export function canSee(actor: WorkActor, item: VisibilityFacts): boolean {
	if (actor.engineer) return true;
	const own =
		item.createdBy.toLowerCase() === actor.email ||
		item.requesters.includes(actor.email) ||
		item.watchers.includes(actor.email) ||
		item.assignees.includes(actor.email);
	if (own) return true;
	if (item.visibility === "restricted") return false;
	if (item.sources.length === 0 || actor.readable === null) return true;
	return item.sources.some((source) => actor.readable!.has(source));
}

// The same rule as a SQL condition on work_items aliased w, for lists. Takes
// its parameters from $base onwards: the email, whether the reader is an
// engineer, and the datasets they can read (null for all).
export function visibleSql(base: number): string {
	const email = `$${base}`;
	const engineer = `$${base + 1}`;
	const readable = `$${base + 2}`;
	return `(${engineer}::boolean
		OR w.created_by = ${email}
		OR ${email} = ANY(w.assignees)
		OR EXISTS (SELECT 1 FROM work_requesters r WHERE r.item_id = w.item_id AND r.user_email = ${email})
		OR EXISTS (SELECT 1 FROM work_watchers x WHERE x.item_id = w.item_id AND x.user_email = ${email} AND x.watching)
		OR (w.visibility = 'normal' AND (
			${readable}::text[] IS NULL
			OR NOT EXISTS (SELECT 1 FROM work_links l WHERE l.item_id = w.item_id AND l.kind = 'source')
			OR EXISTS (SELECT 1 FROM work_links l WHERE l.item_id = w.item_id AND l.kind = 'source' AND l.target = ANY(${readable}::text[]))
		)))`;
}

export function visibleParams(actor: WorkActor): unknown[] {
	return [
		actor.email,
		actor.engineer,
		actor.readable === null ? null : [...actor.readable],
	];
}
