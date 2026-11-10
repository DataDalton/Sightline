import { test } from "node:test";
import assert from "node:assert/strict";
import {
	aboutPage,
	automaticEntries,
	builtinTypes,
	cleanInput,
	currentWindow,
	deprecationReminderDue,
	followMatches,
	isShowing,
	isUnderway,
	markerCategory,
	quietSources,
	reaches,
	sourcesOf,
	UpdateInputError,
	parseAuthors,
	posterName,
	resolveAuthors,
	timelineDate,
	type AboutItem,
} from "./model";

const typeOf = (id: string) => builtinTypes.find((t) => t.typeId === id);

test("a title is the only thing every type needs", () => {
	assert.throws(
		() => cleanInput({}, typeOf("announcement")),
		UpdateInputError,
	);
	const input = cleanInput({ title: " Hello " }, typeOf("announcement"));
	assert.equal(input.title, "Hello");
	assert.equal(input.status, "published");
	assert.equal(input.audience.kind, "readers");
});

test("a type's requirements and defaults apply", () => {
	assert.throws(
		() => cleanInput({ title: "Down" }, typeOf("maintenance")),
		/a start/,
	);
	const input = cleanInput(
		{
			title: "Down",
			startsOn: "2026-01-01T00:00:00Z",
			endsOn: "2026-01-01T02:00:00Z",
		},
		typeOf("maintenance"),
	);
	assert.equal(input.delivery.banner, true);
	assert.equal(input.impact, "notable");
});

test("an unknown type and a bad date are refused", () => {
	assert.throws(
		() => cleanInput({ title: "x" }, undefined),
		UpdateInputError,
	);
	assert.throws(
		() =>
			cleanInput(
				{ title: "x", effectiveOn: "soon" },
				typeOf("dataChange"),
			),
		/not a date/,
	);
});

test("it cannot end before it starts", () => {
	assert.throws(
		() =>
			cleanInput(
				{
					title: "x",
					startsOn: "2026-01-02T00:00:00Z",
					endsOn: "2026-01-01T00:00:00Z",
				},
				typeOf("maintenance"),
			),
		/end before/,
	);
});

test("only safe links are kept", () => {
	const input = cleanInput(
		{
			title: "x",
			links: [
				{ url: "javascript:alert(1)", label: "bad" },
				{ url: "https://a.example/b" },
				{ url: "/r/sales", label: "Sales" },
			],
		},
		typeOf("announcement"),
	);
	assert.deepEqual(
		input.links.map((l) => l.url),
		["https://a.example/b", "/r/sales"],
	);
});

test("an incident starts at investigating, and other types have no state", () => {
	assert.equal(
		cleanInput({ title: "x" }, typeOf("incident")).incidentState,
		"investigating",
	);
	assert.equal(
		cleanInput({ title: "x" }, typeOf("announcement")).incidentState,
		null,
	);
});

test("a field counts as touching its source", () => {
	const about: AboutItem[] = [
		{ kind: "source", id: "a" },
		{ kind: "field", id: "Revenue", sourceKey: "b" },
		{ kind: "report", id: "r" },
	];
	assert.deepEqual(sourcesOf(about), ["a", "b"]);
});

test("what shows respects status, schedule and expiry", () => {
	const now = new Date("2026-06-01").getTime();
	const on = {
		status: "published" as const,
		showFrom: null,
		expiresOn: null,
	};
	assert.equal(isShowing(on, now), true);
	assert.equal(isShowing({ ...on, status: "draft" }, now), false);
	assert.equal(isShowing({ ...on, status: "retracted" }, now), false);
	assert.equal(isShowing({ ...on, showFrom: "2026-07-01" }, now), false);
	assert.equal(isShowing({ ...on, expiresOn: "2026-05-01" }, now), false);
});

test("a repeating window moves forward to the current one", () => {
	const weekly = {
		startsOn: "2026-01-04T02:00:00Z",
		endsOn: "2026-01-04T04:00:00Z",
		repeat: "weekly" as const,
	};
	const during = new Date("2026-01-11T03:00:00Z").getTime();
	assert.equal(isUnderway(weekly, during), true);
	const between = new Date("2026-01-12T03:00:00Z").getTime();
	assert.equal(isUnderway(weekly, between), false);
	assert.equal(
		new Date(currentWindow(weekly, between)?.start ?? 0).toISOString(),
		"2026-01-18T02:00:00.000Z",
	);
});

test("a one-off window that has passed is over", () => {
	const once = {
		startsOn: "2026-01-04T02:00:00Z",
		endsOn: "2026-01-04T04:00:00Z",
		repeat: "none" as const,
	};
	assert.equal(currentWindow(once, new Date("2026-02-01").getTime()), null);
});

test("only maintenance underway goes quiet", () => {
	const base = {
		status: "published" as const,
		about: [{ kind: "source", id: "orders" }] as AboutItem[],
		startsOn: "2026-01-04T02:00:00Z",
		endsOn: "2026-01-04T04:00:00Z",
		repeat: "none" as const,
	};
	const during = new Date("2026-01-04T03:00:00Z").getTime();
	assert.deepEqual(
		[...quietSources([{ ...base, type: "maintenance" }], during)],
		["orders"],
	);
	assert.equal(quietSources([{ ...base, type: "incident" }], during).size, 0);
	assert.equal(
		quietSources(
			[{ ...base, type: "maintenance", status: "draft" as never }],
			during,
		).size,
		0,
	);
	assert.equal(
		quietSources(
			[{ ...base, type: "maintenance" }],
			new Date("2026-01-05").getTime(),
		).size,
		0,
	);
});

const reader = {
	readableSources: new Set(["orders"]),
	groups: ["Finance Team"],
	categories: new Set(["sales"]),
	reports: new Set(["r1"]),
};

test("by default it reaches those who can read the source", () => {
	const about = (id: string): AboutItem[] => [{ kind: "source", id }];
	const readers = { kind: "readers" as const };
	assert.equal(
		reaches({ audience: readers, about: about("orders") }, reader),
		true,
	);
	assert.equal(
		reaches({ audience: readers, about: about("secret") }, reader),
		false,
	);
	assert.equal(reaches({ audience: readers, about: [] }, reader), true);
});

test("other audiences", () => {
	const about: AboutItem[] = [];
	const to = (kind: never, ids: string[]) =>
		reaches({ audience: { kind, ids }, about }, reader);
	assert.equal(to("everyone" as never, []), true);
	assert.equal(to("groups" as never, ["finance team"]), true);
	assert.equal(to("groups" as never, ["other"]), false);
	assert.equal(to("category" as never, ["sales"]), true);
	assert.equal(to("report" as never, ["r2"]), false);
	assert.equal(to("source" as never, ["orders"]), true);
});

test("an update lands on the pages it is about", () => {
	const page = {
		sourceKeys: ["orders"],
		reportId: "r1",
		categoryId: "sales",
		pageId: "p1",
	};
	const on = (about: AboutItem[]) => aboutPage({ about }, page);
	assert.equal(on([{ kind: "source", id: "orders" }]), true);
	assert.equal(on([{ kind: "field", id: "x", sourceKey: "orders" }]), true);
	assert.equal(on([{ kind: "report", id: "r1" }]), true);
	assert.equal(on([{ kind: "category", id: "sales" }]), true);
	assert.equal(on([{ kind: "page", id: "p2" }]), false);
	assert.equal(on([{ kind: "source", id: "other" }]), false);
});

test("what someone follows", () => {
	const update = {
		type: "dataChange",
		about: [
			{ kind: "field", id: "Revenue", sourceKey: "orders" },
		] as AboutItem[],
	};
	const follow = (kind: never, value = "") =>
		followMatches({ kind, value, mode: "instant" }, update);
	assert.equal(follow("all" as never), true);
	assert.equal(follow("type" as never, "dataChange"), true);
	assert.equal(follow("type" as never, "incident"), false);
	assert.equal(follow("source" as never, "orders"), true);
	assert.equal(follow("field" as never, "Revenue"), true);
	assert.equal(follow("field" as never, "Cost"), false);
});

test("a chart marks the first category on or after the date", () => {
	const months = ["2026-01-01", "2026-02-01", "2026-03-01"];
	assert.equal(markerCategory(months, "2026-01-15"), "2026-02-01");
	assert.equal(markerCategory(months, "2026-01-01"), "2026-01-01");
	assert.equal(markerCategory(months, "2026-04-15"), null);
	assert.equal(markerCategory(["West", "East"], "2026-01-15"), null);
	assert.equal(
		markerCategory(["2026-03-01", "2026-01-01"], "2026-01-15"),
		null,
	);
});

const every = {
	fieldAdded: true,
	fieldRemoved: true,
	fieldRenamed: true,
	definitionChanged: true,
};

test("a sync's findings become entries, a rename once", () => {
	const entries = automaticEntries(
		{
			sourceKey: "orders",
			added: ["New", "Next name"],
			newlyMissing: ["Old", "Prior name"],
			renames: [{ from: "Prior name", to: "Next name" }],
			redefined: [{ name: "Revenue", before: "SUM(a)", after: "SUM(b)" }],
		},
		"Orders",
		every,
		"2026-01-01",
	);
	assert.deepEqual(entries.map((e) => e.kind).sort(), [
		"definitionChanged",
		"fieldAdded",
		"fieldRemoved",
		"fieldRenamed",
	]);
	const redefined = entries.find((e) => e.kind === "definitionChanged");
	assert.equal(redefined?.before, "SUM(a)");
	assert.equal(
		entries.find((e) => e.kind === "fieldRemoved")?.impact,
		"breaking",
	);
});

test("each kind of automatic entry can be switched off", () => {
	const entries = automaticEntries(
		{
			sourceKey: "orders",
			added: ["New"],
			newlyMissing: [],
			renames: [],
			redefined: [],
		},
		"Orders",
		{ ...every, fieldAdded: false },
		"2026-01-01",
	);
	assert.deepEqual(entries, []);
});

test("the same change on the same day has the same reference", () => {
	const found = {
		sourceKey: "orders",
		added: ["New"],
		newlyMissing: [],
		renames: [],
		redefined: [],
	};
	const one = automaticEntries(found, "Orders", every, "2026-01-01");
	const two = automaticEntries(found, "Orders", every, "2026-01-01");
	assert.equal(one[0].reference, two[0].reference);
});

test("a deprecation reminds at each step, once", () => {
	const now = new Date("2026-06-01T00:00:00Z").getTime();
	const posted = "2026-01-01T00:00:00Z";
	const in20 = "2026-06-21T00:00:00Z";
	const in5 = "2026-06-06T00:00:00Z";
	assert.equal(deprecationReminderDue(in20, posted, null, now), 30);
	assert.equal(deprecationReminderDue(in20, posted, 30, now), null);
	assert.equal(deprecationReminderDue(in5, posted, 30, now), 7);
	assert.equal(deprecationReminderDue(in5, posted, 7, now), null);
});

test("a held up check sends only the nearest deprecation reminder", () => {
	const now = new Date("2026-06-01T00:00:00Z").getTime();
	const posted = "2026-01-01T00:00:00Z";
	assert.equal(
		deprecationReminderDue("2026-06-01T12:00:00Z", posted, null, now),
		1,
	);
});

test("nothing is owed when the date has passed, is far off or was just announced", () => {
	const now = new Date("2026-06-01T00:00:00Z").getTime();
	const posted = "2026-01-01T00:00:00Z";
	assert.equal(deprecationReminderDue(null, posted, null, now), null);
	assert.equal(
		deprecationReminderDue("2026-05-01T00:00:00Z", posted, null, now),
		null,
	);
	assert.equal(
		deprecationReminderDue("2026-12-01T00:00:00Z", posted, null, now),
		null,
	);
	assert.equal(
		deprecationReminderDue(
			"2026-06-06T00:00:00Z",
			"2026-05-31T00:00:00Z",
			null,
			now,
		),
		null,
	);
});

test("authors come from emails, GitHub names and plain names, once each", () => {
	assert.deepEqual(
		parseAuthors([
			"jane.doe@example.com",
			"github:samlee",
			"Pat Kim",
			"JANE.DOE@example.com",
			{ github: "SAMLEE" },
			"",
		]),
		[
			{ name: "Jane Doe", email: "jane.doe@example.com" },
			{ name: "samlee", github: "samlee" },
			{ name: "Pat Kim" },
		],
	);
	assert.deepEqual(parseAuthors("not a list"), []);
});

test("a GitHub name matched later takes the person's name", () => {
	const aliases = [
		{
			alias: "samlee",
			kind: "github" as const,
			email: "sam.lee@example.com",
			displayName: null,
		},
	];
	const [matched, unmatched] = resolveAuthors(
		[
			{ name: "samlee", github: "SamLee" },
			{ name: "other", github: "other" },
		],
		aliases,
	);
	assert.equal(matched.name, "Sam Lee");
	assert.equal(matched.email, "sam.lee@example.com");
	assert.equal(matched.matched, true);
	assert.equal(unmatched.matched, false);
});

test("an automation shows the name it was given", () => {
	const aliases = [
		{
			alias: "509c-id",
			kind: "principal" as const,
			email: null,
			displayName: "Changelog",
		},
	];
	assert.equal(posterName("509c-id", aliases), "Changelog");
	assert.equal(posterName("jane.doe@example.com", aliases), "Jane Doe");
});

test("not notifying takes away everything that interrupts", () => {
	const input = cleanInput(
		{ title: "Quiet", notify: false },
		typeOf("incident"),
	);
	assert.equal(input.notify, false);
	assert.equal(input.delivery.inbox, false);
	assert.equal(input.delivery.push, false);
	assert.equal(input.delivery.banner, false);
	assert.equal(input.delivery.page, true);
});

test("an old release can sit back at its own date", () => {
	const old = "2026-03-04T12:00:00.000Z";
	const back = cleanInput(
		{ title: "Old", effectiveOn: old, placement: "history" },
		typeOf("releaseNotes"),
	);
	assert.equal(back.placement, "history");
	assert.equal(back.delivery.home, false);
	assert.equal(
		timelineDate({ ...back, postedOn: "2026-11-10T12:00:00.000Z" }),
		old,
	);
	// A future date cannot be history, so it stays at the top.
	const ahead = cleanInput(
		{
			title: "Soon",
			effectiveOn: "2999-01-01T00:00:00.000Z",
			placement: "history",
		},
		typeOf("releaseNotes"),
	);
	assert.equal(ahead.placement, "top");
});
