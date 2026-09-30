import type { Condition } from "../explore/conditions";
import type { AlertDefinition } from "./rule";
import { isMuted, mutedForever } from "./mute";
import { queryScope, stableJson } from "./shared";

export * from "./mute";

// The pure parts of page alerts. A page alert is one an editor puts on a
// report page, which readers subscribe to rather than write themselves.
//
// One page alert is judged once per access scope rather than once per person.
// Everybody who sees the same rows of its dataset shares one reading, one state
// and one decision, and each of them is told only what their own scope saw.

// --- Duplicates ------------------------------------------------------------

// One condition without the parts that do not change what it keeps, which are
// the order of a list of values and a join on the first condition.
function normalCondition(c: Condition, first: boolean) {
	return {
		field: c.field,
		op: c.op,
		value: c.value ?? null,
		values: c.values ? [...c.values].sort() : null,
		negate: c.negate === true,
		join: first ? "and" : c.join,
		open: c.open ?? 0,
		close: c.close ?? 0,
	};
}

// Whether two lists of conditions keep the same rows.
//
// Conditions all joined by "and" with no brackets keep the same rows in any
// order, so they are compared as a set. Anything with an "or" or a bracket
// depends on its order, so those are compared in sequence.
export function conditionsEquivalent(a: Condition[], b: Condition[]): boolean {
	if (a.length !== b.length) return false;
	const plain = (list: Condition[]) =>
		list.every(
			(c, i) =>
				(i === 0 || c.join === "and") &&
				!(c.open ?? 0) &&
				!(c.close ?? 0),
		);
	const normal = (list: Condition[]) =>
		list.map((c, i) => stableJson(normalCondition(c, i === 0)));
	const left = normal(a);
	const right = normal(b);
	if (plain(a) && plain(b)) {
		left.sort();
		right.sort();
	}
	return left.every((item, i) => item === right[i]);
}

export type RuleShape = Pick<
	AlertDefinition,
	"sourceKey" | "measure" | "groupBy" | "condition" | "conditions"
>;

// Whether two alerts watch the same thing the same way, meaning the same measure of
// the same dataset, split the same way, narrowed to the same rows, under the
// same kind of condition. The threshold and the schedule may differ, since a
// reader offered the page's alert is choosing to take its line instead.
export function sameRule(a: RuleShape, b: RuleShape): boolean {
	return (
		a.sourceKey === b.sourceKey &&
		a.measure === b.measure &&
		(a.groupBy || null) === (b.groupBy || null) &&
		a.condition === b.condition &&
		conditionsEquivalent(a.conditions ?? [], b.conditions ?? [])
	);
}

// --- Scopes ----------------------------------------------------------------

// How a page alert's dataset can be read while its subscribers are away.
//
//   everyone    no row filter, so one reading as the app serves them all
//   perAccess   a row filter mapped onto fields, so one reading per distinct
//               recording of what subscribers can see
//   signedIn    neither, so each subscriber is read for under their own
//               token while they are using the app
export type ScopeMode = "everyone" | "perAccess" | "signedIn";

export function scopeMode(
	unattended: boolean,
	restrictable: boolean,
): ScopeMode {
	if (unattended) return "everyone";
	if (restrictable) return "perAccess";
	return "signedIn";
}

export interface Restriction {
	fields: string[];
	tuples: unknown[][];
}

// The key of the scope a restriction reads under. The tuples are sorted
// first, so two recordings of the same access taken in a different order land
// in the same scope and keep the same state.
export function scopeKeyFor(restriction: Restriction | null): string {
	if (!restriction) return queryScope({ app: true });
	const tuples = [...restriction.tuples]
		.map((t) => ({ key: stableJson(t), t }))
		.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
		.map((x) => x.t);
	return queryScope({ app: true }, { fields: restriction.fields, tuples });
}

export interface Subscriber {
	email: string;
	mutedUntil: string | null;
	// Seen able to read the dataset recently enough to be read for.
	confirmed: boolean;
}

export interface ScopeGroup<R> {
	key: string;
	// The restriction the reading is narrowed to, or null for none.
	restriction: R | null;
	// Everybody the reading is for, muted or not. The state is kept for all of
	// them, so a subscriber coming back from a mute is not told about a
	// crossing that happened while they were away.
	members: string[];
	// Who is told about it.
	recipients: string[];
}

// Subscribers grouped by the scope their reading is taken in.
//
// Nobody unconfirmed is in any group, and on a row-filtered dataset nobody
// without a usable recording is either, so a reading is never taken for, or
// sent to, somebody it cannot be shown to be theirs.
export function groupSubscribers<R extends Restriction>(
	subscribers: Subscriber[],
	mode: ScopeMode,
	restrictionOf: (email: string) => R | null,
	now = new Date(),
): ScopeGroup<R>[] {
	if (mode === "signedIn") return [];
	const groups = new Map<string, ScopeGroup<R>>();
	const seen = new Set<string>();
	for (const subscriber of subscribers) {
		const email = subscriber.email.toLowerCase();
		if (!subscriber.confirmed || seen.has(email)) continue;
		seen.add(email);
		let restriction: R | null = null;
		if (mode === "perAccess") {
			restriction = restrictionOf(email);
			if (!restriction) continue;
		}
		const key = scopeKeyFor(restriction);
		const group = groups.get(key) ?? {
			key,
			restriction,
			members: [],
			recipients: [],
		};
		group.members.push(email);
		if (!isMuted(subscriber.mutedUntil, now)) group.recipients.push(email);
		groups.set(key, group);
	}
	return [...groups.values()];
}

// --- The signed-in pass ----------------------------------------------------

// The scope a subscriber's own reading is kept under, when it is taken with
// their token.
export function ownerScopeKey(email: string): string {
	return queryScope({ app: false, ownerEmail: email });
}

export interface FollowedAlert {
	alertId: string;
	mode: ScopeMode;
	mutedUntil: string | null;
	confirmed: boolean;
	// When the subscriber's own scope is next due, or null when it has never
	// been checked.
	nextCheckOn: string | null;
}

export interface OwnerCheck {
	alertId: string;
	// Whether the subscriber is told about what the check finds. A muted one
	// is still read for, so a crossing during the mute is not reported late.
	notify: boolean;
}

// Which followed alerts a pass under the subscriber's own token checks now.
//
// Only alerts on a dataset that cannot be read for them while they are away,
// since the timer already reads the others. Only while their access is
// confirmed, only once their own scope is due on the alert's schedule, and
// never while muted until they turn it back on, since nothing read then would
// be sent.
export function ownerPassPlan(
	alerts: FollowedAlert[],
	now = new Date(),
): OwnerCheck[] {
	const out: OwnerCheck[] = [];
	const seen = new Set<string>();
	for (const alert of alerts) {
		if (seen.has(alert.alertId)) continue;
		seen.add(alert.alertId);
		if (alert.mode !== "signedIn" || !alert.confirmed) continue;
		if (alert.mutedUntil === mutedForever) continue;
		if (alert.nextCheckOn !== null) {
			const due = Date.parse(alert.nextCheckOn);
			if (Number.isFinite(due) && due > now.getTime()) continue;
		}
		out.push({
			alertId: alert.alertId,
			notify: !isMuted(alert.mutedUntil, now),
		});
	}
	return out;
}
