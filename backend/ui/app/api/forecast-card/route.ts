import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/data/lakebase";
import { caller, privateJson, readJson } from "../notifications/guard";

// What a forecast said when it was made, and what then happened, so people can see how far
// to trust the ones in front of them. Each person's own, since row filters can make one
// chart show different figures to different people.

export async function GET(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const params = request.nextUrl.searchParams;
	try {
		const rows = await sql<{
			period: string;
			predicted: number;
			low: number;
			high: number;
			actual: number | null;
		}>(
			`SELECT period, predicted, low_value AS low, high_value AS high, actual
			 FROM forecast_records
			 WHERE user_email = lower($1) AND visual_id = $2 AND measure = $3
			 ORDER BY period`,
			[identity.email, params.get("visualId"), params.get("measure")],
		);
		return privateJson({ records: rows });
	} catch (error) {
		console.error("Could not read a forecast record:", error);
		return privateJson({ error: "Could not load this" }, 500);
	}
}

// { visualId, sourceKey, measure, forecasts: [...], actuals: [...] }
export async function POST(request: NextRequest) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const body = ((await readJson(request)) ?? {}) as {
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
		if (forecasts.length > 0) {
			await sql(
				`INSERT INTO forecast_records
				   (user_email, visual_id, source_key, measure, period, predicted,
				    low_value, high_value)
				 SELECT lower($1), $2, $3, $4, f.period, f.predicted, f.low, f.high
				 FROM jsonb_to_recordset($5::jsonb)
				   AS f(period text, predicted double precision, low double precision,
				        high double precision)
				 ON CONFLICT (user_email, visual_id, measure, period) DO NOTHING`,
				[
					identity.email,
					visualId,
					String(body.sourceKey ?? ""),
					measure,
					JSON.stringify(forecasts),
				],
			);
		}
		const actuals = body.actuals ?? [];
		if (actuals.length > 0) {
			await sql(
				`UPDATE forecast_records r SET actual = a.value
				 FROM jsonb_to_recordset($4::jsonb)
				   AS a(period text, value double precision)
				 WHERE r.user_email = lower($1) AND r.visual_id = $2 AND r.measure = $3
				   AND r.period = a.period AND r.actual IS DISTINCT FROM a.value`,
				[identity.email, visualId, measure, JSON.stringify(actuals)],
			);
		}
		return privateJson({ ok: true });
	} catch (error) {
		console.error("Could not save a forecast record:", error);
		return privateJson({ error: "Could not save this" }, 500);
	}
}
