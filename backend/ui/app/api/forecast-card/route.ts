import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/data/lakebase";
import {
	cachedDefinition,
	invalidateDefinitions,
	peekDefinition,
} from "@/lib/platform/definitionCache";
import {
	readerReport,
	reportsOfVisuals,
	updateReaderReport,
} from "@/lib/platform/readerReport";
import {
	withForecastChanges,
	type ForecastRecordRow,
} from "@/lib/platform/readerRows";
import { caller, privateJson, readJson } from "../notifications/guard";

// What a forecast said when it was made, and what then happened, so people can see how far
// to trust the ones in front of them. Each person's own, since row filters can make one
// chart show different figures to different people.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const params = request.nextUrl.searchParams;
	try {
		const [answer] = await recordsFor(identity.email, [
			{
				visualId: params.get("visualId"),
				measure: params.get("measure"),
			},
		]);
		return privateJson(answer);
	} catch (error) {
		console.error("Could not read a forecast record:", error);
		return privateJson({ error: "Could not load this" }, 500);
	}
}

type Kept = Omit<ForecastRecordRow, "visual_id" | "measure">;

// One person's records for one visual not on a report, such as a chart on a board. Held
// until that person's card saves something new. A visual on a report is read with the
// rest of what the person has on that report. See lib/platform/readerReport.
const recordsKey = (email: string, visualId: string) =>
	`forecast-records:${email.toLowerCase()}|${visualId}`;

function keptFor(
	rows: ForecastRecordRow[],
	visualId: string,
	measure: string,
): Kept[] {
	return rows
		.filter((row) => row.visual_id === visualId && row.measure === measure)
		.map(({ period, predicted, low, high, actual }) => ({
			period,
			predicted,
			low,
			high,
			actual,
		}));
}

// The records of every forecast card on a page, answered in the order asked. Cards on a
// report read the person's held rows for that report. Any others not held yet are read
// together in one statement, and each visual is then held under its own key.
async function recordsFor(
	email: string,
	cards: { visualId?: unknown; measure?: unknown }[],
): Promise<{ records: Kept[] }[]> {
	const asked = cards.map((card) => ({
		visualId: String(card.visualId ?? ""),
		measure: String(card.measure ?? ""),
	}));
	const unheld = asked
		.map((card) => card.visualId)
		.filter(
			(visualId) =>
				peekDefinition(recordsKey(email, visualId)) === undefined,
		);
	const reports = await reportsOfVisuals(unheld);
	const elsewhere = [
		...new Set(unheld.filter((visualId) => !reports.has(visualId))),
	];
	let together: Promise<ForecastRecordRow[]> | null = null;
	const readElsewhere = () =>
		(together ??= sql<ForecastRecordRow>(
			`SELECT r.visual_id, r.measure, r.period, r.predicted,
			        r.low_value AS low, r.high_value AS high, r.actual
			 FROM forecast_records r
			 WHERE r.user_email = lower($1) AND r.visual_id = ANY($2::text[])
			 ORDER BY r.period`,
			[email, elsewhere],
		));
	return Promise.all(
		asked.map(async ({ visualId, measure }) => {
			const reportId = reports.get(visualId);
			const rows = reportId
				? (await readerReport(email, reportId)).forecasts
				: await cachedDefinition(
						recordsKey(email, visualId),
						async () =>
							(await readElsewhere()).filter(
								(row) => row.visual_id === visualId,
							),
					);
			return { records: keptFor(rows, visualId, measure) };
		}),
	);
}

// { visualId, sourceKey, measure, forecasts: [...], actuals: [...] } saves what is new.
// { action: "lookupMany", cards: [{ visualId, measure }] } reads every card on a page at
// once, answered as { results: [{ records }] } in the same order.
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const raw = ((await readJson(request)) ?? {}) as Record<string, unknown>;
	if (raw.action === "lookupMany") {
		try {
			const cards = Array.isArray(raw.cards)
				? (raw.cards as { visualId?: unknown; measure?: unknown }[])
				: [];
			return privateJson({
				results: await recordsFor(identity.email, cards),
			});
		} catch (error) {
			console.error("Could not read forecast records:", error);
			return privateJson({ error: "Could not load this" }, 500);
		}
	}
	const body = raw as {
		visualId?: unknown;
		sourceKey?: unknown;
		measure?: unknown;
		forecasts?: {
			period: string;
			predicted: number;
			low: number;
			high: number;
		}[];
		actuals?: { period: string; value: number }[];
	};
	const visualId = String(body.visualId ?? "");
	const measure = String(body.measure ?? "");
	if (!visualId || !measure) {
		return privateJson({ error: "Which forecast?" }, 400);
	}
	try {
		// The first forecast for a period stands. Scoring a later guess, made with more
		// of the answer in hand, would flatter it.
		const forecasts = body.forecasts ?? [];
		const added =
			forecasts.length > 0
				? await sql<ForecastRecordRow>(
						`INSERT INTO forecast_records
						   (user_email, visual_id, source_key, measure, period, predicted,
						    low_value, high_value)
						 SELECT lower($1), $2, $3, $4, f.period, f.predicted, f.low, f.high
						 FROM jsonb_to_recordset($5::jsonb)
						   AS f(period text, predicted double precision, low double precision,
						        high double precision)
						 ON CONFLICT (user_email, visual_id, measure, period) DO NOTHING
						 RETURNING visual_id, measure, period, predicted,
						           low_value AS low, high_value AS high, actual`,
						[
							identity.email,
							visualId,
							String(body.sourceKey ?? ""),
							measure,
							JSON.stringify(forecasts),
						],
					)
				: [];
		const actuals = body.actuals ?? [];
		const filled =
			actuals.length > 0
				? await sql<{ period: string; actual: number }>(
						`UPDATE forecast_records r SET actual = a.value
						 FROM jsonb_to_recordset($4::jsonb)
						   AS a(period text, value double precision)
						 WHERE r.user_email = lower($1) AND r.visual_id = $2
						   AND r.measure = $3 AND r.period = a.period
						   AND r.actual IS DISTINCT FROM a.value
						 RETURNING r.period, r.actual`,
						[
							identity.email,
							visualId,
							measure,
							JSON.stringify(actuals),
						],
					)
				: [];
		if (added.length > 0 || filled.length > 0) {
			invalidateDefinitions(recordsKey(identity.email, visualId));
			// The rows written are known, so the person's held report takes them in
			// rather than being read again.
			const reportId = (await reportsOfVisuals([visualId])).get(visualId);
			if (reportId) {
				await updateReaderReport(identity.email, reportId, (held) =>
					withForecastChanges(held, visualId, measure, added, filled),
				);
			}
		}
		return privateJson({ ok: true });
	} catch (error) {
		console.error("Could not save a forecast record:", error);
		return privateJson({ error: "Could not save this" }, 500);
	}
}
