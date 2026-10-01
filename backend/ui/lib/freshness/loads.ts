import type { LoadEvidence, TableLoad } from "../alerts/completeness";
import { sql } from "../data/lakebase";
import {
	customPattern,
	readLatenessSetting,
	type ArrivalPattern,
} from "./arrivals";

// When each dataset's tables last loaded, with what their load history says
// about when they load, for telling a period whose load has not landed from
// one that has. See lib/alerts/completeness.
//
// Read from the platform store alone, in one statement for any number of
// datasets, so it never asks the warehouse anything. Held briefly on this
// replica, so a briefing and the alerts of the same minute share a read.

const heldMs = 60_000;
const held = new Map<string, { at: number; evidence: LoadEvidence | null }>();

interface Row {
	source_key: string;
	freshness_mode: string;
	lateness: unknown;
	table_name: string | null;
	newest: string | null;
	pattern: ArrivalPattern | null;
}

export async function loadEvidence(
	sourceKeys: string[],
): Promise<Map<string, LoadEvidence>> {
	const now = Date.now();
	const out = new Map<string, LoadEvidence>();
	const missing: string[] = [];
	for (const key of new Set(sourceKeys)) {
		const kept = held.get(key);
		if (kept && now - kept.at < heldMs) {
			if (kept.evidence) out.set(key, kept.evidence);
		} else missing.push(key);
	}
	if (missing.length === 0) return out;

	try {
		// A metric view reads the tables it was found to be built on, and a
		// table reads itself, as the lateness checks judge them.
		const rows = await sql<Row>(
			`SELECT d.source_key, d.freshness_mode, d.lateness, t.table_name,
			        (SELECT max(a.arrived_on) FROM table_arrivals a
			         WHERE a.table_name = t.table_name)::text AS newest,
			        p.pattern
			 FROM data_sources d
			 LEFT JOIN LATERAL (
			   SELECT jsonb_array_elements_text(
			            CASE WHEN jsonb_typeof(d.base_tables) = 'array'
			                 THEN d.base_tables ELSE '[]'::jsonb END)
			            AS table_name
			   WHERE d.kind = 'metric_view'
			   UNION ALL
			   SELECT d.catalog_name || '.' || d.schema_name || '.' || d.object_name
			   WHERE d.kind <> 'metric_view'
			 ) t ON TRUE
			 LEFT JOIN table_patterns p ON p.table_name = t.table_name
			 WHERE d.is_active AND d.source_key = ANY($1::text[])`,
			[missing],
		);
		const found = new Map<string, LoadEvidence>();
		for (const row of rows) {
			const setting = readLatenessSetting(row.lateness);
			const evidence = found.get(row.source_key) ?? {
				// A source whose lateness is switched off is taken to load
				// at no particular time.
				checked:
					row.freshness_mode === "checked" && setting.mode !== "off",
				tables: [] as TableLoad[],
			};
			if (row.table_name) {
				evidence.tables.push({
					table: row.table_name,
					newest: row.newest ? Date.parse(row.newest) : null,
					pattern:
						setting.mode === "custom"
							? customPattern(setting, 0)
							: row.pattern,
				});
			}
			found.set(row.source_key, evidence);
		}
		if (held.size > 5000) held.clear();
		for (const key of missing) {
			const evidence = found.get(key) ?? null;
			held.set(key, { at: now, evidence });
			if (evidence) out.set(key, evidence);
		}
	} catch (error) {
		// Without load history every period is judged by the settling rules
		// alone, never left unjudged.
		console.warn("Load history could not be read:", error);
	}
	return out;
}
