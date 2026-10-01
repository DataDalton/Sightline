import type { Observation } from "../alerts/completeness";
import { sql } from "../data/lakebase";

// What each figure read as for each recent period, every time its card was
// worked out, so how complete a young period usually is can be learned. See
// lib/alerts/completeness.
//
// Kept under the same scope as the card, so the readings of one policy class
// are only ever learned from by that class. A reading held for everyone is
// stored, and read, only while its dataset is still recorded as carrying no
// catalogue filter or mask, asked in the same statement, as the stored cards
// ask it.

// Periods learned from. A few weeks shows how a period fills in, and a
// schedule that changed is learned again soon after.
const learnDays = 35;

export interface ObservedFigure {
	scope: string;
	digest: string;
}

function keyOf(scope: string, digest: string): string {
	return `${scope}:${digest}`;
}

// Every reading for the figures given, in one statement. Answers them by
// scope and digest, as figureKey names them.
export async function readObservations(
	figures: ObservedFigure[],
): Promise<Map<string, Observation[]>> {
	const found = new Map<string, Observation[]>();
	if (figures.length === 0) return found;
	try {
		const rows = await sql<{
			scope: string;
			card_digest: string;
			period: string;
			age_hours: number;
			value: number;
		}>(
			`SELECT o.scope, o.card_digest, o.period::text AS period,
			        o.age_hours, o.value
			 FROM figure_observations o
			 JOIN unnest($1::text[], $2::text[]) AS w(scope, digest)
			   ON o.scope = w.scope AND o.card_digest = w.digest
			 LEFT JOIN data_sources d ON d.source_key = o.source_key
			 WHERE o.period > current_date - $3::int
			   AND (o.scope <> 'unfiltered' OR NOT coalesce(d.has_row_filter, FALSE))`,
			[
				figures.map((f) => f.scope),
				figures.map((f) => f.digest),
				learnDays,
			],
		);
		for (const row of rows) {
			const key = keyOf(row.scope, row.card_digest);
			const list = found.get(key) ?? [];
			list.push({
				period: row.period,
				ageHours: Number(row.age_hours),
				value: Number(row.value),
			});
			found.set(key, list);
		}
	} catch (error) {
		// Nothing learned means the other signals decide.
		console.warn("Figure readings could not be read:", error);
	}
	return found;
}

export function figureKey(figure: ObservedFigure): string {
	return keyOf(figure.scope, figure.digest);
}

// The readings of one figure across every card that shows it, for an unusual
// alert on the same figure in the same scope.
export async function readFigureObservations(
	scope: string,
	figure: string,
	sourceKey: string,
): Promise<Observation[]> {
	try {
		const rows = await sql<{
			period: string;
			age_hours: number;
			value: number;
		}>(
			`SELECT DISTINCT ON (o.period, o.observed_on)
			        o.period::text AS period, o.age_hours, o.value
			 FROM figure_observations o
			 LEFT JOIN data_sources d ON d.source_key = o.source_key
			 WHERE o.scope = $1 AND o.figure = $2 AND o.source_key = $3
			   AND o.period > current_date - $4::int
			   AND (o.scope <> 'unfiltered' OR NOT coalesce(d.has_row_filter, FALSE))
			 ORDER BY o.period, o.observed_on`,
			[scope, figure, sourceKey, learnDays],
		);
		return rows.map((row) => ({
			period: row.period,
			ageHours: Number(row.age_hours),
			value: Number(row.value),
		}));
	} catch (error) {
		console.warn("Figure readings could not be read:", error);
		return [];
	}
}

// Stores one card's readings. A reading already kept for the same hour, or
// the same day once a period is two days old, is replaced only by one read
// later.
export async function writeObservations(entry: {
	scope: string;
	digest: string;
	figure: string;
	sourceKey: string;
	observations: {
		period: string;
		observedAt: number;
		ageHours: number;
		value: number;
	}[];
}): Promise<void> {
	if (entry.observations.length === 0) return;
	try {
		await sql(
			`INSERT INTO figure_observations
			   (scope, card_digest, figure, source_key, period, observed_on,
			    value, age_hours)
			 SELECT $1::text, $2::text, $3::text, $4::text, u.period::date,
			        to_timestamp(u.observed), u.value, u.age
			 FROM unnest($5::text[], $6::float8[], $7::float8[], $8::float8[])
			      AS u(period, observed, value, age)
			 WHERE $1::text <> 'unfiltered' OR NOT EXISTS (
			   SELECT 1 FROM data_sources d
			   WHERE d.source_key = $4::text AND d.has_row_filter)
			 ON CONFLICT (scope, card_digest, period, observed_on) DO UPDATE SET
			   value = EXCLUDED.value,
			   age_hours = EXCLUDED.age_hours
			 WHERE figure_observations.age_hours <= EXCLUDED.age_hours`,
			[
				entry.scope,
				entry.digest,
				entry.figure,
				entry.sourceKey,
				entry.observations.map((o) => o.period),
				entry.observations.map((o) => o.observedAt / 1000),
				entry.observations.map((o) => o.value),
				entry.observations.map((o) => o.ageHours),
			],
		);
	} catch (error) {
		// A reading that could not be kept is taken again on the next visit.
		console.warn("Figure readings could not be stored:", error);
	}
}
