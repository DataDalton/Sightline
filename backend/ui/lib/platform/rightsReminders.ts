import { sql } from "../data/lakebase";
import { notify } from "../notify/store";

// Tells somebody a right they hold is about to end, and whoever gave it to them.
//
// Marked as it is read, so replicas ticking together send one reminder between them
// and a restart never sends a second. Only named people can be told, because the app
// has no way to list a group's members.

const reminderWindowDays = 7;

interface EndingRow {
	subject_type: string;
	subject_id: string;
	granted_by: string | null;
	expires_on: string;
	what: string;
}

export async function remindOfEndingRights(): Promise<void> {
	const [assignments, grants] = await Promise.all([
		sql<EndingRow>(
			`UPDATE role_assignments ra
			 SET expiry_reminded = TRUE
			 FROM roles r
			 WHERE r.role_id = ra.role_id
			   AND ra.is_active = TRUE
			   AND ra.expiry_reminded = FALSE
			   AND ra.expires_on > now()
			   AND ra.expires_on <= now() + make_interval(days => $1)
			 RETURNING ra.subject_type, ra.subject_id, ra.granted_by,
			           ra.expires_on::text AS expires_on, r.name AS what`,
			[reminderWindowDays],
		),
		sql<EndingRow>(
			`UPDATE permission_grants
			 SET expiry_reminded = TRUE
			 WHERE is_active = TRUE
			   AND expiry_reminded = FALSE
			   AND effect = 'allow'
			   AND expires_on > now()
			   AND expires_on <= now() + make_interval(days => $1)
			 RETURNING subject_type, subject_id, granted_by,
			           expires_on::text AS expires_on, capability AS what`,
			[reminderWindowDays],
		),
	]);

	for (const row of [...assignments, ...grants]) {
		const on = new Date(row.expires_on).toLocaleDateString();
		const people = new Set<string>();
		if (row.subject_type === "user")
			people.add(row.subject_id.toLowerCase());
		if (row.granted_by) people.add(row.granted_by.toLowerCase());
		for (const person of people) {
			await notify(person, {
				kind: "system",
				title: `${row.what} for ${row.subject_id} ends on ${on}`,
				body: "Ask an administrator or Maintainer if it should carry on.",
				link: null,
			}).catch((error) => {
				console.warn(
					"An ending right reminder was not delivered:",
					error,
				);
			});
		}
	}
}
