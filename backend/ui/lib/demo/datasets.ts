// The sample data the demonstration's warehouse holds, and the sources and
// fields that describe it to the platform.
//
// Each table is generated in SQL from a fixed seed, so every fresh start
// produces the same figures. The company and every figure are invented. The
// shapes are chosen so the reports have something to show: growth, seasons,
// regions that beat or miss a target, channels that differ in efficiency.

// A table the seed creates when it is not already there.
export interface SampleTable {
	schema: string;
	table: string;
	statements: string[];
}

// Two years of orders up to today, growing over the period, busier before the
// holidays and in early summer. Discounts vary by channel and targets by
// region, so some regions beat their target and others miss it.
const ordersTable = [
	`CREATE SCHEMA IF NOT EXISTS sales`,
	`CREATE TABLE sales.orders (
		order_id         TEXT PRIMARY KEY,
		order_date       DATE NOT NULL,
		region           TEXT NOT NULL,
		country          TEXT NOT NULL,
		channel          TEXT NOT NULL,
		product_category TEXT NOT NULL,
		product          TEXT NOT NULL,
		sales_rep        TEXT NOT NULL,
		customer_segment TEXT NOT NULL,
		quantity         INTEGER NOT NULL,
		revenue          DOUBLE PRECISION NOT NULL,
		cost             DOUBLE PRECISION NOT NULL,
		target_revenue   DOUBLE PRECISION NOT NULL
	 )`,
	`SELECT setseed(0.42)`,
	`INSERT INTO sales.orders
	 WITH days AS (
		SELECT d::date AS day,
		       (d::date - (date_trunc('month', now()) - interval '24 months')::date)
		         / 730.0 AS progress
		FROM generate_series(date_trunc('month', now()) - interval '24 months',
		                     now()::date, interval '1 day') AS d
	 ),
	 counts AS (
		SELECT day, progress,
		       greatest(4, round((14 + 12 * progress)
		         * CASE WHEN extract(month FROM day) IN (11, 12) THEN 1.4
		                WHEN extract(month FROM day) IN (5, 6, 7) THEN 1.2
		                WHEN extract(month FROM day) IN (1, 2) THEN 0.8
		                ELSE 1 END
		         * (0.75 + 0.5 * random())))::int AS n
		FROM days
	 ),
	 picks AS (
		SELECT c.day,
		       1 + floor(random() * 15)::int AS p,
		       1 + width_bucket(random(),
		         ARRAY[0.30, 0.38, 0.48, 0.57, 0.64, 0.72, 0.79, 0.85]) AS place,
		       1 + width_bucket(random(), ARRAY[0.5, 0.8]) AS ch,
		       1 + width_bucket(random(), ARRAY[0.55, 0.85]) AS seg,
		       random() AS r_qty, random() AS r_price
		FROM counts c CROSS JOIN LATERAL generate_series(1, c.n) AS g
	 ),
	 shaped AS (
		SELECT p.*,
		       (ARRAY['Tents','Tents','Tents','Backpacks','Backpacks','Backpacks',
		              'Footwear','Footwear','Footwear','Apparel','Apparel','Apparel',
		              'Climbing','Climbing','Climbing'])[p.p] AS product_category,
		       (ARRAY['Ridgeline 2P Tent','Basecamp 4P Tent','Ultralight Bivy',
		              'Trailhead 45L Pack','Summit 65L Pack','Daytrip 22L Pack',
		              'Granite Hiking Boot','Trail Runner','Camp Sandal',
		              'Storm Shell Jacket','Merino Base Layer','Fleece Midlayer',
		              'Dynamic Rope 60m','Harness Pro','Chalk Bag'])[p.p] AS product,
		       (ARRAY[329,549,189,219,289,89,179,139,59,249,79,99,199,89,25])[p.p]
		         ::double precision AS list_price,
		       (ARRAY[0.52,0.55,0.48,0.45,0.47,0.40,0.50,0.46,0.38,0.42,0.36,0.37,
		              0.55,0.44,0.30])[p.p]::double precision AS cost_ratio,
		       (ARRAY['North America','North America','Europe','Europe','Europe',
		              'Asia Pacific','Asia Pacific','Latin America',
		              'Latin America'])[p.place] AS region,
		       (ARRAY['United States','Canada','Germany','United Kingdom','France',
		              'Japan','Australia','Brazil','Mexico'])[p.place] AS country,
		       (ARRAY['Online','Retail','Wholesale'])[p.ch] AS channel,
		       (ARRAY['Consumer','Small Business','Enterprise'])[p.seg]
		         AS customer_segment
		FROM picks p
	 ),
	 priced AS (
		SELECT s.*,
		       CASE s.channel WHEN 'Wholesale' THEN 5 + floor(s.r_qty * 20)::int
		                      ELSE 1 + floor(s.r_qty * s.r_qty * 3)::int END AS quantity,
		       CASE s.channel WHEN 'Wholesale' THEN 0.80
		                      WHEN 'Retail' THEN 0.97 ELSE 0.92 END
		         * (0.95 + 0.1 * s.r_price) AS paid_share,
		       CASE s.region WHEN 'North America' THEN 0.97 WHEN 'Europe' THEN 1.05
		                     WHEN 'Asia Pacific' THEN 0.90 ELSE 1.08 END AS target_share
		FROM shaped s
	 )
	 SELECT 'SO-' || lpad((row_number() OVER (ORDER BY day, p, place))::text, 6, '0'),
	        day, region, country, channel, product_category, product,
	        (ARRAY['Dana Whitfield','Dana Whitfield','Sofia Lang','Tom Becker',
	               'Sofia Lang','Kenji Mori','Olivia Grant','Lucas Ferreira',
	               'Lucas Ferreira'])[place],
	        customer_segment, quantity,
	        round((quantity * list_price * paid_share)::numeric, 2)::double precision,
	        round((quantity * list_price * cost_ratio)::numeric, 2)::double precision,
	        round((quantity * list_price * 0.93 * target_share)::numeric, 2)
	          ::double precision
	 FROM priced`,
	// North America has two account managers.
	`UPDATE sales.orders SET sales_rep = 'Marcus Bell'
	 WHERE region = 'North America' AND abs(hashtext(order_id)) % 5 IN (0, 1)`,
];

// A support desk over the same two years. Replies get quicker over the period
// and satisfaction follows how long somebody waited.
const ticketsTable = [
	`CREATE SCHEMA IF NOT EXISTS support`,
	`CREATE TABLE support.tickets (
		ticket_id              TEXT PRIMARY KEY,
		opened_on              DATE NOT NULL,
		team                   TEXT NOT NULL,
		priority               TEXT NOT NULL,
		channel                TEXT NOT NULL,
		status                 TEXT NOT NULL,
		first_response_minutes DOUBLE PRECISION NOT NULL,
		resolution_hours       DOUBLE PRECISION,
		satisfaction           INTEGER,
		escalated              BOOLEAN NOT NULL
	 )`,
	`SELECT setseed(0.17)`,
	`INSERT INTO support.tickets
	 WITH days AS (
		SELECT d::date AS day,
		       (d::date - (date_trunc('month', now()) - interval '24 months')::date)
		         / 730.0 AS progress
		FROM generate_series(date_trunc('month', now()) - interval '24 months',
		                     now()::date, interval '1 day') AS d
	 ),
	 picks AS (
		SELECT d.day, d.progress,
		       1 + width_bucket(random(), ARRAY[0.25, 0.60, 0.85]) AS t,
		       1 + width_bucket(random(), ARRAY[0.35, 0.75, 0.93]) AS pr,
		       1 + width_bucket(random(), ARRAY[0.45, 0.80]) AS ch,
		       random() AS r_wait, random() AS r_fix, random() AS r_sat,
		       random() AS r_esc, random() AS r_open
		FROM days d
		CROSS JOIN LATERAL generate_series(1, 6 + floor(random() * 7)::int) AS g
	 ),
	 shaped AS (
		SELECT p.*,
		       (ARRAY['Billing','Technical','Orders','Returns'])[p.t] AS team,
		       (ARRAY['Low','Medium','High','Urgent'])[p.pr] AS priority,
		       (ARRAY['Email','Chat','Phone'])[p.ch] AS channel,
		       (ARRAY[480, 180, 60, 15])[p.pr] * (1.3 - 0.5 * p.progress)
		         * (0.4 + 1.2 * p.r_wait) AS wait
		FROM picks p
	 )
	 SELECT 'T-' || lpad((row_number() OVER (ORDER BY day, t, pr))::text, 6, '0'),
	        day, team, priority, channel,
	        CASE WHEN day > now()::date - 4 AND r_open < 0.5 THEN 'Open'
	             WHEN r_open < 0.03 THEN 'Open' ELSE 'Resolved' END,
	        round(wait::numeric, 1)::double precision,
	        round(((ARRAY[72, 30, 12, 4])[pr] * (0.3 + 1.4 * r_fix))::numeric, 1)
	          ::double precision,
	        least(5, greatest(1, round(5.4 - wait / (ARRAY[480, 180, 60, 15])[pr]
	          - 1.2 * r_sat)))::int,
	        r_esc < CASE team WHEN 'Technical' THEN 0.14 ELSE 0.05 END
	 FROM shaped`,
	`UPDATE support.tickets SET resolution_hours = NULL, satisfaction = NULL
	 WHERE status = 'Open'`,
];

// Campaigns across five marketing channels, each running in some regions on
// some days. Every channel has its own cost per thousand impressions, click
// rate and conversion rate, so channels differ in efficiency as well as size.
const campaignsTable = [
	`CREATE SCHEMA IF NOT EXISTS marketing`,
	`CREATE TABLE marketing.campaign_days (
		day                DATE NOT NULL,
		campaign           TEXT NOT NULL,
		channel            TEXT NOT NULL,
		region             TEXT NOT NULL,
		audience           TEXT NOT NULL,
		spend              DOUBLE PRECISION NOT NULL,
		impressions        BIGINT NOT NULL,
		clicks             BIGINT NOT NULL,
		conversions        BIGINT NOT NULL,
		attributed_revenue DOUBLE PRECISION NOT NULL
	 )`,
	`SELECT setseed(0.23)`,
	`INSERT INTO marketing.campaign_days
	 WITH days AS (
		SELECT d::date AS day,
		       CASE WHEN extract(month FROM d) IN (11, 12) THEN 1.5
		            WHEN extract(month FROM d) IN (4, 5, 6) THEN 1.2
		            ELSE 1 END AS season
		FROM generate_series(date_trunc('month', now()) - interval '24 months',
		                     now()::date, interval '1 day') AS d
	 ),
	 runs AS (
		SELECT d.day, d.season, c AS camp, r AS reg,
		       random() AS r1, random() AS r2, random() AS r3, random() AS r4
		FROM days d
		CROSS JOIN generate_series(1, 12) AS c
		CROSS JOIN generate_series(1, 4) AS r
		WHERE random() < 0.65
	 ),
	 shaped AS (
		SELECT r.*,
		       (ARRAY['Spring Trail Launch','Summit Sale','Weekend Warrior',
		              'Base Layer Bundle','Gear Up for Fall','Holiday Gift Guide',
		              'Trail Ambassador','Rope and Harness Promo','Camp Season',
		              'Always On Search','Loyalty Rewards','Creator Partnerships'])[camp]
		         AS campaign,
		       (ARRAY[1,2,3,4,1,2,5,4,3,1,4,5])[camp] AS ch,
		       (ARRAY['Hikers','Climbers','Casual','Returning','Hikers','Gift Buyers',
		              'Enthusiasts','Climbers','Families','All Visitors','Returning',
		              'Casual'])[camp] AS audience,
		       (ARRAY[420,300,180,60,380,520,150,70,220,650,80,200])[camp]
		         ::double precision AS base_spend,
		       (ARRAY['North America','Europe','Asia Pacific','Latin America'])[reg]
		         AS region,
		       (ARRAY[1.0, 0.7, 0.5, 0.35])[reg] AS region_scale
		FROM runs r
	 ),
	 spent AS (
		SELECT s.*,
		       (ARRAY['Paid Search','Social','Display','Email','Affiliate'])[ch]
		         AS channel,
		       base_spend * region_scale * season * (0.6 + 0.8 * r1) AS spend
		FROM shaped s
	 ),
	 funnel AS (
		SELECT s.*,
		       spend / (ARRAY[12, 8, 4, 2, 10])[ch] * 1000 AS impressions
		FROM spent s
	 ),
	 clicked AS (
		SELECT f.*,
		       impressions * (ARRAY[0.035, 0.012, 0.004, 0.06, 0.02])[ch]
		         * (0.7 + 0.6 * r2) AS clicks
		FROM funnel f
	 ),
	 converted AS (
		SELECT c.*,
		       clicks * (ARRAY[0.045, 0.02, 0.01, 0.05, 0.035])[ch]
		         * (0.6 + 0.8 * r3) AS conversions
		FROM clicked c
	 )
	 SELECT day, campaign, channel, region, audience,
	        round(spend::numeric, 2)::double precision,
	        round(impressions)::bigint, round(clicks)::bigint,
	        round(conversions)::bigint,
	        round((round(conversions) * 140 * (0.8 + 0.4 * r4))::numeric, 2)
	          ::double precision
	 FROM converted`,
];

// Monthly spend by department, account and cost centre against a budget that
// rises through the period. Some departments run over and some under.
const ledgerTable = [
	`CREATE SCHEMA IF NOT EXISTS finance`,
	`CREATE TABLE finance.ledger (
		month         DATE NOT NULL,
		department    TEXT NOT NULL,
		account_group TEXT NOT NULL,
		cost_center   TEXT NOT NULL,
		actual        DOUBLE PRECISION NOT NULL,
		budget        DOUBLE PRECISION NOT NULL,
		forecast      DOUBLE PRECISION NOT NULL
	 )`,
	`SELECT setseed(0.31)`,
	`INSERT INTO finance.ledger
	 WITH months AS (
		SELECT m::date AS month, row_number() OVER (ORDER BY m) / 24.0 AS progress
		FROM generate_series(date_trunc('month', now()) - interval '23 months',
		                     date_trunc('month', now()), interval '1 month') AS m
	 ),
	 lines AS (
		SELECT m.month, m.progress, d, a, c,
		       (ARRAY[1.2, 1.0, 1.4, 1.6, 0.7, 0.8])[d] AS dept_scale,
		       (ARRAY[1.02, 1.05, 0.97, 1.08, 0.94, 1.0])[d] AS dept_bias,
		       (ARRAY[90000, 12000, 6000, 15000, 20000, 18000])[a] AS account_base,
		       (ARRAY[0.45, 0.25, 0.18, 0.12])[c] AS centre_share
		FROM months m
		CROSS JOIN generate_series(1, 6) AS d
		CROSS JOIN generate_series(1, 6) AS a
		CROSS JOIN generate_series(1, 4) AS c
	 ),
	 budgeted AS (
		SELECT l.*,
		       account_base * dept_scale * centre_share * (1 + 0.1 * progress)
		         AS budget
		FROM lines l
	 )
	 SELECT month,
	        (ARRAY['Sales','Marketing','Operations','Engineering','Finance',
	               'Customer Support'])[d],
	        (ARRAY['Salaries','Software','Travel','Facilities','Contractors',
	               'Programs'])[a],
	        (ARRAY['North America','Europe','Asia Pacific','Latin America'])[c],
	        round((budget * dept_bias * (0.88 + 0.24 * random()))::numeric, 2)
	          ::double precision,
	        round(budget::numeric, 2)::double precision,
	        round((budget * dept_bias * (0.96 + 0.08 * random()))::numeric, 2)
	          ::double precision
	 FROM budgeted`,
];

// Shipments out of five warehouses with four carriers. Carriers differ in how
// often they arrive on time and what they charge, and every carrier gets a
// little more reliable over the period.
const shipmentsTable = [
	`CREATE SCHEMA IF NOT EXISTS operations`,
	`CREATE TABLE operations.shipments (
		shipment_id        TEXT PRIMARY KEY,
		ship_date          DATE NOT NULL,
		warehouse          TEXT NOT NULL,
		carrier            TEXT NOT NULL,
		destination_region TEXT NOT NULL,
		service_level      TEXT NOT NULL,
		promised_days      INTEGER NOT NULL,
		actual_days        INTEGER NOT NULL,
		on_time            BOOLEAN NOT NULL,
		freight_cost       DOUBLE PRECISION NOT NULL,
		weight_kg          DOUBLE PRECISION NOT NULL,
		damaged            BOOLEAN NOT NULL
	 )`,
	`SELECT setseed(0.57)`,
	`INSERT INTO operations.shipments
	 WITH days AS (
		SELECT d::date AS day,
		       (d::date - (date_trunc('month', now()) - interval '24 months')::date)
		         / 730.0 AS progress
		FROM generate_series(date_trunc('month', now()) - interval '24 months',
		                     now()::date, interval '1 day') AS d
	 ),
	 picks AS (
		SELECT d.day, d.progress,
		       1 + width_bucket(random(), ARRAY[0.3, 0.55, 0.75, 0.9]) AS w,
		       1 + width_bucket(random(), ARRAY[0.35, 0.6, 0.85]) AS c,
		       1 + width_bucket(random(), ARRAY[0.6, 0.85]) AS s,
		       random() AS r_dest, random() AS r_late, random() AS r_by,
		       random() AS r_wt, random() AS r_dmg
		FROM days d
		CROSS JOIN LATERAL generate_series(1, 12 + floor(random() * 13)::int) AS g
	 ),
	 shaped AS (
		SELECT p.*,
		       (ARRAY['Reno','Memphis','Rotterdam','Singapore','Sao Paulo'])[w]
		         AS warehouse,
		       CASE WHEN r_dest < 0.8
		            THEN (ARRAY['North America','North America','Europe',
		                        'Asia Pacific','Latin America'])[w]
		            ELSE (ARRAY['Europe','Latin America','North America',
		                        'Europe','North America'])[w] END AS destination_region,
		       (ARRAY['FastFreight','BlueLine','Northstar Parcel','Oceanic'])[c]
		         AS carrier,
		       (ARRAY['Standard','Express','Freight'])[s] AS service_level,
		       (ARRAY[5, 2, 9])[s] AS promised_days,
		       r_late > (ARRAY[0.9, 0.84, 0.88, 0.76])[c] + 0.05 * progress AS late,
		       CASE WHEN s = 3 THEN 200 + r_wt * 800 ELSE 1 + r_wt * r_wt * 40 END
		         AS weight
		FROM picks p
	 )
	 SELECT 'SH-' || lpad((row_number() OVER (ORDER BY day, w, c))::text, 6, '0'),
	        day, warehouse, carrier, destination_region, service_level,
	        promised_days,
	        greatest(1, promised_days + CASE WHEN late THEN 1 + floor(r_by * 4)::int
	                                         ELSE -floor(r_by * 2)::int END),
	        NOT late,
	        round((weight * (ARRAY[1.2, 3.1, 0.45])[
	          CASE service_level WHEN 'Standard' THEN 1 WHEN 'Express' THEN 2 ELSE 3 END]
	          * (ARRAY[1.0, 0.9, 1.1, 0.8])[
	          CASE carrier WHEN 'FastFreight' THEN 1 WHEN 'BlueLine' THEN 2
	                       WHEN 'Northstar Parcel' THEN 3 ELSE 4 END]
	          + 6)::numeric, 2)::double precision,
	        round(weight::numeric, 1)::double precision,
	        r_dmg < 0.015
	 FROM shaped`,
];

// Month-end headcount by department, location and level, with the hires,
// leavers, open roles and survey engagement for each month.
const headcountTable = [
	`CREATE SCHEMA IF NOT EXISTS people`,
	`CREATE TABLE people.headcount_monthly (
		month       DATE NOT NULL,
		department  TEXT NOT NULL,
		location    TEXT NOT NULL,
		level       TEXT NOT NULL,
		headcount   INTEGER NOT NULL,
		hires       INTEGER NOT NULL,
		exits       INTEGER NOT NULL,
		open_roles  INTEGER NOT NULL,
		engagement  DOUBLE PRECISION NOT NULL,
		salary_cost DOUBLE PRECISION NOT NULL
	 )`,
	`SELECT setseed(0.71)`,
	`INSERT INTO people.headcount_monthly
	 WITH months AS (
		SELECT m::date AS month, row_number() OVER (ORDER BY m) / 24.0 AS progress
		FROM generate_series(date_trunc('month', now()) - interval '23 months',
		                     date_trunc('month', now()), interval '1 month') AS m
	 ),
	 cells AS (
		SELECT m.month, m.progress, d, l, v,
		       (ARRAY[40, 18, 55, 70, 12, 35])[d]
		         * (ARRAY[0.35, 0.2, 0.2, 0.1, 0.15])[l]
		         * (ARRAY[0.8, 0.15, 0.05])[v]
		         * (1 + 0.25 * m.progress) AS size,
		       (ARRAY[1.3, 1.1, 1.2, 0.8, 0.7, 1.6])[d] AS churn,
		       (ARRAY[3.8, 3.9, 3.6, 4.2, 4.0, 3.4])[d] AS mood,
		       (ARRAY[85000, 140000, 210000])[v] AS salary
		FROM months m
		CROSS JOIN generate_series(1, 6) AS d
		CROSS JOIN generate_series(1, 5) AS l
		CROSS JOIN generate_series(1, 3) AS v
	 )
	 SELECT month,
	        (ARRAY['Sales','Marketing','Operations','Engineering','Finance',
	               'Customer Support'])[d],
	        (ARRAY['Denver','Austin','London','Singapore','Remote'])[l],
	        (ARRAY['Individual Contributor','Manager','Director'])[v],
	        greatest(1, round(size * (0.95 + 0.1 * random())))::int,
	        floor(size * 0.03 * 2 * random() + random())::int,
	        floor(size * 0.012 * churn * 2 * random() + random() * 0.8)::int,
	        floor(size * 0.04 * random() + random())::int,
	        round((mood + 0.4 * (random() - 0.5))::numeric, 2)::double precision,
	        round((size * salary / 12)::numeric, 2)::double precision
	 FROM cells`,
];

// Daily visits to the online store by where they came from, the device and
// the page they landed on, down to the orders they placed.
const sessionsTable = [
	`CREATE SCHEMA IF NOT EXISTS web`,
	`CREATE TABLE web.sessions_daily (
		day            DATE NOT NULL,
		traffic_source TEXT NOT NULL,
		device         TEXT NOT NULL,
		landing_page   TEXT NOT NULL,
		country        TEXT NOT NULL,
		sessions       INTEGER NOT NULL,
		bounces        INTEGER NOT NULL,
		add_to_carts   INTEGER NOT NULL,
		orders         INTEGER NOT NULL,
		revenue        DOUBLE PRECISION NOT NULL
	 )`,
	`SELECT setseed(0.89)`,
	`INSERT INTO web.sessions_daily
	 WITH days AS (
		SELECT d::date AS day,
		       (d::date - (date_trunc('month', now()) - interval '24 months')::date)
		         / 730.0 AS progress,
		       CASE WHEN extract(month FROM d) IN (11, 12) THEN 1.4
		            WHEN extract(month FROM d) IN (5, 6, 7) THEN 1.15
		            ELSE 1 END AS season
		FROM generate_series(date_trunc('month', now()) - interval '24 months',
		                     now()::date, interval '1 day') AS d
	 ),
	 combos AS (
		SELECT d.*, src, dev, page,
		       1 + width_bucket(random(),
		         ARRAY[0.4, 0.5, 0.6, 0.7, 0.78, 0.86, 0.93]) AS ctry,
		       random() AS r1, random() AS r2, random() AS r3, random() AS r4
		FROM days d
		CROSS JOIN generate_series(1, 6) AS src
		CROSS JOIN generate_series(1, 3) AS dev
		CROSS JOIN generate_series(1, 6) AS page
		WHERE random() < 0.4
	 ),
	 visits AS (
		SELECT c.*,
		       greatest(1, round((ARRAY[1800, 900, 400, 600, 1000, 250])[src]
		         * (ARRAY[0.4, 0.52, 0.08])[dev]
		         * (ARRAY[0.3, 0.15, 0.12, 0.13, 0.15, 0.15])[page]
		         * (1 + 0.35 * progress) * season * (0.6 + 0.8 * r1)))::int
		         AS sessions
		FROM combos c
	 ),
	 carts AS (
		SELECT v.*,
		       round(sessions * (ARRAY[0.09, 0.06, 0.07])[dev]
		         * (ARRAY[0.8, 1.1, 1.0, 1.0, 1.0, 1.4])[page]
		         * (0.7 + 0.6 * r2))::int AS add_to_carts
		FROM visits v
	 ),
	 ordered AS (
		SELECT c.*,
		       round(add_to_carts * (ARRAY[0.38, 0.27, 0.32])[dev]
		         * (0.7 + 0.6 * r3))::int AS orders
		FROM carts c
	 )
	 SELECT day,
	        (ARRAY['Organic Search','Paid Search','Email','Social','Direct',
	               'Referral'])[src],
	        (ARRAY['Desktop','Mobile','Tablet'])[dev],
	        (ARRAY['Home','Tents','Backpacks','Footwear','Apparel','Sale'])[page],
	        (ARRAY['United States','Canada','Germany','United Kingdom','France',
	               'Japan','Australia','Brazil'])[ctry],
	        sessions,
	        round(sessions * (ARRAY[0.38, 0.52, 0.45])[dev]
	          * (0.85 + 0.3 * r4))::int,
	        add_to_carts, orders,
	        round((orders * 130 * (0.8 + 0.4 * r4))::numeric, 2)::double precision
	 FROM ordered`,
];

export const sampleTables: SampleTable[] = [
	{ schema: "sales", table: "orders", statements: ordersTable },
	{ schema: "support", table: "tickets", statements: ticketsTable },
	{ schema: "marketing", table: "campaign_days", statements: campaignsTable },
	{ schema: "finance", table: "ledger", statements: ledgerTable },
	{ schema: "operations", table: "shipments", statements: shipmentsTable },
	{ schema: "people", table: "headcount_monthly", statements: headcountTable },
	{ schema: "web", table: "sessions_daily", statements: sessionsTable },
];

// --- Sources and fields --------------------------------------------------------

export interface FieldSeed {
	name: string;
	kind: "dimension" | "measure";
	expr: string;
	type: string;
	format: string | null;
	description: string;
}

export interface SourceSeed {
	key: string;
	title: string;
	description: string;
	schema: string;
	object: string;
	timeField: string;
	// Marked live, so the demonstration shows a page following its data.
	live?: boolean;
	fields: FieldSeed[];
}

const dimension = (
	name: string,
	expr: string,
	description: string,
	type = "string",
): FieldSeed => ({
	name,
	kind: "dimension",
	expr,
	type,
	format: type === "date" ? "date" : "text",
	description,
});

const measure = (
	name: string,
	expr: string,
	format: string,
	description: string,
): FieldSeed => ({
	name,
	kind: "measure",
	expr,
	type: format === "integer" ? "bigint" : "double",
	format,
	description,
});

export const sources: SourceSeed[] = [
	{
		key: "sales_orders",
		title: "Sales orders",
		description:
			"Every order taken across the online store, retail partners and wholesale accounts, one row per order line.",
		schema: "sales",
		object: "orders",
		timeField: "Order Date",
		fields: [
			dimension("Order Date", "order_date", "The day the order was placed.", "date"),
			dimension("Region", "region", "The sales region the customer is in."),
			dimension("Country", "country", "The country the order ships to."),
			dimension(
				"Channel",
				"channel",
				"Where the order was taken: the online store, a retail partner or a wholesale account.",
			),
			dimension("Product Category", "product_category", "The product family."),
			dimension("Product", "product", "The product ordered."),
			dimension("Sales Rep", "sales_rep", "The account manager for the region."),
			dimension(
				"Customer Segment",
				"customer_segment",
				"Consumer, small business or enterprise, from the customer record.",
			),
			dimension("Order ID", "order_id", "The order number."),
			measure("Revenue", "SUM(revenue)", "currency", "What customers paid, after discounts."),
			measure(
				"Gross Margin",
				"SUM(revenue - cost)",
				"currency",
				"Revenue less the cost of the goods sold.",
			),
			measure(
				"Margin Pct",
				"100.0 * SUM(revenue - cost) / NULLIF(SUM(revenue), 0)",
				"percent",
				"Gross margin as a share of revenue.",
			),
			measure("Orders", "COUNT(DISTINCT order_id)", "integer", "How many orders were placed."),
			measure("Units", "SUM(quantity)", "integer", "How many items were sold."),
			measure(
				"Average Order Value",
				"SUM(revenue) / NULLIF(COUNT(DISTINCT order_id), 0)",
				"currency",
				"Revenue divided by the number of orders.",
			),
			measure(
				"Revenue Target",
				"SUM(target_revenue)",
				"currency",
				"The revenue the region planned for, spread over its orders.",
			),
		],
	},
	{
		key: "support_tickets",
		title: "Support tickets",
		description:
			"Every customer support request, from when it was opened to how it was resolved and rated.",
		schema: "support",
		object: "tickets",
		timeField: "Opened Date",
		fields: [
			dimension("Opened Date", "opened_on", "The day the ticket was opened.", "date"),
			dimension("Team", "team", "The team the ticket was routed to."),
			dimension("Priority", "priority", "Low, medium, high or urgent, set on intake."),
			dimension("Channel", "channel", "How the customer got in touch."),
			dimension("Status", "status", "Open, or resolved."),
			measure("Tickets", "COUNT(*)", "integer", "How many tickets were opened."),
			measure(
				"Avg First Response Minutes",
				"AVG(first_response_minutes)",
				"decimal",
				"How long a customer waited for the first reply, on average.",
			),
			measure(
				"Avg Resolution Hours",
				"AVG(resolution_hours)",
				"decimal",
				"How long a resolved ticket took to close, on average.",
			),
			measure(
				"Satisfaction Score",
				"AVG(satisfaction)",
				"decimal",
				"The average rating customers gave, out of five.",
			),
			measure(
				"Resolved Pct",
				"100.0 * AVG(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END)",
				"percent",
				"The share of tickets that are resolved.",
			),
			measure(
				"Escalation Pct",
				"100.0 * AVG(CASE WHEN escalated THEN 1 ELSE 0 END)",
				"percent",
				"The share of tickets passed up to a specialist.",
			),
		],
	},
	{
		key: "marketing_campaigns",
		title: "Marketing campaigns",
		description:
			"Daily results for every campaign in every region, from spend to the revenue it brought in.",
		schema: "marketing",
		object: "campaign_days",
		timeField: "Day",
		fields: [
			dimension("Day", "day", "The day the campaign ran.", "date"),
			dimension("Campaign", "campaign", "The campaign name."),
			dimension(
				"Channel",
				"channel",
				"Paid search, social, display, email or affiliate.",
			),
			dimension("Region", "region", "The region the campaign ran in."),
			dimension("Audience", "audience", "Who the campaign was aimed at."),
			measure("Spend", "SUM(spend)", "currency", "What the campaign cost."),
			measure(
				"Impressions",
				"SUM(impressions)",
				"integer",
				"How many times an ad was shown.",
			),
			measure("Clicks", "SUM(clicks)", "integer", "How many times an ad was clicked."),
			measure(
				"Conversions",
				"SUM(conversions)",
				"integer",
				"Orders that followed a click.",
			),
			measure(
				"Attributed Revenue",
				"SUM(attributed_revenue)",
				"currency",
				"Revenue from the orders that followed a click.",
			),
			measure(
				"ROAS",
				"SUM(attributed_revenue) / NULLIF(SUM(spend), 0)",
				"decimal",
				"Return on ad spend, revenue for each unit spent.",
			),
			measure(
				"Click Through Pct",
				"100.0 * SUM(clicks) / NULLIF(SUM(impressions), 0)",
				"percent",
				"The share of impressions that were clicked.",
			),
			measure(
				"Conversion Pct",
				"100.0 * SUM(conversions) / NULLIF(SUM(clicks), 0)",
				"percent",
				"The share of clicks that led to an order.",
			),
			measure(
				"Cost per Conversion",
				"SUM(spend) / NULLIF(SUM(conversions), 0)",
				"currency",
				"Spend divided by conversions.",
			),
		],
	},
	{
		key: "finance_ledger",
		title: "Operating spend",
		description:
			"Monthly operating spend by department, account and cost centre, with budget and forecast.",
		schema: "finance",
		object: "ledger",
		timeField: "Month",
		fields: [
			dimension("Month", "month", "The month the spend was booked in.", "date"),
			dimension("Department", "department", "The department that spent it."),
			dimension(
				"Account Group",
				"account_group",
				"What it was spent on, such as salaries, software or travel.",
			),
			dimension("Cost Center", "cost_center", "The regional cost centre."),
			measure("Actual Spend", "SUM(actual)", "currency", "What was spent."),
			measure("Budget", "SUM(budget)", "currency", "What was planned."),
			measure(
				"Forecast",
				"SUM(forecast)",
				"currency",
				"The latest estimate of what will be spent.",
			),
			measure(
				"Budget Variance",
				"SUM(actual) - SUM(budget)",
				"currency",
				"Spend less budget. Above zero is over budget.",
			),
			measure(
				"Budget Variance Pct",
				"100.0 * (SUM(actual) - SUM(budget)) / NULLIF(SUM(budget), 0)",
				"percent",
				"The variance as a share of budget.",
			),
			measure(
				"Budget Used Pct",
				"100.0 * SUM(actual) / NULLIF(SUM(budget), 0)",
				"percent",
				"Spend as a share of budget.",
			),
		],
	},
	{
		key: "operations_shipments",
		title: "Shipments",
		description:
			"Every shipment out of the warehouses, with the carrier, how long it took and what it cost.",
		schema: "operations",
		object: "shipments",
		timeField: "Ship Date",
		fields: [
			dimension("Ship Date", "ship_date", "The day it left the warehouse.", "date"),
			dimension("Warehouse", "warehouse", "The warehouse it shipped from."),
			dimension("Carrier", "carrier", "The carrier that delivered it."),
			dimension(
				"Destination Region",
				"destination_region",
				"The region it was delivered to.",
			),
			dimension(
				"Service Level",
				"service_level",
				"Standard, express or freight.",
			),
			dimension("Shipment ID", "shipment_id", "The shipment number."),
			measure("Shipments", "COUNT(*)", "integer", "How many shipments went out."),
			measure(
				"On Time Pct",
				"100.0 * AVG(CASE WHEN on_time THEN 1 ELSE 0 END)",
				"percent",
				"The share delivered within the promised days.",
			),
			measure(
				"Late Shipments",
				"SUM(CASE WHEN on_time THEN 0 ELSE 1 END)",
				"integer",
				"How many arrived after the promised day.",
			),
			measure(
				"Avg Delivery Days",
				"AVG(actual_days)",
				"decimal",
				"Days from shipping to delivery, on average.",
			),
			measure("Freight Cost", "SUM(freight_cost)", "currency", "What the carriers charged."),
			measure(
				"Cost per Shipment",
				"SUM(freight_cost) / NULLIF(COUNT(*), 0)",
				"currency",
				"Freight cost divided by shipments.",
			),
			measure("Weight Kg", "SUM(weight_kg)", "decimal", "Total weight shipped."),
			measure(
				"Damage Pct",
				"100.0 * AVG(CASE WHEN damaged THEN 1 ELSE 0 END)",
				"percent",
				"The share that arrived damaged.",
			),
		],
	},
	{
		key: "people_headcount",
		title: "Headcount",
		description:
			"Month-end headcount by department, location and level, with hiring, leavers and engagement.",
		schema: "people",
		object: "headcount_monthly",
		timeField: "Month",
		fields: [
			dimension("Month", "month", "The month the figures are for.", "date"),
			dimension("Department", "department", "The department."),
			dimension("Location", "location", "The office, or remote."),
			dimension(
				"Level",
				"level",
				"Individual contributor, manager or director.",
			),
			measure(
				"Average Headcount",
				"SUM(headcount) * 1.0 / NULLIF(COUNT(DISTINCT month), 0)",
				"integer",
				"People employed at month end, averaged over the months shown.",
			),
			measure("Hires", "SUM(hires)", "integer", "People who joined."),
			measure("Exits", "SUM(exits)", "integer", "People who left."),
			measure(
				"Open Roles",
				"SUM(open_roles) * 1.0 / NULLIF(COUNT(DISTINCT month), 0)",
				"integer",
				"Roles being recruited for, averaged over the months shown.",
			),
			measure(
				"Attrition Pct",
				"100.0 * SUM(exits) / NULLIF(SUM(headcount) * 1.0 / NULLIF(COUNT(DISTINCT month), 0), 0)",
				"percent",
				"Leavers as a share of average headcount over the months shown.",
			),
			measure(
				"Engagement Score",
				"SUM(engagement * headcount) / NULLIF(SUM(headcount), 0)",
				"decimal",
				"The average survey score out of five, weighted by headcount.",
			),
			measure("Salary Cost", "SUM(salary_cost)", "currency", "What salaries cost."),
		],
	},
	{
		key: "web_sessions",
		title: "Online store visits",
		description:
			"Daily visits to the online store, from where people came from to what they bought.",
		schema: "web",
		object: "sessions_daily",
		timeField: "Day",
		live: true,
		fields: [
			dimension("Day", "day", "The day of the visit.", "date"),
			dimension(
				"Traffic Source",
				"traffic_source",
				"Where the visitor came from.",
			),
			dimension("Device", "device", "Desktop, mobile or tablet."),
			dimension("Landing Page", "landing_page", "The first page they saw."),
			dimension("Country", "country", "Where the visitor was."),
			measure("Sessions", "SUM(sessions)", "integer", "How many visits there were."),
			measure(
				"Bounce Pct",
				"100.0 * SUM(bounces) / NULLIF(SUM(sessions), 0)",
				"percent",
				"The share of visits that left after one page.",
			),
			measure(
				"Add to Carts",
				"SUM(add_to_carts)",
				"integer",
				"Visits where something was added to the cart.",
			),
			measure("Web Orders", "SUM(orders)", "integer", "Orders placed online."),
			measure(
				"Conversion Pct",
				"100.0 * SUM(orders) / NULLIF(SUM(sessions), 0)",
				"percent",
				"The share of visits that ended in an order.",
			),
			measure("Web Revenue", "SUM(revenue)", "currency", "Revenue from online orders."),
			measure(
				"Revenue per Session",
				"SUM(revenue) / NULLIF(SUM(sessions), 0)",
				"currency",
				"Web revenue divided by sessions.",
			),
		],
	},
];
