import { test } from "node:test";
import assert from "node:assert/strict";
import type { Update } from "./model";
import {
	cursorOf,
	matchesTerm,
	timelinePage,
	type TimelinePage,
} from "./timelinePage";

function update(id: string, postedOn: string, extra: Partial<Update> = {}) {
	return {
		updateId: id,
		type: "dataChange",
		title: `Entry ${id}`,
		body: "",
		impact: "info",
		status: "published",
		about: [],
		before: null,
		after: null,
		links: [],
		tags: [],
		reference: null,
		postedOn,
		effectiveOn: null,
		periodFrom: null,
		periodTo: null,
		startsOn: null,
		endsOn: null,
		repeat: "none",
		incidentState: null,
		audience: { kind: "readers" },
		delivery: {
			home: true,
			page: true,
			push: false,
			inbox: true,
			popup: false,
			banner: false,
		},
		showFrom: null,
		expiresOn: null,
		requireAck: false,
		automatic: false,
		reason: null,
		whatToDo: null,
		createdBy: "someone@example.com",
		correctedOn: null,
		authors: [],
		placement: "top",
		notify: true,
		...extra,
	} as Update;
}

const day = (n: number) =>
	`2026-11-${String(n).padStart(2, "0")}T12:00:00.000Z`;

test("pages run newest first and the cursor picks up where the last page ended", () => {
	const all = [1, 2, 3, 4, 5].map((n) => update(`u${n}`, day(n)));
	const first = timelinePage(all, { limit: 2 });
	assert.deepEqual(
		first.items.map((u) => u.updateId),
		["u5", "u4"],
	);
	assert.equal(first.total, 5);
	const second = timelinePage(all, { limit: 2, after: first.next });
	assert.deepEqual(
		second.items.map((u) => u.updateId),
		["u3", "u2"],
	);
	const last = timelinePage(all, { limit: 2, after: second.next });
	assert.deepEqual(
		last.items.map((u) => u.updateId),
		["u1"],
	);
	assert.equal(last.next, null);
});

test("an entry posted between pages does not shift or repeat the next page", () => {
	const all = [1, 2, 3, 4].map((n) => update(`u${n}`, day(n)));
	const first = timelinePage(all, { limit: 2 });
	const later = [...all, update("u9", day(9))];
	assert.deepEqual(
		timelinePage(later, { limit: 2, after: first.next }).items.map(
			(u) => u.updateId,
		),
		["u2", "u1"],
	);
});

test("entries at the same moment keep one order across pages", () => {
	const all = ["a", "b", "c", "d"].map((id) => update(id, day(3)));
	const seen: string[] = [];
	let after: string | null = null;
	do {
		const page: TimelinePage<Update> = timelinePage(all, {
			limit: 1,
			after,
		});
		seen.push(...page.items.map((u) => u.updateId));
		after = page.next;
	} while (after);
	assert.deepEqual(seen, ["d", "c", "b", "a"]);
});

test("an entry placed back in history sorts by its effective date", () => {
	const all = [
		update("new", day(5)),
		update("back", day(9), {
			placement: "history",
			effectiveOn: day(1),
		}),
	];
	assert.deepEqual(
		timelinePage(all, {}).items.map((u) => u.updateId),
		["new", "back"],
	);
	assert.equal(cursorOf(all[1]).startsWith(`${Date.parse(day(1))}_`), true);
});

test("search and filters apply before paging and set the total", () => {
	const all = [
		update("u1", day(1), { title: "Margin moved" }),
		update("u2", day(2), { impact: "breaking" }),
		update("u3", day(3), {
			about: [
				{
					kind: "field",
					id: "Net Revenue",
					sourceKey: "orders",
					change: "renamed",
					from: "Revenue",
				},
			],
		}),
		update("u4", day(4), { type: "announcement" }),
	];
	assert.deepEqual(
		timelinePage(all, { term: "margin" }).items.map((u) => u.updateId),
		["u1"],
	);
	assert.equal(timelinePage(all, { impact: "breaking" }).total, 1);
	assert.equal(timelinePage(all, { type: "dataChange" }).total, 3);
	assert.equal(matchesTerm(all[2], "revenue"), true);
});

test("the page size stays within its bounds", () => {
	const all = Array.from({ length: 150 }, (_, n) =>
		update(`u${String(n).padStart(3, "0")}`, day(1)),
	);
	assert.equal(timelinePage(all, { limit: 1000 }).items.length, 100);
	assert.equal(timelinePage(all, { limit: 0 }).items.length, 1);
	assert.equal(timelinePage(all, {}).items.length, 30);
});
