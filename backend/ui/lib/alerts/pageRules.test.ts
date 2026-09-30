import { test } from "node:test";
import assert from "node:assert/strict";
import type { Condition } from "../explore/conditions";
import {
	conditionsEquivalent,
	groupSubscribers,
	isMuted,
	isMuteChoice,
	mutedForever,
	muteUntil,
	ownerPassPlan,
	ownerScopeKey,
	sameRule,
	scopeKeyFor,
	scopeMode,
	type FollowedAlert,
	type Restriction,
	type RuleShape,
	type Subscriber,
} from "./pageRules";

const now = new Date("2026-03-10T12:00:00Z");

function condition(
	field: string,
	value: string,
	extra: Partial<Condition> = {},
): Condition {
	return { field, op: "eq", value, negate: false, join: "and", ...extra };
}

// --- Muting ----------------------------------------------------------------

test("a day's mute ends a day later and a week's a week later", () => {
	assert.equal(muteUntil("day", now), "2026-03-11T12:00:00.000Z");
	assert.equal(muteUntil("week", now), "2026-03-17T12:00:00.000Z");
	assert.equal(muteUntil("off", now), null);
	assert.equal(muteUntil("forever", now), mutedForever);
});

test("a mute holds until its time and not after", () => {
	const until = muteUntil("day", now);
	assert.equal(isMuted(until, now), true);
	assert.equal(isMuted(until, new Date("2026-03-11T11:59:59Z")), true);
	assert.equal(isMuted(until, new Date("2026-03-11T12:00:01Z")), false);
});

test("no mute, an unreadable one and an endless one", () => {
	assert.equal(isMuted(null, now), false);
	assert.equal(isMuted(undefined, now), false);
	assert.equal(isMuted("not a date", now), false);
	assert.equal(isMuted(mutedForever, new Date("2099-01-01T00:00:00Z")), true);
});

test("only the known mute choices are accepted", () => {
	assert.equal(isMuteChoice("week"), true);
	assert.equal(isMuteChoice("month"), false);
	assert.equal(isMuteChoice(null), false);
});

// --- Duplicates ------------------------------------------------------------

const base: RuleShape = {
	sourceKey: "sales",
	measure: "Revenue",
	groupBy: "Region",
	condition: "above",
	conditions: [condition("Channel", "Online"), condition("Year", "2026")],
};

test("conditions joined by and match in any order", () => {
	assert.equal(
		conditionsEquivalent(base.conditions, [...base.conditions].reverse()),
		true,
	);
});

test("the order of a list of values does not matter", () => {
	const a = [
		{
			...condition("Region", ""),
			op: "eq" as const,
			values: ["West", "East"],
		},
	];
	const b = [
		{
			...condition("Region", ""),
			op: "eq" as const,
			values: ["East", "West"],
		},
	];
	assert.equal(conditionsEquivalent(a, b), true);
});

test("conditions with an or are compared in order", () => {
	const a = [
		condition("Channel", "Online"),
		condition("Channel", "Store", { join: "or" }),
	];
	const b = [
		condition("Channel", "Store"),
		condition("Channel", "Online", { join: "or" }),
	];
	const c = [
		condition("Channel", "Store", { join: "or" }),
		condition("Channel", "Online"),
	];
	assert.equal(conditionsEquivalent(a, a), true);
	assert.equal(conditionsEquivalent(a, b), false);
	assert.equal(
		conditionsEquivalent(b, [{ ...b[0], join: "or" }, b[1]]),
		true,
		"the join on the first condition is ignored",
	);
	assert.equal(conditionsEquivalent(a, c), false);
});

test("a negated condition is a different condition", () => {
	assert.equal(
		conditionsEquivalent(
			[condition("Channel", "Online")],
			[condition("Channel", "Online", { negate: true })],
		),
		false,
	);
});

test("the same rule matches whatever its threshold", () => {
	assert.equal(sameRule(base, { ...base }), true);
	assert.equal(sameRule(base, { ...base, groupBy: "Region" }), true);
});

test("a different measure, split, condition or dataset is another rule", () => {
	assert.equal(sameRule(base, { ...base, measure: "Units" }), false);
	assert.equal(sameRule(base, { ...base, groupBy: null }), false);
	assert.equal(sameRule(base, { ...base, condition: "below" }), false);
	assert.equal(sameRule(base, { ...base, sourceKey: "orders" }), false);
	assert.equal(
		sameRule(base, {
			...base,
			conditions: [condition("Channel", "Online")],
		}),
		false,
	);
});

test("no split written as empty text is the same as none", () => {
	const total = { ...base, groupBy: null };
	assert.equal(
		sameRule(total, { ...total, groupBy: "" as unknown as null }),
		true,
	);
});

// --- Scopes ----------------------------------------------------------------

function subscriber(
	email: string,
	extra: Partial<Subscriber> = {},
): Subscriber {
	return { email, mutedUntil: null, confirmed: true, ...extra };
}

test("the scope mode follows what the dataset allows", () => {
	assert.equal(scopeMode(true, false), "everyone");
	assert.equal(scopeMode(true, true), "everyone");
	assert.equal(scopeMode(false, true), "perAccess");
	assert.equal(scopeMode(false, false), "signedIn");
});

test("a dataset without row filters is read once for everybody", () => {
	const groups = groupSubscribers(
		[subscriber("a@example.com"), subscriber("B@example.com")],
		"everyone",
		() => {
			throw new Error("no restriction is looked up");
		},
		now,
	);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].key, "app");
	assert.equal(groups[0].restriction, null);
	assert.deepEqual(groups[0].recipients, ["a@example.com", "b@example.com"]);
});

test("a row-filtered dataset is read once per distinct recording", () => {
	const west: Restriction = { fields: ["Region"], tuples: [["West"]] };
	const east: Restriction = { fields: ["Region"], tuples: [["East"]] };
	const byEmail: Record<string, Restriction | null> = {
		"a@example.com": west,
		"b@example.com": { fields: ["Region"], tuples: [["West"]] },
		"c@example.com": east,
		"d@example.com": null,
	};
	const groups = groupSubscribers(
		Object.keys(byEmail).map((e) => subscriber(e)),
		"perAccess",
		(email) => byEmail[email],
		now,
	);
	assert.equal(groups.length, 2);
	const westGroup = groups.find((g) => g.restriction === west);
	assert.deepEqual(westGroup?.members, ["a@example.com", "b@example.com"]);
	const eastGroup = groups.find((g) => g.restriction === east);
	assert.deepEqual(eastGroup?.members, ["c@example.com"]);
	assert.ok(
		!groups.some((g) => g.members.includes("d@example.com")),
		"somebody without a recording is read for nowhere",
	);
	assert.notEqual(westGroup?.key, eastGroup?.key);
	assert.ok(westGroup?.key.startsWith("app:restricted:"));
});

test("the order a recording lists its rows in does not split a scope", () => {
	const a = scopeKeyFor({ fields: ["Region"], tuples: [["West"], ["East"]] });
	const b = scopeKeyFor({ fields: ["Region"], tuples: [["East"], ["West"]] });
	assert.equal(a, b);
	assert.notEqual(a, scopeKeyFor({ fields: ["Region"], tuples: [["East"]] }));
	assert.equal(scopeKeyFor(null), "app");
});

test("an unconfirmed subscriber is left out and a muted one is not told", () => {
	const groups = groupSubscribers(
		[
			subscriber("a@example.com"),
			subscriber("b@example.com", { confirmed: false }),
			subscriber("c@example.com", { mutedUntil: muteUntil("day", now) }),
			subscriber("d@example.com", { mutedUntil: "2026-03-01T00:00:00Z" }),
		],
		"everyone",
		() => null,
		now,
	);
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0].members, [
		"a@example.com",
		"c@example.com",
		"d@example.com",
	]);
	assert.deepEqual(groups[0].recipients, ["a@example.com", "d@example.com"]);
});

test("nothing is read for a dataset that cannot be read unattended", () => {
	assert.deepEqual(
		groupSubscribers(
			[subscriber("a@example.com")],
			"signedIn",
			() => null,
			now,
		),
		[],
	);
});

test("one person subscribed twice is counted once", () => {
	const groups = groupSubscribers(
		[subscriber("a@example.com"), subscriber("A@example.com")],
		"everyone",
		() => null,
		now,
	);
	assert.deepEqual(groups[0].members, ["a@example.com"]);
});

// --- The signed-in pass ----------------------------------------------------

function followed(
	alertId: string,
	extra: Partial<FollowedAlert> = {},
): FollowedAlert {
	return {
		alertId,
		mode: "signedIn",
		mutedUntil: null,
		confirmed: true,
		nextCheckOn: null,
		...extra,
	};
}

test("a subscriber's own scope is keyed by their address without case", () => {
	assert.equal(ownerScopeKey("A@Example.com"), "owner:a@example.com");
	assert.notEqual(ownerScopeKey("a@example.com"), scopeKeyFor(null));
});

test("an alert never checked for this subscriber is due at once", () => {
	assert.deepEqual(ownerPassPlan([followed("a")], now), [
		{ alertId: "a", notify: true },
	]);
});

test("each subscriber's scope waits for its own next check", () => {
	const plan = ownerPassPlan(
		[
			followed("due", { nextCheckOn: "2026-03-10T11:00:00Z" }),
			followed("exactly", { nextCheckOn: "2026-03-10T12:00:00Z" }),
			followed("later", { nextCheckOn: "2026-03-10T13:00:00Z" }),
		],
		now,
	);
	assert.deepEqual(
		plan.map((p) => p.alertId),
		["due", "exactly"],
	);
});

test("only datasets the timer cannot read are checked in the pass", () => {
	const plan = ownerPassPlan(
		[
			followed("everyone", { mode: "everyone" }),
			followed("recorded", { mode: "perAccess" }),
			followed("signed", { mode: "signedIn" }),
		],
		now,
	);
	assert.deepEqual(
		plan.map((p) => p.alertId),
		["signed"],
	);
});

test("an unconfirmed subscriber is not read for", () => {
	assert.deepEqual(
		ownerPassPlan([followed("a", { confirmed: false })], now),
		[],
	);
});

test("a muted subscriber is read for but not told, unless muted for good", () => {
	const plan = ownerPassPlan(
		[
			followed("day", { mutedUntil: muteUntil("day", now) }),
			followed("over", { mutedUntil: "2026-03-01T00:00:00Z" }),
			followed("forever", { mutedUntil: mutedForever }),
		],
		now,
	);
	assert.deepEqual(plan, [
		{ alertId: "day", notify: false },
		{ alertId: "over", notify: true },
	]);
});

test("an alert listed twice is checked once", () => {
	assert.equal(ownerPassPlan([followed("a"), followed("a")], now).length, 1);
});
