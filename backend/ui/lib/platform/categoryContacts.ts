import { displayNameFromEmail } from "../auth/names";

// Who to ask about a category.
//
// Whoever holds a category's own editor role builds and maintains its reports,
// which makes them the people a reader goes to when a figure looks wrong or a
// report is missing something. Shown on the category and on each report in
// it, so the answer is where the question comes up rather than in an
// administration screen a reader cannot open.
//
// A group is listed by name. Its members are not expanded, because the
// directory that knows them is not this application's to read, and because a
// group is often how a team wants to be asked anyway.

export interface CategoryContact {
	kind: "person" | "group";
	// The address for a person, the group's name for a group.
	id: string;
	name: string;
}

export function toContacts(
	rows: { subject_type: "user" | "group"; subject_id: string }[],
): CategoryContact[] {
	const seen = new Set<string>();
	const contacts: CategoryContact[] = [];
	for (const row of rows) {
		const id =
			row.subject_type === "user"
				? row.subject_id.trim().toLowerCase()
				: row.subject_id.trim();
		const key = `${row.subject_type}:${id}`;
		if (!id || seen.has(key)) continue;
		seen.add(key);
		contacts.push(
			row.subject_type === "user"
				? { kind: "person", id, name: displayNameFromEmail(id) }
				: { kind: "group", id, name: id },
		);
	}
	// People first, since a person is who somebody with a question can write
	// to, then groups. Alphabetical within each so the order is stable.
	return contacts.sort(
		(a, b) =>
			(a.kind === "person" ? 0 : 1) - (b.kind === "person" ? 0 : 1) ||
			a.name.localeCompare(b.name),
	);
}
