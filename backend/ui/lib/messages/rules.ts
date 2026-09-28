import type { CategoryContact } from "../platform/categoryContacts";

// The decisions a conversation turns on, kept apart from storage so they can
// be tested on their own.

export interface Member {
	type: "user" | "group";
	id: string;
}

export const limits = {
	subject: 200,
	body: 4000,
	// New conversations one person may start in an hour. Replies are not
	// counted, since answering is what the feature is for.
	startsPerHour: 20,
};

// Whether someone is in a conversation. Named directly, or through a group
// they belong to now. Membership is read when they look rather than when the
// message was sent, so somebody who joins the team that maintains a category
// sees what was asked of it, and somebody who leaves stops seeing it.
export function canSee(
	members: Member[],
	email: string,
	groups: string[],
): boolean {
	const address = email.toLowerCase();
	return members.some((m) =>
		m.type === "user" ? m.id === address : groups.includes(m.id),
	);
}

// Who a new conversation goes to.
//
// Only the people who maintain the category can be written to this way, so
// the feature cannot be pointed at anybody in the company. A request naming
// some of them is narrowed to those. One naming none of them, or nobody in
// particular, goes to all of them.
export function pickRecipients(
	contacts: CategoryContact[],
	requested: unknown,
): Member[] {
	const all: Member[] = contacts.map((c) => ({
		type: c.kind === "person" ? "user" : "group",
		id: c.id,
	}));
	if (!Array.isArray(requested)) return all;

	const wanted = new Set(
		requested
			.filter(
				(r): r is { type: unknown; id: unknown } =>
					typeof r === "object" && r !== null,
			)
			.map((r) =>
				r.type === "user" && typeof r.id === "string"
					? `user:${r.id.trim().toLowerCase()}`
					: r.type === "group" && typeof r.id === "string"
						? `group:${r.id.trim()}`
						: "",
			),
	);
	const chosen = all.filter((m) => wanted.has(`${m.type}:${m.id}`));
	return chosen.length > 0 ? chosen : all;
}

export function cleanText(raw: unknown, max: number): string | null {
	if (typeof raw !== "string") return null;
	const text = raw.trim();
	if (!text) return null;
	return text.slice(0, max);
}

// Everyone told about a new message. The people named, plus every member of
// each group named who has used the application, less whoever wrote it.
export function peopleToTell(
	members: Member[],
	knownGroupMembers: Record<string, string[]>,
	author: string,
): string[] {
	const out = new Set<string>();
	for (const m of members) {
		if (m.type === "user") out.add(m.id.toLowerCase());
		else {
			for (const email of knownGroupMembers[m.id] ?? []) {
				out.add(email.toLowerCase());
			}
		}
	}
	out.delete(author.toLowerCase());
	return [...out].sort();
}
