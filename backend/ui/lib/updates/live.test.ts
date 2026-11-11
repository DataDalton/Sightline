import { test } from "node:test";
import assert from "node:assert/strict";
import type { Update } from "./model";
import { fieldSlice, homeCardSize, liveSlice, markerSlice } from "./live";

function update(
	id: string,
	postedOn: string,
	extra: Partial<Update> & { read?: boolean } = {},
) {
	return {
		read: false,
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
	} as Update & { read: boolean };
}

const day = (n: number) =>
	`2026-11-${String(n).padStart(2, "0")}T12:00:00.000Z`;

const now = Date.parse("2026-11-20T12:00:00.000Z");
const quiet = {
	home: false,
	page: true,
	push: false,
	inbox: true,
	popup: false,
	banner: false,
};

test("the live slice keeps only what some surface shows today", () => {
	const all = [
		update("home1", day(19)),
		update("home2", day(18)),
		update("home3", day(17)),
		update("home4", day(16)),
		update("home5", day(15)),
		update("plain", day(14), { delivery: quiet }),
		update("breaking", day(13), { delivery: quiet, impact: "breaking" }),
		update("incident", day(12), {
			delivery: quiet,
			type: "incident",
			incidentState: "investigating",
		}),
		update("resolved", day(11), {
			delivery: quiet,
			type: "incident",
			incidentState: "resolved",
		}),
		update("popupRead", day(10), {
			delivery: { ...quiet, popup: true },
			read: true,
		}),
		update("popupUnread", day(9), {
			delivery: { ...quiet, popup: true },
			body: "Read this",
		}),
		update("maintenance", day(8), {
			delivery: quiet,
			type: "maintenance",
			startsOn: "2026-11-21T00:00:00.000Z",
			endsOn: "2026-11-21T02:00:00.000Z",
		}),
		update("pastMaintenance", day(7), {
			delivery: quiet,
			type: "maintenance",
			startsOn: "2026-11-01T00:00:00.000Z",
			endsOn: "2026-11-01T02:00:00.000Z",
		}),
	];
	const ids = liveSlice(all, now).map((u) => u.updateId);
	assert.equal(homeCardSize, 4);
	assert.deepEqual(ids, [
		"home1",
		"home2",
		"home3",
		"home4",
		"breaking",
		"incident",
		"popupUnread",
		"maintenance",
	]);
	const popup = liveSlice(all, now).find((u) => u.updateId === "popupUnread");
	assert.equal(popup?.body, "Read this");
	assert.equal(
		liveSlice(all, now).find((u) => u.updateId === "breaking")?.body,
		null,
	);
});

test("the live slice leaves tables and change details out of what it is about", () => {
	const [entry] = liveSlice(
		[
			update("a", day(19), {
				about: [
					{ kind: "table", id: "lake.sales.orders" },
					{
						kind: "field",
						id: "Net Revenue",
						sourceKey: "orders",
						change: "renamed",
						from: "Revenue",
					},
					{ kind: "report", id: "r1" },
				],
			}),
		],
		now,
	);
	assert.deepEqual(entry.about, [
		{ kind: "field", id: "Net Revenue", sourceKey: "orders" },
		{ kind: "report", id: "r1" },
	]);
});

test("markers carry only the sources a page reads", () => {
	const markers = markerSlice(
		[
			update("a", day(5), {
				effectiveOn: day(4),
				about: [
					{ kind: "source", id: "orders" },
					{ kind: "source", id: "stock" },
				],
			}),
			update("b", day(6), {
				effectiveOn: day(6),
				about: [{ kind: "source", id: "stock" }],
			}),
			update("c", day(7), { about: [{ kind: "source", id: "orders" }] }),
		],
		["orders"],
	);
	assert.deepEqual(markers, [
		{ sourceKeys: ["orders"], at: day(4), label: "Entry a" },
	]);
});

test("a field lists changes naming it, its old name or its whole dataset", () => {
	const shown = fieldSlice(
		[
			update("renamed", day(3), {
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
			update("dataset", day(2), {
				about: [{ kind: "source", id: "orders" }],
			}),
			update("other", day(1), {
				about: [{ kind: "field", id: "Region", sourceKey: "orders" }],
			}),
		],
		"orders",
		"Revenue",
	);
	assert.deepEqual(
		shown.map((u) => u.updateId),
		["renamed", "dataset"],
	);
});
