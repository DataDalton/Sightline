import { sql } from "../data/lakebase";
import {
	cachedDefinition,
	invalidateDefinitions,
} from "../platform/definitionCache";

// Everyone with an alert, a followed page alert or a scheduled report, held
// once for the whole app rather than asked about per person.
//
// The passes that run while somebody uses the app confirm their access and
// check what is due under their token, several statements each. Most people
// have none of these, and for them every one of those statements finds
// nothing. Held until somebody gains one, which drops it on every instance.
// See lib/platform/changes. Removing one is not announced, because a person
// left in the set only costs a pass that finds nothing.
const ownersKey = "alert-owners:all";

async function owners(): Promise<Set<string>> {
	return cachedDefinition(ownersKey, async () => {
		const rows = await sql<{ email: string }>(
			`SELECT lower(owner_email) AS email FROM alert_rules
			 UNION SELECT lower(email) FROM page_alert_subscriptions
			 UNION SELECT lower(owner_email) FROM deliveries`,
		);
		return new Set(rows.map((r) => r.email));
	});
}

// Whether the passes for this person have anything to look at. A failed read
// answers yes, so a fault costs the queries this saves and never a skipped
// check.
export async function hasOwnedChecks(email: string): Promise<boolean> {
	try {
		return (await owners()).has(email.toLowerCase());
	} catch {
		return true;
	}
}

// Called after a row is written that can make somebody new an owner.
export function ownersChanged(): void {
	invalidateDefinitions("alert-owners:");
}
