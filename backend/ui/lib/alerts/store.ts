import type { Identity } from "../auth/identity";
import { sql } from "../data/lakebase";
import { toFilterLogic } from "../explore/conditions";
import { formatCompact, type FormatHint } from "../format";
import { confirmableSources, reachableSet } from "../platform/sources";
import { compileQuery } from "../query/builder";
import { parseQuerySpec, QuerySpecError, type QuerySpec } from "../query/spec";
import { filterDiscoveryComplete } from "../semantic/filterDiscovery";
import { getSource } from "../semantic/registry";
import type { SemanticSource } from "../semantic/types";
import { settings } from "../settings";
import {
	AlertDefinitionError,
	cleanDefinition,
	describeRule,
	maxGroups,
	type AlertDefinition,
	type AlertState,
	type Wording,
} from "./rule";
import { ownersChanged } from "./owners";
import { describeSchedule, nextRun } from "./schedule";
import { recordedSources, restrictableSources } from "./recorded";

// Alerts as stored, and the checks that decide whether one may be saved.

export interface AlertRecord {
	id: string;
	name: string;
	definition: AlertDefinition;
	enabled: boolean;
	state: AlertState;
	lastCheckedOn: string | null;
	lastStatus: "ok" | "error" | "waiting";
	lastError: string | null;
	nextCheckOn: string;
	createdOn: string;
	// Read aloud, for the list.
	summary: string;
	scheduleText: string;
	// Whether checks run on the schedule while the owner is away, or only
	// while they are using the app. See runsUnattended and lib/alerts/access.
	unattended: boolean;
	sourceTitle: string | null;
}

export interface AlertRow {
	rule_id: string;
	owner_email: string;
	name: string;
	source_key: string;
	definition: AlertDefinition;
	enabled: boolean;
	state: AlertState;
	last_checked_on: string | null;
	last_status: "ok" | "error" | "waiting";
	last_error: string | null;
	next_check_on: string;
	created_on: string;
}

export const alertColumns = `rule_id::text, owner_email, name, source_key,
	definition, enabled, state, last_checked_on::text, last_status, last_error,
	next_check_on::text, created_on::text`;

// Whether a dataset's alerts can be checked while their owner is away.
//
// A check needs somebody's authority to query. The owner's own token only
// exists while they are using the app, so a check at 8 in the morning has to
// run as the application instead. That is only the same answer the owner
// would get when the dataset shows everybody the same rows: no row filter
// and no column mask, and the filter walk finished so that "no filter" is
// known rather than assumed. It is the same test that lets the result cache
// share one answer between every reader of a dataset, and for the same
// reason.
//
// A row-filtered dataset can also be checked while the owner is away, narrowed
// to what they were recorded seeing. See lib/alerts/access. Anything else is
// checked only while the owner is signed in, under their own token, which is
// always their own rows.
export function runsUnattended(source: SemanticSource | null): boolean {
	return Boolean(source && !source.hasRowFilter && filterDiscoveryComplete());
}

export function measureFormat(
	source: SemanticSource | null,
	measure: string,
): (value: number | null) => string {
	const hint = (source?.measures.find((m) => m.name === measure)
		?.formatHint ?? "decimal") as FormatHint;
	return (value) => formatCompact(value, hint);
}

export function wordingFor(definition: AlertDefinition): Wording {
	const source = getSource(definition.sourceKey);
	return {
		measure: definition.measure,
		groupBy: definition.groupBy,
		condition: definition.condition,
		threshold: definition.threshold,
		format: measureFormat(source, definition.measure),
		anomaly: definition.anomaly,
	};
}

// recorded: whether the owner has a current recording of what they can see
// of this alert's dataset, which lets a row-filtered one run on the timer.
export function toRecord(row: AlertRow, recorded = false): AlertRecord {
	const source = getSource(row.source_key);
	return {
		id: row.rule_id,
		name: row.name,
		definition: row.definition,
		enabled: row.enabled,
		state: row.state ?? {},
		lastCheckedOn: row.last_checked_on,
		lastStatus: row.last_status,
		lastError: row.last_error,
		nextCheckOn: row.next_check_on,
		createdOn: row.created_on,
		summary: describeRule(wordingFor(row.definition)),
		scheduleText: describeSchedule(row.definition.schedule),
		unattended: runsUnattended(source) || recorded,
		sourceTitle: source?.title ?? null,
	};
}

// The query an alert runs: the measure, split by the chosen dimension, under
// the conditions, bounded. Largest first, except for an alert on falling
// below a line, which reads smallest first, since past the bound the groups
// left out would be exactly the ones it is watching for.
export function alertSpec(
	source: SemanticSource,
	definition: AlertDefinition,
): QuerySpec {
	const kinds = new Map<string, "dimension" | "measure">([
		...source.dimensions.map((f) => [f.name, "dimension"] as const),
		...source.measures.map((f) => [f.name, "measure"] as const),
	]);
	const logic = toFilterLogic(definition.conditions, kinds);
	if (logic.problem) throw new AlertDefinitionError(logic.problem);

	return parseQuerySpec({
		sourceKey: source.sourceKey,
		dimensions: definition.groupBy ? [definition.groupBy] : [],
		measures: [definition.measure],
		filters: logic.filters,
		...(logic.anyOf ? { anyOf: logic.anyOf } : {}),
		...(logic.where ? { where: logic.where } : {}),
		sort: [
			{
				field: definition.measure,
				direction: definition.condition === "below" ? "asc" : "desc",
			},
		],
		limit: definition.groupBy ? maxGroups : 1,
		offset: 0,
	});
}

// Everything an alert names has to exist and be readable by its owner.
export async function checkDefinition(
	identity: Identity,
	raw: unknown,
): Promise<{ definition: AlertDefinition; source: SemanticSource }> {
	const definition = cleanDefinition(raw);
	const source = getSource(definition.sourceKey);
	const reachable = await reachableSet(identity);
	if (!source || (reachable && !reachable.has(source.sourceKey))) {
		throw new AlertDefinitionError("That dataset is not one you can read.");
	}
	if (!source.measures.some((m) => m.name === definition.measure)) {
		throw new AlertDefinitionError(
			`${definition.measure} is not a measure on ${source.title}.`,
		);
	}
	if (
		definition.groupBy &&
		!source.dimensions.some((d) => d.name === definition.groupBy)
	) {
		throw new AlertDefinitionError(
			`${definition.groupBy} is not a field on ${source.title}.`,
		);
	}
	if (
		definition.anomaly &&
		!source.dimensions.some((d) => d.name === definition.anomaly?.timeField)
	) {
		throw new AlertDefinitionError(
			`${definition.anomaly.timeField} is not a date field on ${source.title}.`,
		);
	}
	try {
		compileQuery(source, alertSpec(source, definition));
	} catch (error) {
		if (error instanceof QuerySpecError) {
			throw new AlertDefinitionError(error.message);
		}
		throw error;
	}
	return { definition, source };
}

export async function listAlerts(ownerEmail: string): Promise<AlertRecord[]> {
	const rows = await sql<AlertRow>(
		`SELECT ${alertColumns} FROM alert_rules
		 WHERE owner_email = $1 ORDER BY created_on DESC`,
		[ownerEmail.toLowerCase()],
	);
	const [restrictable, recorded] = await Promise.all([
		restrictableSources(),
		recordedSources(ownerEmail),
	]);
	return rows.map((row) =>
		toRecord(
			row,
			restrictable.has(row.source_key) && recorded.has(row.source_key),
		),
	);
}

export async function getAlert(
	ownerEmail: string,
	id: string,
): Promise<AlertRecord | null> {
	const rows = await sql<AlertRow>(
		`SELECT ${alertColumns} FROM alert_rules
		 WHERE owner_email = $1 AND rule_id = $2`,
		[ownerEmail.toLowerCase(), id],
	);
	return rows[0] ? toRecord(rows[0]) : null;
}

export async function createAlert(
	identity: Identity,
	raw: unknown,
): Promise<AlertRecord> {
	const { definition } = await checkDefinition(identity, raw);

	// Checked straight away rather than at the next scheduled hour, so the
	// owner sees at once whether it works and what the value is now.
	const rows = await sql<AlertRow>(
		`INSERT INTO alert_rules
		   (owner_email, name, source_key, definition, next_check_on,
		    access_confirmed_on)
		 VALUES ($1, $2, $3, $4, now(), CASE WHEN $5 THEN now() END)
		 RETURNING ${alertColumns}`,
		[
			identity.email.toLowerCase(),
			definition.name,
			definition.sourceKey,
			JSON.stringify(definition),
			await accessConfirmed(identity, definition.sourceKey),
		],
	);
	ownersChanged();
	return toRecord(rows[0]);
}

// Whether saving confirms the owner can read the alert's source, which is
// what lets its checks run later while they are away.
async function accessConfirmed(
	identity: Identity,
	sourceKey: string,
): Promise<boolean> {
	const confirmable = await confirmableSources(identity);
	return !confirmable || confirmable.has(sourceKey);
}

export async function updateAlert(
	identity: Identity,
	id: string,
	raw: unknown,
): Promise<AlertRecord | null> {
	const { definition } = await checkDefinition(identity, raw);
	const existing = await getAlert(identity.email, id);
	if (!existing) return null;

	// What the alert watches changed, so what the last check saw no longer
	// says anything about it. The condition counts too, since whether the
	// last check met one condition says nothing about another, and a switch
	// from above to below would otherwise stay silent while the new one
	// already holds.
	const watched = (d: AlertDefinition) =>
		JSON.stringify([
			d.sourceKey,
			d.measure,
			d.groupBy,
			d.conditions,
			d.condition,
			d.anomaly,
		]);
	const reset = watched(existing.definition) !== watched(definition);
	const rescheduled =
		JSON.stringify(existing.definition.schedule) !==
		JSON.stringify(definition.schedule);

	const rows = await sql<AlertRow>(
		`UPDATE alert_rules SET
		   name = $3, source_key = $4, definition = $5,
		   state = CASE WHEN $6 THEN '{}'::jsonb ELSE state END,
		   next_check_on = CASE WHEN $6 OR $7 THEN now() ELSE next_check_on END,
		   access_confirmed_on = CASE WHEN $8 THEN now() END,
		   modified_on = now()
		 WHERE owner_email = $1 AND rule_id = $2
		 RETURNING ${alertColumns}`,
		[
			identity.email.toLowerCase(),
			id,
			definition.name,
			definition.sourceKey,
			JSON.stringify(definition),
			reset,
			rescheduled,
			await accessConfirmed(identity, definition.sourceKey),
		],
	);
	return rows[0] ? toRecord(rows[0]) : null;
}

export async function setAlertEnabled(
	ownerEmail: string,
	id: string,
	enabled: boolean,
): Promise<AlertRecord | null> {
	const rows = await sql<AlertRow>(
		`UPDATE alert_rules SET enabled = $3, modified_on = now(),
		   next_check_on = CASE WHEN $3 THEN now() ELSE next_check_on END
		 WHERE owner_email = $1 AND rule_id = $2
		 RETURNING ${alertColumns}`,
		[ownerEmail.toLowerCase(), id, enabled],
	);
	return rows[0] ? toRecord(rows[0]) : null;
}

export async function deleteAlert(
	ownerEmail: string,
	id: string,
): Promise<boolean> {
	const rows = await sql(
		`DELETE FROM alert_rules WHERE owner_email = $1 AND rule_id = $2
		 RETURNING rule_id`,
		[ownerEmail.toLowerCase(), id],
	);
	return rows.length > 0;
}

export interface AlertEvent {
	id: string;
	firedOn: string;
	title: string;
	body: string;
	firings: number;
}

export async function alertEvents(
	ownerEmail: string,
	id: string,
	limit = 20,
): Promise<AlertEvent[]> {
	const rows = await sql<{
		event_id: string;
		fired_on: string;
		title: string;
		body: string;
		firings: number;
	}>(
		`SELECT e.event_id::text, e.fired_on::text, e.title, e.body, e.firings
		 FROM alert_events e
		 JOIN alert_rules r ON r.rule_id = e.rule_id
		 WHERE r.owner_email = $1 AND e.rule_id = $2
		 ORDER BY e.fired_on DESC LIMIT $3`,
		[ownerEmail.toLowerCase(), id, limit],
	);
	return rows.map((r) => ({
		id: r.event_id,
		firedOn: r.fired_on,
		title: r.title,
		body: r.body,
		firings: r.firings,
	}));
}

// The next hour an alert is due after now.
export function nextCheck(definition: AlertDefinition, from = new Date()) {
	return nextRun(definition.schedule, from);
}

export function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}
