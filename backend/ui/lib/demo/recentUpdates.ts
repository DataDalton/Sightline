import { sql } from "../data/lakebase";
import { localIdentityEmail } from "../runtime";

// Two breaking changes to Sales orders kept recent, so a report page on it always has
// live notices to show. The first names the Orders measure, so the visuals reading it are
// marked as well. The rest of the demo's changelog has fixed dates, which age past the
// time a page shows a change for. Written once and moved relative to today on every start.

const day = 24 * 60 * 60 * 1000;

const recent = [
	{
		reference: "demo-recent-1",
		title: "Sales orders now has one row per order line",
		body: "<p>Sales orders moved from one row per order to one row per order line, so each product on an order is its own row.</p>",
		whatToDo:
			"Totals are unchanged. Counts of rows now count order lines, so use Order Count for the number of orders.",
		about: [
			{ kind: "source", id: "sales_orders" },
			{
				kind: "field",
				id: "Orders",
				sourceKey: "sales_orders",
				change: "changed",
			},
		],
		// Took effect yesterday, posted the day before.
		postedDaysAgo: 2,
		effectiveInDays: -1,
	},
	{
		reference: "demo-recent-2",
		title: "Discount Amount is removed from Sales orders",
		body: "<p>Discount Amount is no longer loaded. Net Revenue already has discounts taken off.</p>",
		whatToDo:
			"Visuals using Discount Amount will show it as missing. Switch them to Net Revenue before it goes.",
		about: [{ kind: "source", id: "sales_orders" }],
		// Announced today, takes effect next week.
		postedDaysAgo: 0,
		effectiveInDays: 7,
	},
];

export async function seedRecentUpdates(): Promise<void> {
	const now = Date.now();
	for (const entry of recent) {
		const postedOn = new Date(
			now - entry.postedDaysAgo * day,
		).toISOString();
		const effectiveOn = new Date(
			now + entry.effectiveInDays * day,
		).toISOString();
		const moved = await sql(
			`UPDATE updates SET posted_on = $2, effective_on = $3, delivered_on = $2,
			   about = $4::jsonb
			 WHERE reference = $1
			 RETURNING update_id`,
			[
				entry.reference,
				postedOn,
				effectiveOn,
				JSON.stringify(entry.about),
			],
		);
		if (moved.length > 0) continue;
		await sql(
			`INSERT INTO updates
			   (type, title, body, impact, status, about, delivery, reference, posted_on,
			    effective_on, created_by, notify, what_to_do, delivered_on)
			 VALUES ('dataChange', $1, $2, 'breaking', 'published', $8::jsonb,
			         '{"banner": false, "popup": false, "home": true, "inbox": false,
			           "push": false, "page": true}'::jsonb,
			         $3, $4, $5, $6, FALSE, $7, $4)`,
			[
				entry.title,
				entry.body,
				entry.reference,
				postedOn,
				effectiveOn,
				localIdentityEmail,
				entry.whatToDo,
				JSON.stringify(entry.about),
			],
		);
	}
}
