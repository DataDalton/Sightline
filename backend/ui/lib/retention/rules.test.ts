import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addDays,
	addMonths,
	binDays,
	candidateCutoff,
	conversationExpired,
	dayKey,
	decide,
	isRetentionKind,
	itemLink,
	latestUse,
	warningLeadDays,
	type RetentionItem,
} from "./rules";

const at = (iso: string) => new Date(iso);

function item(change: Partial<RetentionItem> = {}): RetentionItem {
	return {
		lastUsed: at("2025-01-15T12:00:00Z"),
		liveReference: false,
		keep: false,
		removedOn: null,
		warnings: [],
		...change,
	};
}

test("months are added on the calendar and clamp to the end of the month", () => {
	assert.equal(
		addMonths(at("2025-01-31T08:00:00Z"), 1).toISOString(),
		"2025-02-28T08:00:00.000Z",
	);
	assert.equal(
		addMonths(at("2024-01-31T08:00:00Z"), 1).toISOString(),
		"2024-02-29T08:00:00.000Z",
	);
	assert.equal(
		addMonths(at("2025-03-15T00:00:00Z"), 12).toISOString(),
		"2026-03-15T00:00:00.000Z",
	);
	assert.equal(
		addMonths(at("2025-03-31T00:00:00Z"), -1).toISOString(),
		"2025-02-28T00:00:00.000Z",
	);
});

test("the latest use is taken from whichever moments are present", () => {
	assert.equal(latestUse(null, undefined, "not a date"), null);
	assert.equal(
		latestUse(
			"2025-01-01T00:00:00Z",
			at("2025-03-01T00:00:00Z"),
			null,
			"2025-02-01T00:00:00Z",
		)?.toISOString(),
		"2025-03-01T00:00:00.000Z",
	);
});

test("an item used recently is left alone", () => {
	assert.deepEqual(decide(item(), 12, at("2025-06-01T00:00:00Z")), {
		action: "none",
	});
});

test("retention off does nothing, the bin included", () => {
	const old = item({ lastUsed: at("2020-01-01T00:00:00Z") });
	assert.deepEqual(decide(old, 0, at("2026-01-01T00:00:00Z")), {
		action: "none",
	});
	const binned = item({ removedOn: at("2020-01-01T00:00:00Z") });
	assert.deepEqual(decide(binned, 0, at("2026-01-01T00:00:00Z")), {
		action: "none",
	});
});

test("an item is warned once it is within the lead of its due date", () => {
	const due = addMonths(at("2025-01-15T12:00:00Z"), 12);
	const before = addDays(due, -warningLeadDays - 1);
	assert.deepEqual(decide(item(), 12, before), { action: "none" });

	const onTime = decide(item(), 12, addDays(due, -warningLeadDays));
	assert.equal(onTime.action, "warn");
	if (onTime.action === "warn") {
		assert.equal(onTime.dueOn, dayKey(due));
		assert.equal(onTime.removeOn.toISOString(), due.toISOString());
	}

	// Warned late, the removal waits out the whole warning period.
	const late = addDays(due, -warningLeadDays + 1);
	const decision = decide(item(), 12, late);
	assert.equal(decision.action, "warn");
	if (decision.action === "warn") {
		assert.equal(
			decision.removeOn.toISOString(),
			addDays(late, warningLeadDays).toISOString(),
		);
	}
});

test("a warning is not sent twice for the same due date", () => {
	const due = addMonths(at("2025-01-15T12:00:00Z"), 12);
	const warnedOn = addDays(due, -warningLeadDays);
	const warned = item({ warnings: [{ dueOn: dayKey(due), warnedOn }] });
	assert.deepEqual(decide(warned, 12, addDays(due, -1)), { action: "none" });
});

test("a warned item is removed once its due date has passed", () => {
	const due = addMonths(at("2025-01-15T12:00:00Z"), 12);
	const warned = item({
		warnings: [
			{ dueOn: dayKey(due), warnedOn: addDays(due, -warningLeadDays) },
		],
	});
	assert.deepEqual(decide(warned, 12, addDays(due, 1)), {
		action: "remove",
	});
});

test("an item first seen past its date still gets the full warning period", () => {
	const lastUsed = at("2020-01-01T00:00:00Z");
	const now = at("2026-01-01T00:00:00Z");
	const first = decide(item({ lastUsed }), 12, now);
	assert.equal(first.action, "warn");
	if (first.action !== "warn") return;
	assert.equal(
		first.removeOn.toISOString(),
		addDays(now, warningLeadDays).toISOString(),
	);

	const warned = item({
		lastUsed,
		warnings: [{ dueOn: first.dueOn, warnedOn: now }],
	});
	assert.deepEqual(decide(warned, 12, addDays(now, warningLeadDays - 1)), {
		action: "none",
	});
	assert.deepEqual(decide(warned, 12, addDays(now, warningLeadDays)), {
		action: "remove",
	});
});

test("use after a warning moves the due date, and the old warning no longer counts", () => {
	const oldDue = addMonths(at("2025-01-15T12:00:00Z"), 12);
	const reused = item({
		lastUsed: at("2025-12-20T09:00:00Z"),
		warnings: [
			{
				dueOn: dayKey(oldDue),
				warnedOn: addDays(oldDue, -warningLeadDays),
			},
		],
	});
	assert.deepEqual(decide(reused, 12, addDays(oldDue, 1)), {
		action: "none",
	});

	const newDue = addMonths(at("2025-12-20T09:00:00Z"), 12);
	const decision = decide(reused, 12, addDays(newDue, -1));
	assert.equal(decision.action, "warn");
	if (decision.action === "warn")
		assert.equal(decision.dueOn, dayKey(newDue));
});

test("kept items and items something still reads are never warned or removed", () => {
	const now = at("2030-01-01T00:00:00Z");
	assert.deepEqual(decide(item({ keep: true }), 12, now), {
		action: "none",
	});
	assert.deepEqual(decide(item({ liveReference: true }), 12, now), {
		action: "none",
	});
});

test("an item with no recorded use is left alone", () => {
	assert.deepEqual(
		decide(item({ lastUsed: null }), 12, at("2030-01-01T00:00:00Z")),
		{ action: "none" },
	);
});

test("an item in the bin is purged once the bin period is over, kept or not", () => {
	const removedOn = at("2026-01-01T00:00:00Z");
	const binned = item({ removedOn, keep: true });
	assert.deepEqual(decide(binned, 12, addDays(removedOn, binDays - 1)), {
		action: "none",
	});
	assert.deepEqual(decide(binned, 12, addDays(removedOn, binDays)), {
		action: "purge",
	});
});

test("the candidate cutoff lets through everything that could be due", () => {
	const now = at("2026-10-01T00:00:00Z");
	const cutoff = candidateCutoff(12, now);
	// An item used just after the cutoff is not yet within its warning lead.
	const after = addDays(cutoff, 1);
	assert.deepEqual(decide(item({ lastUsed: after }), 12, now), {
		action: "none",
	});
	// Every item the rule would warn today was used before the cutoff.
	for (let days = 0; days < 400; days += 7) {
		const lastUsed = addDays(now, -days);
		const decision = decide(item({ lastUsed }), 12, now);
		if (decision.action !== "none") {
			assert.ok(lastUsed.getTime() < cutoff.getTime(), String(days));
		}
	}
});

test("conversations expire after the period, and never with retention off", () => {
	const modified = at("2025-01-01T00:00:00Z");
	assert.equal(
		conversationExpired(modified, 12, at("2025-12-31T00:00:00Z")),
		false,
	);
	assert.equal(
		conversationExpired(modified, 12, at("2026-01-01T00:00:00Z")),
		true,
	);
	assert.equal(
		conversationExpired(modified, 0, at("2040-01-01T00:00:00Z")),
		false,
	);
});

test("kinds are checked and each opens at its own address", () => {
	assert.equal(isRetentionKind("sheet"), true);
	assert.equal(isRetentionKind("conversation"), false);
	assert.equal(itemLink("page", "x", "sales-q3"), "/r/sales-q3/");
	assert.equal(itemLink("board", "abc"), "/boards/abc/");
	assert.equal(itemLink("exploreView", "a b"), "/explore/?view=a%20b");
});
