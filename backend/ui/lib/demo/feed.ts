import { sql } from "../data/lakebase";
import { landTodaysLoads } from "./arrivals";

// New visits to the online store while the demonstration runs, so a page on
// the live web source can be watched updating. A few rows for today land every
// so often. The checker notices the table changed, the source's answers are
// cleared, and open pages show the new totals on their next look. See
// lib/freshness.

const everyMs = 20_000;
let timer: ReturnType<typeof setInterval> | null = null;

async function arrive(): Promise<void> {
	await sql(
		`INSERT INTO web.sessions_daily
		 SELECT current_date,
		        (ARRAY['Organic Search','Paid Search','Email','Social','Direct',
		               'Referral'])[1 + floor(random() * 6)::int],
		        (ARRAY['Desktop','Mobile','Tablet'])[1 + floor(random() * 3)::int],
		        (ARRAY['Home','Tents','Backpacks','Footwear','Apparel','Sale'])
		          [1 + floor(random() * 6)::int],
		        (ARRAY['United States','Canada','Germany','United Kingdom'])
		          [1 + floor(random() * 4)::int],
		        s, round(s * 0.45)::int, round(s * 0.07)::int,
		        round(s * 0.02)::int, round(s * 0.02 * 130, 2)
		 FROM (SELECT (20 + floor(random() * 60))::int AS s
		       FROM generate_series(1, 3)) AS visits`,
	);
}

// The other tables' morning loads, looked for every few minutes rather than
// on every visit, since they land once a day.
const loadsEveryMs = 5 * 60_000;
let loadsAt = 0;

export function startDemoFeed(): void {
	if (timer) return;
	timer = setInterval(() => {
		void arrive().catch(() => {});
		if (Date.now() - loadsAt >= loadsEveryMs) {
			loadsAt = Date.now();
			void landTodaysLoads().catch(() => {});
		}
	}, everyMs);
	timer.unref?.();
}

export function stopDemoFeed(): void {
	if (timer) clearInterval(timer);
	timer = null;
}
