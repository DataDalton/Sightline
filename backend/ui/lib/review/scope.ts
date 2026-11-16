// Which conversations a review grant reaches.
//
// One conversation by id, chosen people's, or everyone's, the last two
// optionally within a date range. A grant for one person, from before people
// could be chosen together, reads the same as people with one entry. A conversation belongs to a person when they own it, or,
// for a group conversation, when they are one of its members.
//
// Kept free of database and network imports so it can be tested on its own.

export const reviewKinds = ["groupChats", "assistant"] as const;
export type ReviewKind = (typeof reviewKinds)[number];

export type ReviewScope =
	| { kind: "conversation"; id: string }
	| { kind: "person"; email: string; from?: string; to?: string }
	| { kind: "people"; emails: string[]; from?: string; to?: string }
	| { kind: "everyone"; from?: string; to?: string };

function within(createdOn: string, from?: string, to?: string): boolean {
	const day = createdOn.slice(0, 10);
	return (!from || day >= from) && (!to || day <= to);
}

export function scopeAllows(
	scope: ReviewScope,
	conversation: { id: string; owners: string[]; createdOn: string },
): boolean {
	if (scope.kind === "conversation") return scope.id === conversation.id;
	const inRange = within(conversation.createdOn, scope.from, scope.to);
	if (scope.kind === "everyone") return inRange;
	const chosen = new Set(scopeEmails(scope));
	return (
		inRange &&
		conversation.owners.some((owner) => chosen.has(owner.toLowerCase()))
	);
}

// The people a scope names, in lower case. Empty for one conversation or
// everyone.
export function scopeEmails(scope: ReviewScope): string[] {
	if (scope.kind === "person") return [scope.email.toLowerCase()];
	if (scope.kind === "people")
		return scope.emails.map((e) => e.toLowerCase());
	return [];
}
