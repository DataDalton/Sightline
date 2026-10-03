import { sql, transaction } from "../data/lakebase";
import { invalidateDefinitions } from "../platform/definitionCache";

// Drops the reader's held home page plan, which carries their choices. See
// briefingPlan in lib/briefing/plan.
export function forgetPlan(email: string): void {
	invalidateDefinitions(`briefing-plan:${email.toLowerCase()}|`);
}

// Figures a reader pinned to their briefing or hid from it. Pins keep the
// order the reader put them in, which is the order the briefing shows them.

export type Choice = "pin" | "hide";

export interface BriefingChoice {
	reportId: string;
	measure: string;
	choice: Choice;
}

// Pins first, in the reader's order, then hides.
export async function listChoices(email: string): Promise<BriefingChoice[]> {
	const rows = await sql<{
		report_id: string;
		measure: string;
		choice: Choice;
	}>(
		`SELECT report_id::text AS report_id, measure, choice
		 FROM briefing_choices
		 WHERE user_email = $1
		 ORDER BY choice = 'hide', position NULLS LAST, chosen_on`,
		[email.toLowerCase()],
	);
	return rows.map((r) => ({
		reportId: r.report_id,
		measure: r.measure,
		choice: r.choice,
	}));
}

// Sets or clears one choice. Null clears it, which is how a hidden figure
// comes back and a pinned one goes back to being chosen for the reader. A new
// pin goes after the reader's other pins.
export async function setChoice(
	email: string,
	reportId: string,
	measure: string,
	choice: Choice | null,
): Promise<void> {
	const owner = email.toLowerCase();
	if (choice === null) {
		await sql(
			`DELETE FROM briefing_choices
			 WHERE user_email = $1 AND report_id = $2::uuid AND measure = $3`,
			[owner, reportId, measure],
		);
		forgetPlan(owner);
		return;
	}
	await sql(
		`INSERT INTO briefing_choices
		   (user_email, report_id, measure, choice, position)
		 VALUES ($1, $2::uuid, $3, $4,
		   CASE WHEN $4 = 'pin' THEN (
		     SELECT coalesce(max(position), 0) + 1 FROM briefing_choices
		     WHERE user_email = $1 AND choice = 'pin') END)
		 ON CONFLICT (user_email, report_id, measure)
		 DO UPDATE SET choice = EXCLUDED.choice, position = EXCLUDED.position,
		   chosen_on = now()`,
		[owner, reportId, measure, choice],
	);
	forgetPlan(owner);
}

// Puts the reader's pins in the order given. Pins not named keep their place
// after the named ones, so a list sent from a page that had not yet seen a
// pin made elsewhere does not lose it.
export async function orderPins(
	email: string,
	order: { reportId: string; measure: string }[],
): Promise<void> {
	const owner = email.toLowerCase();
	await transaction(async (client) => {
		await client.query(
			`UPDATE briefing_choices SET position = position + $2
			 WHERE user_email = $1 AND choice = 'pin'`,
			[owner, order.length + 1],
		);
		for (const [i, pin] of order.entries()) {
			await client.query(
				`UPDATE briefing_choices SET position = $4
				 WHERE user_email = $1 AND report_id = $2::uuid AND measure = $3
				   AND choice = 'pin'`,
				[owner, pin.reportId, pin.measure, i + 1],
			);
		}
	});
	forgetPlan(owner);
}
