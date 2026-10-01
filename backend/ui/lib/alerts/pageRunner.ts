import { sql, transaction } from "../data/lakebase";
import { pageLink } from "../deliveries/store";
import { notifyManyInTransaction, pushNotifications } from "../notify/store";
import type { RowRestriction } from "../query/builder";
import type { QuerySpec } from "../query/spec";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import {
	groupSubscribers,
	ownerPassPlan,
	ownerScopeKey,
	scopeMode,
	type FollowedAlert,
	type ScopeGroup,
	type Subscriber,
} from "./pageRules";
import type { BatchReads } from "./reads";
import { restrictableSources, restrictionsFor } from "./recorded";
import {
	describeFirings,
	evaluate,
	type AlertDefinition,
	type AlertState,
	type Firing,
	type Reading,
} from "./rule";
import { probeSpec, readingsFrom, readUnusual, type ReadSpec } from "./runner";
import { nextRun } from "./schedule";
import { unusualContext } from "./settlingContext";
import { alertSpec, runsUnattended, wordingFor } from "./store";

// Running page alerts, on the timer and while subscribers use the app.
//
// Each due alert is judged once per access scope among its subscribers. A
// dataset that shows everybody the same rows is read once as the app for all
// of them. A row-filtered one is read once for each distinct recording of what
// its subscribers can see, narrowed to it. Each scope keeps its own state and
// tells only the people in it, so nobody is ever sent a figure worked out from
// rows they cannot see.
//
// Only subscribers seen able to read the dataset recently count, and the reads
// go through the same batch as the personal alerts of the tick, so the two
// share questions and the pages' result cache.
//
// A dataset that can be read neither way is read for each subscriber under
// their own token while they are using the app, in a scope of their own, on
// the alert's schedule. See runPageAlertsForOwner.

// How long a claimed alert is held before another replica may take it. The
// same lease personal alerts are claimed under.
const claimLease = "15 minutes";

// How recently a subscriber has to have been seen able to read the dataset.
// The same window a personal alert's owner is held to.
const accessWindow = "24 hours";

// Page alerts claimed per replica per tick.
const batchSize = 20;

interface ClaimedRow {
	alert_id: string;
	name: string;
	source_key: string;
	definition: AlertDefinition;
	slug: string;
	report_title: string;
	page_title: string;
	first_page: boolean;
	report_id: string;
	page_id: string;
	// When the alert last finished a round, so a scope checked since then
	// belongs to the round under way.
	round_from: string | null;
}

// What a scope's check produced, before it is written.
interface Judged {
	state: AlertState;
	firings: Firing[];
	error: string | null;
}

async function judge(
	definition: AlertDefinition,
	source: SemanticSource | null,
	previous: AlertState,
	reads: BatchReads,
	restriction: RowRestriction | undefined,
): Promise<Judged> {
	try {
		if (!source) throw new Error("The dataset is no longer available.");
		const read: ReadSpec = (spec) => reads.read(source, spec, restriction);
		let readings: Reading[];
		if (definition.condition === "unusual") {
			readings = await readUnusual(
				source,
				definition,
				read,
				await unusualContext(source, definition),
				previous,
			);
		} else {
			readings = readingsFrom(
				definition,
				await read(alertSpec(source, definition)),
			);
		}
		const outcome = evaluate(definition, readings, previous);
		return { state: outcome.state, firings: outcome.firings, error: null };
	} catch (e) {
		return {
			state: previous,
			firings: [],
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

// Judges one scope and writes what it found. The state, the event and every
// inbox entry land in one transaction, and the state is only written while it
// still holds the check this one started from, so two replicas judging the
// same scope at once cannot both tell people.
async function checkScope(
	row: ClaimedRow,
	source: SemanticSource | null,
	group: ScopeGroup<RowRestriction>,
	reads: BatchReads,
	next: Date,
): Promise<void> {
	const held = await sql<{ state: AlertState; last_checked_on: string }>(
		`SELECT state, last_checked_on::text AS last_checked_on
		 FROM page_alert_state WHERE alert_id = $1::uuid AND scope_key = $2`,
		[row.alert_id, group.key],
	);
	const previous = held[0]?.state ?? {};
	const lastChecked = held[0]?.last_checked_on ?? null;

	const outcome = await judge(
		row.definition,
		source,
		previous,
		reads,
		group.restriction ?? undefined,
	);
	const message = outcome.error
		? null
		: describeFirings(
				row.name,
				wordingFor(row.definition),
				outcome.firings,
			);
	const where = `On the ${row.page_title} page of ${row.report_title}.`;
	const link = pageLink(row.slug, row.page_title, row.first_page === true);

	const items = await transaction(async (client) => {
		const saved = await client.query(
			`INSERT INTO page_alert_state
			   (alert_id, scope_key, state, last_checked_on, next_check_on,
			    last_status, last_error)
			 VALUES ($1::uuid, $2, $3, now(), $4, $5, $6)
			 ON CONFLICT (alert_id, scope_key) DO UPDATE SET
			   state = EXCLUDED.state,
			   last_checked_on = EXCLUDED.last_checked_on,
			   next_check_on = EXCLUDED.next_check_on,
			   last_status = EXCLUDED.last_status,
			   last_error = EXCLUDED.last_error
			 WHERE page_alert_state.last_checked_on
			       IS NOT DISTINCT FROM $7::timestamptz
			 RETURNING 1`,
			[
				row.alert_id,
				group.key,
				JSON.stringify(outcome.state),
				next.toISOString(),
				outcome.error ? "error" : "ok",
				outcome.error ? outcome.error.slice(0, 500) : null,
				lastChecked,
			],
		);
		if (!saved.rowCount || !message) return [];
		await client.query(
			`INSERT INTO page_alert_events
			   (alert_id, scope_key, title, body, firings, recipients)
			 VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
			[
				row.alert_id,
				group.key,
				message.title,
				message.body,
				outcome.firings.length,
				group.recipients.length,
			],
		);
		return notifyManyInTransaction(client, group.recipients, {
			kind: "alert",
			title: message.title,
			body: `${where}\n${message.body}`,
			link,
			data: {
				pageAlertId: row.alert_id,
				reportId: row.report_id,
				pageId: row.page_id,
			},
		});
	});

	// Pushed once the entries are committed, so no device hears of one that
	// rolled back.
	pushNotifications(items);
}

// How many scopes of one alert are checked at once.
const scopeWorkers = 3;

// The timer's hold on one claimed alert. The lease starts again after each
// scope, so an alert with many scopes is not taken by another replica part
// way through. Renewals run one after another, each from the lease the last
// one set.
class AlertClaim {
	lost = false;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly alertId: string,
		private lease: string,
	) {}

	renew(): Promise<void> {
		this.chain = this.chain.then(async () => {
			if (this.lost) return;
			try {
				const rows = await sql<{ lease: string }>(
					`UPDATE page_alerts
					 SET next_check_on = now() + interval '${claimLease}'
					 WHERE alert_id = $1::uuid
					   AND next_check_on = $2::timestamptz
					 RETURNING next_check_on::text AS lease`,
					[this.alertId, this.lease],
				);
				if (rows[0]) this.lease = rows[0].lease;
				else this.lost = true;
			} catch (error) {
				// The lease stands as it was and runs out on its own.
				console.warn(
					`Page alert ${this.alertId} could not renew its claim:`,
					error,
				);
			}
		});
		return this.chain;
	}

	// Finishes the round while this replica still holds the alert. One that
	// lost it leaves the round to whichever replica took it over.
	async finish(next: Date): Promise<void> {
		await this.chain;
		if (this.lost) return;
		await sql(
			`UPDATE page_alerts SET next_check_on = $2, last_checked_on = now()
			 WHERE alert_id = $1::uuid AND next_check_on = $3::timestamptz`,
			[this.alertId, next.toISOString(), this.lease],
		);
	}
}

async function runOne(
	row: ClaimedRow,
	claim: AlertClaim,
	reads: BatchReads,
	unattended: Set<string>,
	restrictable: Set<string>,
): Promise<void> {
	const source = getSource(row.source_key) ?? null;
	const mode = scopeMode(
		unattended.has(row.source_key),
		restrictable.has(row.source_key),
	);
	const next = nextRun(row.definition.schedule, new Date());

	const subscribers = await sql<{
		email: string;
		muted_until: string | null;
		confirmed: boolean;
	}>(
		`SELECT email, muted_until::text AS muted_until,
		        coalesce(access_confirmed_on
		                   > now() - interval '${accessWindow}', false)
		          AS confirmed
		 FROM page_alert_subscriptions WHERE alert_id = $1::uuid`,
		[row.alert_id],
	);
	const listed: Subscriber[] = subscribers.map((s) => ({
		email: s.email,
		mutedUntil: s.muted_until,
		confirmed: s.confirmed,
	}));
	const restrictions =
		mode === "perAccess"
			? await restrictionsFor(
					listed.filter((s) => s.confirmed).map((s) => s.email),
					row.source_key,
				)
			: new Map<string, RowRestriction>();
	const groups = groupSubscribers(
		listed,
		mode,
		(email) => restrictions.get(email) ?? null,
	);

	// Scopes checked since the alert last finished a round were checked in
	// this one, by a replica whose claim ran out before it finished.
	const done =
		groups.length === 0
			? []
			: await sql<{ scope_key: string }>(
					`SELECT scope_key FROM page_alert_state
					 WHERE alert_id = $1::uuid AND scope_key = ANY($2::text[])
					   AND last_checked_on
					       > coalesce($3::timestamptz, '-infinity'::timestamptz)`,
					[row.alert_id, groups.map((g) => g.key), row.round_from],
				);
	const checked = new Set(done.map((d) => d.scope_key));
	const queue = groups.filter((group) => !checked.has(group.key));

	const workers = Array.from(
		{ length: Math.min(scopeWorkers, queue.length) },
		async () => {
			for (let group = queue.shift(); group; group = queue.shift()) {
				if (claim.lost) return;
				await checkScope(row, source, group, reads, next).catch(
					(error) => {
						console.warn(
							`Page alert ${row.alert_id} could not be checked in one scope:`,
							error,
						);
					},
				);
				await claim.renew();
			}
		},
	);
	await Promise.all(workers);

	await claim.finish(next);
}

// The first question each alert asks as the app without a restriction, so
// cached answers to the whole batch are looked up at once.
function plannedReads(
	rows: ClaimedRow[],
	unattended: Set<string>,
): { source: SemanticSource; spec: QuerySpec }[] {
	const out: { source: SemanticSource; spec: QuerySpec }[] = [];
	for (const row of rows) {
		if (!unattended.has(row.source_key)) continue;
		const source = getSource(row.source_key);
		if (!source) continue;
		try {
			const spec =
				row.definition.condition === "unusual"
					? probeSpec(source, row.definition)
					: alertSpec(source, row.definition);
			if (spec) out.push({ source, spec });
		} catch {
			// Reported by the check itself.
		}
	}
	return out;
}

let running = false;

// Claims the page alerts that are due and can be read for their subscribers,
// and checks them. unattended and restrictable are the datasets that can be
// read as the app, without and with a restriction. Called from the alert
// timer with that tick's batch of reads.
export async function runDuePageAlerts(
	reads: BatchReads,
	unattended: string[],
	restrictable: string[],
): Promise<void> {
	if (running) return;
	if (unattended.length === 0 && restrictable.length === 0) return;
	running = true;
	try {
		// Claimed in one statement, so two replicas take different alerts. An
		// alert nobody follows is left until somebody does.
		const claimed = await sql<{ alert_id: string; lease: string }>(
			`UPDATE page_alerts SET next_check_on = now() + interval '${claimLease}'
			 WHERE alert_id IN (
			   SELECT a.alert_id FROM page_alerts a
			   JOIN report_pages p ON p.page_id = a.page_id AND p.is_active
			   JOIN reports r ON r.report_id = a.report_id AND r.is_active
			   WHERE a.is_active
			     AND a.next_check_on <= now()
			     AND (a.source_key = ANY($1::text[])
			          OR a.source_key = ANY($3::text[]))
			     AND EXISTS (SELECT 1 FROM page_alert_subscriptions s
			                 WHERE s.alert_id = a.alert_id)
			   ORDER BY a.next_check_on
			   LIMIT $2
			   FOR UPDATE OF a SKIP LOCKED
			 )
			 RETURNING alert_id::text AS alert_id,
			           next_check_on::text AS lease`,
			[unattended, batchSize, restrictable],
		);
		if (claimed.length === 0) return;

		const rows = await sql<ClaimedRow>(
			`SELECT a.alert_id::text AS alert_id, a.name, a.source_key,
			        a.definition, r.slug, r.title AS report_title,
			        p.title AS page_title,
			        a.report_id::text AS report_id,
			        a.page_id::text AS page_id,
			        a.last_checked_on::text AS round_from,
			        p.sort_order = (SELECT min(q.sort_order) FROM report_pages q
			                        WHERE q.report_id = a.report_id
			                          AND q.is_active) AS first_page
			 FROM page_alerts a
			 JOIN reports r ON r.report_id = a.report_id
			 JOIN report_pages p ON p.page_id = a.page_id
			 WHERE a.alert_id::text = ANY($1::text[])`,
			[claimed.map((c) => c.alert_id)],
		);

		const open = new Set(unattended);
		const filtered = new Set(restrictable);
		await reads
			.prefetch(plannedReads(rows, open))
			.catch((error) =>
				console.warn("Page alert cache lookup failed:", error),
			);

		// Three at a time, as personal alerts are checked.
		const leases = new Map(claimed.map((c) => [c.alert_id, c.lease]));
		const queue = [...rows];
		const workers = Array.from({ length: 3 }, async () => {
			for (let row = queue.shift(); row; row = queue.shift()) {
				const claim = new AlertClaim(
					row.alert_id,
					leases.get(row.alert_id) ?? "",
				);
				await runOne(row, claim, reads, open, filtered).catch(
					(error) => {
						console.warn(
							`Page alert ${row.alert_id} failed:`,
							error,
						);
					},
				);
			}
		});
		await Promise.all(workers);
	} finally {
		running = false;
	}
}

// --- While a subscriber is here ------------------------------------------

interface FollowedRow extends ClaimedRow {
	muted_until: string | null;
	confirmed: boolean;
	next_check_on: string | null;
}

// Checks, under the subscriber's own token, each followed page alert whose
// dataset the timer cannot read for them, once their own scope is due. Called
// from the owner pass in lib/alerts/runner, which is already held back per
// person per replica, with that pass's batch of reads so identical questions
// from their personal alerts and page alerts are asked once.
//
// readable is what the subscriber can read now, or null for everything.
export async function runPageAlertsForOwner(
	email: string,
	readable: string[] | null,
	reads: BatchReads,
): Promise<void> {
	const owner = email.toLowerCase();
	const key = ownerScopeKey(owner);
	const rows = await sql<FollowedRow>(
		`SELECT a.alert_id::text AS alert_id, a.name, a.source_key,
		        a.definition, r.slug, r.title AS report_title,
		        p.title AS page_title,
		        a.report_id::text AS report_id,
		        a.page_id::text AS page_id,
		        a.last_checked_on::text AS round_from,
		        p.sort_order = (SELECT min(q.sort_order) FROM report_pages q
		                        WHERE q.report_id = a.report_id
		                          AND q.is_active) AS first_page,
		        s.muted_until::text AS muted_until,
		        coalesce(s.access_confirmed_on
		                   > now() - interval '${accessWindow}', false)
		          AS confirmed,
		        st.next_check_on::text AS next_check_on
		 FROM page_alert_subscriptions s
		 JOIN page_alerts a  ON a.alert_id = s.alert_id AND a.is_active
		 JOIN reports r      ON r.report_id = a.report_id AND r.is_active
		 JOIN report_pages p ON p.page_id = a.page_id AND p.is_active
		 LEFT JOIN page_alert_state st
		        ON st.alert_id = a.alert_id AND st.scope_key = $2
		 WHERE s.email = $1
		   AND ($3::text[] IS NULL OR a.source_key = ANY($3::text[]))`,
		[owner, key, readable],
	);
	if (rows.length === 0) return;

	const restrictable = await restrictableSources();
	const byId = new Map(rows.map((row) => [row.alert_id, row]));
	const followed: FollowedAlert[] = rows.map((row) => ({
		alertId: row.alert_id,
		mode: scopeMode(
			runsUnattended(getSource(row.source_key) ?? null),
			restrictable.has(row.source_key),
		),
		mutedUntil: row.muted_until,
		confirmed: row.confirmed,
		nextCheckOn: row.next_check_on,
	}));

	for (const planned of ownerPassPlan(followed).slice(0, batchSize)) {
		const row = byId.get(planned.alertId);
		if (!row) continue;
		// Claimed as the timer claims, so a second replica serving the same
		// person at once does not check the same scope. A check that fails
		// before writing is taken again once the lease runs out.
		const claimed = await sql(
			`INSERT INTO page_alert_state (alert_id, scope_key, next_check_on)
			 VALUES ($1::uuid, $2, now() + interval '${claimLease}')
			 ON CONFLICT (alert_id, scope_key) DO UPDATE SET
			   next_check_on = EXCLUDED.next_check_on
			 WHERE page_alert_state.next_check_on IS NULL
			    OR page_alert_state.next_check_on <= now()
			 RETURNING 1`,
			[row.alert_id, key],
		);
		if (claimed.length === 0) continue;

		const group: ScopeGroup<RowRestriction> = {
			key,
			restriction: null,
			members: [owner],
			recipients: planned.notify ? [owner] : [],
		};
		await checkScope(
			row,
			getSource(row.source_key) ?? null,
			group,
			reads,
			nextRun(row.definition.schedule, new Date()),
		).catch((error) => {
			console.warn(
				`Page alert ${row.alert_id} could not be checked for ${owner}:`,
				error,
			);
		});
	}
}
