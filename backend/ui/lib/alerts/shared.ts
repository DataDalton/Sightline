import { createHash } from "node:crypto";

// Sharing warehouse reads between the alerts and scheduled pages checked in
// one batch.
//
// Alerts on the same measure with the same conditions ask the warehouse the
// same question, as do two people who scheduled the same page. Within a batch
// each distinct question is asked once and every check that needs it gets the
// same rows.
//
// Two reads are only shared when they would return the same rows, which
// takes more than the same SQL. The identity it runs under decides what the
// warehouse filters away, so the scope is part of the key:
//
//   - As the app with no restriction, on a dataset that shows everybody the
//     same rows. One scope for everybody.
//   - As the app narrowed to a recorded restriction. Shared only between
//     checks narrowed to exactly the same restriction.
//   - Under an owner's own token. Shared only between that owner's checks,
//     since the warehouse filters by who is asking.

type Rows = Record<string, unknown>[];

export type SharedRunQuery = (
	statement: string,
	params: Record<string, unknown>,
) => Promise<Rows>;

export type RunIdentity = { app: true } | { app: false; ownerEmail: string };

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// The same value serialized the same way whatever order its keys were
// added in, so two parameter objects built in different orders match.
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries
			.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
			.join(",")}}`;
	}
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	return JSON.stringify(value ?? null);
}

// The scope a read runs under, as a string that only matches another read
// that would see the same rows.
export function queryScope(
	identity: RunIdentity,
	restriction?: unknown,
): string {
	const who = identity.app
		? "app"
		: `owner:${identity.ownerEmail.toLowerCase()}`;
	if (restriction === undefined || restriction === null) return who;
	return `${who}:restricted:${digest(stableJson(restriction))}`;
}

// The key two reads share on. The scope is a literal prefix rather than part
// of the hashed text, so no collision can carry rows across scopes.
export function sharedQueryKey(
	scope: string,
	statement: string,
	params: Record<string, unknown>,
): string {
	return `${scope}\u0000${digest(`${statement}\u0000${stableJson(params)}`)}`;
}

// Items grouped by the key each one reads under, in the order each key was
// first seen.
export function groupByQuery<T>(
	items: T[],
	keyOf: (item: T) => string,
): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = groups.get(key);
		if (group) group.push(item);
		else groups.set(key, [item]);
	}
	return groups;
}

// Reads for one batch. The first request for a key starts the read and
// every later one gets the same promise, so reads that overlap in time are
// still made once. A read that fails fails every check waiting on it, which
// is the same outcome each would have had asking alone.
export class QueryMemo {
	private readonly held = new Map<string, Promise<Rows>>();
	private started = 0;

	read(key: string, fetch: () => Promise<Rows>): Promise<Rows> {
		const found = this.held.get(key);
		if (found) return found;
		this.started++;
		const pending = fetch();
		this.held.set(key, pending);
		return pending;
	}

	// Seeds an answer already held, such as one from the result cache.
	seed(key: string, rows: Rows): void {
		if (!this.held.has(key)) this.held.set(key, Promise.resolve(rows));
	}

	has(key: string): boolean {
		return this.held.has(key);
	}

	// How many reads were started rather than shared.
	get reads(): number {
		return this.started;
	}

	// A run function whose reads are shared within one scope.
	runner(scope: string, run: SharedRunQuery): SharedRunQuery {
		return (statement, params) =>
			this.read(sharedQueryKey(scope, statement, params), () =>
				run(statement, params),
			);
	}
}
