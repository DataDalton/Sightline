import type { Identity } from "../auth/identity";
import { sql } from "../data/lakebase";
import type { QueryParams, Row } from "../data/types";
import { compileDistinctValues, type RowRestriction } from "../query/builder";
import { filterDiscoveryComplete } from "../semantic/filterDiscovery";
import { getSource } from "../semantic/registry";
import { maxAccessTuples, toAccessValue, type AccessValue } from "./access";

// Recording what somebody can see of a row-filtered dataset, and using the
// recording to check their alerts while they are away. The reasoning is in
// lib/alerts/access.

type RunQuery = (statement: string, params: QueryParams) => Promise<Row[]>;

// How long a recording stands in for the person. The same ceiling the app puts
// on a stored answer to what somebody can read.
export const recordingWindow = "24 hours";

// How often a recording is taken again while the person is here. Each is a
// warehouse query, and access changes far less often than this.
const refreshAfter = "1 hour";

let mapped: { at: number; fields: Map<string, string[]> } | null = null;
const mappedTtlMs = 60 * 1000;

// Row-filtered datasets whose filters the walk mapped onto fields, with those
// fields. A dataset is left out while the walk is incomplete, when a column of
// it is masked, or when its filters could not be mapped.
export async function restrictableSources(): Promise<Map<string, string[]>> {
	if (!filterDiscoveryComplete()) return new Map();
	if (mapped && Date.now() - mapped.at < mappedTtlMs) return mapped.fields;

	const rows = await sql<{ source_key: string; access_fields: string[] }>(
		`SELECT source_key, access_fields FROM data_sources
		 WHERE is_active AND has_row_filter
		   AND access_fields IS NOT NULL AND NOT has_column_mask`,
	);
	const fields = new Map<string, string[]>();
	for (const row of rows) {
		const source = getSource(row.source_key);
		if (!source?.hasRowFilter) continue;
		if (Array.isArray(row.access_fields) && row.access_fields.length > 0) {
			fields.set(row.source_key, row.access_fields);
		}
	}
	mapped = { at: Date.now(), fields };
	return fields;
}

// Takes a recording for each dataset the owner has an alert, a scheduled page
// or a followed page alert on that needs one, under their own token. Called while they are using
// the app.
export async function recordAccess(
	identity: Identity,
	run: RunQuery,
	readable: string[] | null,
): Promise<void> {
	const email = identity.email.toLowerCase();
	const restrictable = await restrictableSources();
	if (restrictable.size === 0) return;

	const due = await sql<{ source_key: string }>(
		`SELECT DISTINCT w.source_key FROM (
		   SELECT owner_email, source_key FROM alert_rules WHERE enabled
		   UNION
		   SELECT owner_email, source_key FROM deliveries
		   WHERE enabled AND source_key IS NOT NULL
		   UNION
		   SELECT s.email AS owner_email, a.source_key
		   FROM page_alert_subscriptions s
		   JOIN page_alerts a ON a.alert_id = s.alert_id AND a.is_active
		 ) w
		 WHERE w.owner_email = $1
		   AND w.source_key = ANY($2::text[])
		   AND ($3::text[] IS NULL OR w.source_key = ANY($3::text[]))
		   AND NOT EXISTS (
		     SELECT 1 FROM alert_access a
		     WHERE a.owner_email = w.owner_email AND a.source_key = w.source_key
		       AND a.captured_on > now() - interval '${refreshAfter}'
		   )`,
		[email, [...restrictable.keys()], readable],
	);

	for (const { source_key } of due) {
		const source = getSource(source_key);
		const fields = restrictable.get(source_key);
		if (!source || !fields) continue;
		try {
			// One more than the ceiling, to tell a full list from one that
			// happens to be exactly the ceiling.
			const compiled = compileDistinctValues(
				source,
				fields,
				maxAccessTuples + 1,
			);
			const rows = await run(compiled.sql, compiled.params);
			const tooMany = rows.length > maxAccessTuples;
			const tuples: AccessValue[][] = tooMany
				? []
				: rows.map((row) =>
						compiled.columns.map((c) => toAccessValue(row[c])),
					);
			await sql(
				`INSERT INTO alert_access
				   (owner_email, source_key, fields, tuples, too_many, captured_on)
				 VALUES ($1, $2, $3, $4, $5, now())
				 ON CONFLICT (owner_email, source_key) DO UPDATE SET
				   fields = EXCLUDED.fields,
				   tuples = EXCLUDED.tuples,
				   too_many = EXCLUDED.too_many,
				   captured_on = now()`,
				[
					email,
					source_key,
					JSON.stringify(fields),
					JSON.stringify(tuples),
					tooMany,
				],
			);
		} catch (error) {
			// Without a fresh recording the alert keeps to signed-in checks,
			// which is the safe way to fail.
			console.warn(
				`Access for ${email} on ${source_key} could not be recorded:`,
				error,
			);
		}
	}
}

// The restriction a check for this owner runs under, or null when there is
// no usable recording: none yet, too old, too long, or taken against fields
// the dataset's filters no longer map to.
export async function restrictionFor(
	ownerEmail: string,
	sourceKey: string,
): Promise<RowRestriction | null> {
	const fields = (await restrictableSources()).get(sourceKey);
	if (!fields) return null;
	const rows = await sql<{
		fields: string[];
		tuples: AccessValue[][];
		too_many: boolean;
	}>(
		`SELECT fields, tuples, too_many FROM alert_access
		 WHERE owner_email = $1 AND source_key = $2
		   AND captured_on > now() - interval '${recordingWindow}'`,
		[ownerEmail.toLowerCase(), sourceKey],
	);
	const row = rows[0];
	if (!row || row.too_many) return null;
	if (JSON.stringify(row.fields) !== JSON.stringify(fields)) return null;
	return { fields, tuples: row.tuples };
}

// The restriction for each of several people on one dataset, in one read, for
// the subscribers of a page alert. Held to the same rules as restrictionFor,
// and anybody without a usable recording is left out of the map.
export async function restrictionsFor(
	emails: string[],
	sourceKey: string,
): Promise<Map<string, RowRestriction>> {
	const out = new Map<string, RowRestriction>();
	const fields = (await restrictableSources()).get(sourceKey);
	if (!fields || emails.length === 0) return out;
	const rows = await sql<{
		owner_email: string;
		fields: string[];
		tuples: AccessValue[][];
	}>(
		`SELECT owner_email, fields, tuples FROM alert_access
		 WHERE source_key = $1 AND owner_email = ANY($2::text[])
		   AND NOT too_many
		   AND captured_on > now() - interval '${recordingWindow}'`,
		[sourceKey, emails.map((e) => e.toLowerCase())],
	);
	for (const row of rows) {
		if (JSON.stringify(row.fields) !== JSON.stringify(fields)) continue;
		out.set(row.owner_email.toLowerCase(), {
			fields,
			tuples: row.tuples,
		});
	}
	return out;
}

// Which of an owner's datasets currently have a usable recording, for the
// alert list.
export async function recordedSources(
	ownerEmail: string,
): Promise<Set<string>> {
	const rows = await sql<{ source_key: string }>(
		`SELECT source_key FROM alert_access
		 WHERE owner_email = $1 AND NOT too_many
		   AND captured_on > now() - interval '${recordingWindow}'`,
		[ownerEmail.toLowerCase()],
	);
	return new Set(rows.map((r) => r.source_key));
}
