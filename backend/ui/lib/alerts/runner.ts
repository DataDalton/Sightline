import type { Identity } from "../auth/identity";
import { queryAsApp } from "../data/appSession";
import { sql, transaction } from "../data/lakebase";
import type { QueryParams, Row } from "../data/types";
import { queryAsUser } from "../data/userSession";
import { encodeState } from "../explore/state";
import { groupLabel, toNumber } from "../format";
import { notify } from "../notify/store";
import { confirmableSources, reachableSet } from "../platform/sources";
import { compileQuery, type RowRestriction } from "../query/builder";
import { maxLimit, parseQuerySpec } from "../query/spec";
import type { SemanticSource } from "../semantic/types";
import {
	periodKey,
	readAnomalies,
	spacingDays,
	targetPeriod,
	todayIn,
	windowStart,
} from "./anomaly";
import { isDatabricksApp } from "../runtime";
import { getSource, listSources } from "../semantic/registry";
import { settings } from "../settings";
import {
	describeFirings,
	evaluate,
	maxGroups,
	type AlertDefinition,
	type Firing,
	type Reading,
} from "./rule";
import { nextRun } from "./schedule";
import {
	recordAccess,
	recordingWindow,
	restrictableSources,
	restrictionFor,
} from "./recorded";
import {
	alertColumns,
	alertSpec,
	checkDefinition,
	runsUnattended,
	toRecord,
	wordingFor,
	type AlertRecord,
	type AlertRow,
} from "./store";

// Running alerts: reading the measure, deciding, writing the inbox.
//
// Two ways in. The timer checks, as the application, alerts whose dataset
// shows everyone the same rows, and alerts on a row-filtered dataset narrowed
// to what their owner was recorded seeing. A request from an owner checks the
// rest of theirs under their own token while they are here, and takes those
// recordings. See runsUnattended and lib/alerts/access for why.

export type RunQuery = (
	statement: string,
	params: QueryParams,
) => Promise<Row[]>;

// How long a claimed alert is held before another replica may take it, in
// case the one that claimed it went away mid-check.
const claimLease = "15 minutes";

// How recently the owner has to have been seen able to read the dataset for a
// check to run without them. The same ceiling the app puts on a stored answer
// to what somebody can read, so a withdrawn grant stops alerts no later than
// it stops everything else.
const accessWindow = "24 hours";

// Alerts checked per replica per tick. The rest wait for the next tick, which
// is a minute away.
const batchSize = 20;

function readingsFrom(definition: AlertDefinition, rows: Row[]): Reading[] {
	if (!definition.groupBy) {
		const value = rows[0] ? toNumber(rows[0][definition.measure]) : null;
		return [{ group: null, value }];
	}
	const seen = new Set<string>();
	const out: Reading[] = [];
	for (const row of rows) {
		const group = groupLabel(row[definition.groupBy]);
		// A group listed twice would be tested twice against one state.
		if (seen.has(group)) continue;
		seen.add(group);
		out.push({ group, value: toNumber(row[definition.measure]) });
	}
	return out;
}

// Reads an unusual alert, comparing each group's latest finished period with
// its usual, from the measure's own history.
//
// Two questions. The first finds how long one period of the date field is
// and which is the latest finished, from the dates themselves, since a field
// may hold days, weeks or months. The second reads just the history the
// comparison needs, split by group.
async function readUnusual(
	source: SemanticSource,
	definition: AlertDefinition,
	run: RunQuery,
	restriction?: RowRestriction,
): Promise<Reading[]> {
	const settings = definition.anomaly;
	if (!settings) return [];
	const timeField = settings.timeField;
	const base = alertSpec(source, definition);
	const options = restriction ? { restriction } : undefined;

	const probe = compileQuery(
		source,
		parseQuerySpec({
			...base,
			dimensions: [timeField],
			sort: [{ field: timeField, direction: "desc" }],
			limit: 60,
			offset: 0,
		}),
		options,
	);
	const recent = await run(probe.sql, probe.params);
	const keys = recent
		.map((row) => periodKey(row[timeField]))
		.filter((k): k is string => k !== null);
	const today = todayIn(definition.schedule.timeZone);
	const spacing = spacingDays(keys);
	const target = targetPeriod(keys, spacing, today);
	if (!target) return [];

	const history = compileQuery(
		source,
		parseQuerySpec({
			...base,
			dimensions: definition.groupBy
				? [timeField, definition.groupBy]
				: [timeField],
			filters: [
				...base.filters,
				{
					field: timeField,
					op: "gte",
					value: windowStart(settings, spacing, target),
				},
				{ field: timeField, op: "lte", value: target },
			],
			sort: [{ field: timeField, direction: "desc" }],
			limit: maxLimit,
			offset: 0,
		}),
		options,
	);
	const rows = await run(history.sql, history.params);
	const { readings } = readAnomalies(rows, {
		timeField,
		groupBy: definition.groupBy,
		measure: definition.measure,
		settings,
		today,
	});
	return readings.slice(0, maxGroups);
}

// Where a notification takes somebody: Explore, holding the same numbers the
// alert read, so the tap lands on the figures rather than on a description.
export function exploreLink(definition: AlertDefinition): string {
	const state = encodeState({
		sourceKey: definition.sourceKey,
		columns: definition.groupBy
			? [definition.groupBy, definition.measure]
			: [definition.measure],
		conditions: definition.conditions,
	});
	return `/explore/?q=${state}`;
}

export interface CheckOutcome {
	record: AlertRecord;
	readings: Reading[];
	firings: Firing[];
	error: string | null;
}

async function check(
	row: AlertRow,
	run: RunQuery,
	reschedule: boolean,
	// Set when the check runs as the app on a row-filtered dataset, so it has
	// to be narrowed to what the owner was recorded seeing.
	restricted = false,
	// The time to put back when the check does not move the schedule, because
	// claiming the row moved it to the end of the lease.
	keep: string | null = null,
): Promise<CheckOutcome> {
	const definition = row.definition;
	const now = new Date();
	const next = reschedule ? nextRun(definition.schedule, now) : null;
	let message: ReturnType<typeof describeFirings> = null;

	let readings: Reading[] = [];
	let firings: Firing[] = [];
	let error: string | null = null;
	let waiting = false;
	let state = row.state ?? {};

	try {
		const source = getSource(definition.sourceKey);
		if (!source) throw new Error("The dataset is no longer available.");

		const restriction = restricted
			? await restrictionFor(row.owner_email, definition.sourceKey)
			: undefined;
		if (restriction === null) {
			// The recording lapsed between the claim and the check. Nothing
			// is read, and the next visit takes a new one.
			waiting = true;
			throw new Error(
				"Waiting for you to open the app, to confirm what you can see.",
			);
		}

		if (definition.condition === "unusual") {
			readings = await readUnusual(source, definition, run, restriction);
		} else {
			const compiled = compileQuery(
				source,
				alertSpec(source, definition),
				{ restriction },
			);
			const rows = await run(compiled.sql, compiled.params);
			readings = readingsFrom(definition, rows);
		}
		const outcome = evaluate(definition, readings, state);
		state = outcome.state;
		firings = outcome.firings;

		message = describeFirings(row.name, wordingFor(definition), firings);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		message = null;
	}

	// The new state and the event it produced land together. The save only
	// applies while the row still holds the check this one started from, so
	// two checks of the same alert running at once cannot both fire. The
	// second finds the row moved on and writes nothing.
	const saved = await transaction(async (client) => {
		const updated = await client.query<AlertRow>(
			`UPDATE alert_rules SET
			   state = $2,
			   last_checked_on = now(),
			   last_status = $3,
			   last_error = $4,
			   next_check_on = coalesce($5::timestamptz, $7::timestamptz,
			                            next_check_on)
			 WHERE rule_id = $1
			   AND last_checked_on IS NOT DISTINCT FROM $6::timestamptz
			 RETURNING ${alertColumns}`,
			[
				row.rule_id,
				JSON.stringify(state),
				waiting ? "waiting" : error ? "error" : "ok",
				error ? error.slice(0, 500) : null,
				next ? next.toISOString() : null,
				row.last_checked_on,
				keep,
			],
		);
		const record = updated.rows[0];
		if (!record) return null;
		if (message) {
			await client.query(
				`INSERT INTO alert_events (rule_id, title, body, firings)
				 VALUES ($1, $2, $3, $4)`,
				[row.rule_id, message.title, message.body, firings.length],
			);
		}
		return record;
	});

	if (!saved) {
		const current = await sql<AlertRow>(
			`SELECT ${alertColumns} FROM alert_rules WHERE rule_id = $1`,
			[row.rule_id],
		);
		return {
			record: toRecord(current[0] ?? row),
			readings,
			firings: [],
			error,
		};
	}

	// Sent once the event is committed. A notification that fails here is
	// lost rather than the alert firing a second time.
	if (message) {
		await notify(row.owner_email, {
			kind: "alert",
			title: message.title,
			body: message.body,
			link: exploreLink(definition),
			data: { ruleId: row.rule_id },
		}).catch((e) => {
			console.warn(`Alert ${row.rule_id} notification failed:`, e);
		});
	}

	return {
		record: toRecord(saved),
		readings,
		firings,
		error,
	};
}

async function runAll(
	rows: AlertRow[],
	run: RunQuery,
	restricted: (row: AlertRow) => boolean = () => false,
): Promise<void> {
	// Three at a time: enough to clear an hour's batch quickly, not so many
	// that alerts crowd out the readers using the same warehouse.
	const queue = [...rows];
	const workers = Array.from({ length: 3 }, async () => {
		for (let row = queue.shift(); row; row = queue.shift()) {
			await check(row, run, true, restricted(row)).catch((error) => {
				console.warn(`Alert ${row.rule_id} check failed:`, error);
			});
		}
	});
	await Promise.all(workers);
}

export async function asApp(statement: string, params: QueryParams) {
	if (!isDatabricksApp) {
		const { queryLocally } = await import("../data/localSession");
		return queryLocally(statement, params);
	}
	return queryAsApp(statement, params);
}

export function asOwner(identity: Identity): RunQuery | null {
	if (identity.userToken) {
		const token = identity.userToken;
		return (statement, params) =>
			queryAsUser(token, statement, params, identity.email.toLowerCase());
	}
	if (!isDatabricksApp) {
		return async (statement, params) => {
			const { queryLocally } = await import("../data/localSession");
			return queryLocally(statement, params);
		};
	}
	return null;
}

// --- On the timer ----------------------------------------------------------

let running = false;

export async function runScheduledAlerts(): Promise<void> {
	if (!settings().alertsEnabled || running) return;
	running = true;
	try {
		const unattended = listSources()
			.filter((s) => runsUnattended(s))
			.map((s) => s.sourceKey);
		const restrictable = [...(await restrictableSources()).keys()];
		if (unattended.length === 0 && restrictable.length === 0) return;

		// Claimed in one statement, so two replicas ticking at once take
		// different alerts rather than both checking the same one.
		//
		// Two kinds are due. One is on a dataset that shows everybody the same
		// rows. The other is on a row-filtered dataset for an owner with a
		// current recording of what they can see, which the check is narrowed
		// to.
		const rows = await sql<AlertRow>(
			`UPDATE alert_rules SET next_check_on = now() + interval '${claimLease}'
			 WHERE rule_id IN (
			   SELECT r.rule_id FROM alert_rules r
			   WHERE r.enabled
			     AND r.next_check_on <= now()
			     AND r.access_confirmed_on > now() - interval '${accessWindow}'
			     AND (
			       r.source_key = ANY($1::text[])
			       OR (
			         r.source_key = ANY($3::text[])
			         AND EXISTS (
			           SELECT 1 FROM alert_access a
			           WHERE a.owner_email = r.owner_email
			             AND a.source_key = r.source_key
			             AND NOT a.too_many
			             AND a.captured_on > now() - interval '${recordingWindow}'
			         )
			       )
			     )
			   ORDER BY r.next_check_on
			   LIMIT $2
			   FOR UPDATE SKIP LOCKED
			 )
			 RETURNING ${alertColumns}`,
			[unattended, batchSize, restrictable],
		);
		const open = new Set(unattended);
		if (rows.length > 0) {
			await runAll(rows, asApp, (row) => !open.has(row.source_key));
		}
	} finally {
		running = false;
	}
}

// --- While the owner is here -----------------------------------------------

const lastOwnerRun = new Map<string, number>();
const ownerThrottleMs = 60 * 1000;

// Called from a request the owner made. Returns straight away, and the checks run
// behind it.
export function runAlertsForOwner(identity: Identity): void {
	if (!settings().alertsEnabled) return;
	const email = identity.email.toLowerCase();
	const now = Date.now();
	if (now - (lastOwnerRun.get(email) ?? 0) < ownerThrottleMs) return;
	lastOwnerRun.set(email, now);
	if (lastOwnerRun.size > 10000) lastOwnerRun.clear();

	const run = asOwner(identity);
	if (!run) return;

	void (async () => {
		const reachable = await reachableSet(identity);
		const readable = reachable ? [...reachable] : null;

		// Seeing the owner able to read a dataset is what lets its alerts
		// keep running on the timer while they are away.
		const confirmable = await confirmableSources(identity);
		await sql(
			`UPDATE alert_rules SET access_confirmed_on = now()
			 WHERE owner_email = $1
			   AND ($2::text[] IS NULL OR source_key = ANY($2::text[]))`,
			[email, confirmable ? [...confirmable] : null],
		);

		// What they can see of each row-filtered dataset they have alerts on,
		// so those alerts keep running on the timer too.
		await recordAccess(identity, run, readable);

		const rows = await sql<AlertRow>(
			`UPDATE alert_rules SET next_check_on = now() + interval '${claimLease}'
			 WHERE rule_id IN (
			   SELECT rule_id FROM alert_rules
			   WHERE enabled
			     AND owner_email = $1
			     AND next_check_on <= now()
			     AND ($2::text[] IS NULL OR source_key = ANY($2::text[]))
			   ORDER BY next_check_on
			   LIMIT $3
			   FOR UPDATE SKIP LOCKED
			 )
			 RETURNING ${alertColumns}`,
			[email, readable, batchSize],
		);
		if (rows.length > 0) await runAll(rows, run);
	})().catch((error) => {
		console.warn(`Alerts for ${email} could not be checked:`, error);
	});
}

// --- On request ------------------------------------------------------------

// "Check now": the owner's own alert, under their own token, recorded like
// any other check but without moving the schedule.
export async function checkAlertNow(
	identity: Identity,
	id: string,
): Promise<CheckOutcome | null> {
	const run = asOwner(identity);
	if (!run) throw new Error("A user token is required to check an alert.");
	const rows = await sql<AlertRow>(
		`SELECT ${alertColumns} FROM alert_rules
		 WHERE owner_email = $1 AND rule_id = $2`,
		[identity.email.toLowerCase(), id],
	);
	if (!rows[0]) return null;
	// The owner may have lost the dataset since saving.
	await checkDefinition(identity, rows[0].definition);

	// Claimed as the timer claims, so the timer does not take the same alert
	// while this check runs. The time it was due is put back afterwards.
	const claimed = await transaction(async (client) => {
		const held = await client.query<AlertRow>(
			`SELECT ${alertColumns} FROM alert_rules
			 WHERE owner_email = $1 AND rule_id = $2
			 FOR UPDATE`,
			[identity.email.toLowerCase(), id],
		);
		const found = held.rows[0];
		if (!found) return null;
		await client.query(
			`UPDATE alert_rules
			 SET next_check_on = now() + interval '${claimLease}'
			 WHERE rule_id = $1`,
			[found.rule_id],
		);
		return found;
	});
	if (!claimed) return null;
	return check(claimed, run, false, false, claimed.next_check_on);
}

// What an alert would read right now, before it is saved.
export async function previewAlert(
	identity: Identity,
	raw: unknown,
): Promise<{
	readings: Reading[];
	firings: Firing[];
	formatted: string[];
	// For an unusual alert, each group's usual range in words.
	usual: (string | null)[];
}> {
	const run = asOwner(identity);
	if (!run) throw new Error("A user token is required to preview an alert.");
	const { definition, source } = await checkDefinition(identity, raw);
	let readings: Reading[];
	if (definition.condition === "unusual") {
		readings = await readUnusual(source, definition, run);
	} else {
		const compiled = compileQuery(source, alertSpec(source, definition));
		const rows = await run(compiled.sql, compiled.params);
		readings = readingsFrom(definition, rows);
	}
	const { firings } = evaluate(definition, readings, {});
	const format = wordingFor(definition).format;
	return {
		readings: readings.slice(0, 20),
		firings,
		formatted: readings.slice(0, 20).map((r) => format(r.value)),
		usual: readings
			.slice(0, 20)
			.map((r) =>
				r.low === undefined || r.low === null
					? null
					: `${format(r.low)} to ${format(r.high ?? null)}`,
			),
	};
}
