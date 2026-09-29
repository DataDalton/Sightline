import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activeElapsed,
	addActive,
	describePattern,
	groupLoads,
	judge,
	learnActiveDays,
	learnPattern,
	readLatenessSetting,
} from "./arrivals";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

// 2026-09-07 was a Monday.
const monday = Date.UTC(2026, 8, 7);

// A load at a given UTC time on every day that passes the test, for some weeks.
function loads(
	weeks: number,
	keep: (weekday: number) => boolean,
	at: number,
	jitter = 0,
): number[] {
	const out: number[] = [];
	for (let d = 0; d < weeks * 7; d++) {
		const date = monday + d * day;
		const weekday = new Date(date).getUTCDay();
		if (!keep(weekday)) continue;
		out.push(date + at + ((d * 7919) % 5) * jitter);
	}
	return out;
}

const weekdays = (d: number) => d >= 1 && d <= 5;

test("time only counts on the days loads happen", () => {
	const friday = monday + 4 * day + 6 * hour;
	const nextMonday = monday + 7 * day + 6 * hour;
	// Friday 06:00 to Monday 06:00 is one working day, not three.
	assert.equal(activeElapsed(friday, nextMonday, [1, 2, 3, 4, 5]), day);
	assert.equal(addActive(friday, day, [1, 2, 3, 4, 5]), nextMonday);
	assert.equal(
		activeElapsed(friday, nextMonday, [0, 1, 2, 3, 4, 5, 6]),
		3 * day,
	);
});

test("commits of one load are one arrival, timed by the last of them", () => {
	const at = monday + 6 * hour;
	assert.deepEqual(
		groupLoads([at + 4 * minute, at, at + 2 * minute, at + day]),
		[at + 4 * minute, at + day],
	);
});

test("weekday loads learn weekdays, and Monday morning is not late", () => {
	const history = loads(5, weekdays, 6 * hour + 10 * minute, 3 * minute);
	const now = monday + 35 * day + 7 * hour; // Monday of week six, 07:00
	assert.deepEqual(learnActiveDays(history, now), [1, 2, 3, 4, 5]);

	const pattern = learnPattern(history, now);
	assert.equal(pattern.kind, "regular");
	assert.deepEqual(pattern.activeDays, [1, 2, 3, 4, 5]);
	assert.ok(pattern.usualMinute !== null);
	assert.match(
		describePattern(pattern),
		/^Usually updates on weekdays by about 6:2\d AM\.$/,
	);

	// Last load was the Friday before. Monday at 07:00 is still on time.
	const lastFriday = history[history.length - 1];
	assert.equal(judge(pattern, lastFriday, now, now).state, "on_time");

	// Monday at noon, looked at since, and nothing arrived, so it is late.
	const noon = monday + 35 * day + 12 * hour;
	const late = judge(pattern, lastFriday, noon, noon);
	assert.equal(late.state, "late");
	// Expected on the Monday morning, not over the weekend.
	assert.equal(new Date(late.expectedBy ?? 0).getUTCDay(), 1);
});

test("nothing is called late until a look after the expected time found nothing", () => {
	const history = loads(5, weekdays, 6 * hour);
	const noon = monday + 35 * day + 12 * hour;
	const pattern = learnPattern(history, noon);
	const lastFriday = history[history.length - 1];
	// The warehouse was stopped all morning, so the last look was on Friday.
	const lastLook = lastFriday + hour;
	assert.equal(judge(pattern, lastFriday, lastLook, noon).state, "overdue");
});

test("a weekly load is judged on its own day only", () => {
	const history = loads(5, (d) => d === 1, 6 * hour);
	const now = monday + 35 * day + 7 * hour;
	const pattern = learnPattern(history, now);
	assert.equal(pattern.kind, "regular");
	assert.deepEqual(pattern.activeDays, [1]);
	assert.match(describePattern(pattern), /on Mondays/);

	const last = history[history.length - 1];
	// Wednesday of the following week is not late, since no Monday has passed.
	const wednesday = last + 2 * day;
	assert.equal(judge(pattern, last, wednesday, wednesday).state, "on_time");
	// The next Monday afternoon with nothing new is late.
	const nextMonday = last + 7 * day + 8 * hour;
	assert.equal(judge(pattern, last, nextMonday, nextMonday).state, "late");
});

test("a stream is learned from its commits rather than grouped into one load", () => {
	const now = monday + 10 * day;
	const history: number[] = [];
	for (let t = now - 2 * day; t < now; t += 5 * minute) history.push(t);
	const pattern = learnPattern(history, now);
	assert.equal(pattern.kind, "regular");
	assert.equal(pattern.stream, true);
	assert.ok((pattern.lateAfterMs ?? 0) <= hour);
	assert.match(describePattern(pattern), /about every 5 minutes/);

	const last = history[history.length - 1];
	assert.equal(
		judge(pattern, last, now, last + 10 * minute).state,
		"on_time",
	);
	assert.equal(
		judge(pattern, last, last + 2 * hour, last + 2 * hour).state,
		"late",
	);
});

test("hourly loads stay separate loads", () => {
	const now = monday + 10 * day;
	const history: number[] = [];
	for (let t = now - 3 * day; t < now; t += hour) history.push(t);
	const pattern = learnPattern(history, now);
	assert.equal(pattern.stream, false);
	assert.equal(pattern.arrivals, history.length);
	assert.match(describePattern(pattern), /about every 1 hour/);
});

test("too few loads is still learning, and scattered loads are never late", () => {
	const now = monday + 30 * day;
	const few = learnPattern([monday + day, monday + 2 * day], now);
	assert.equal(few.kind, "learning");
	assert.equal(judge(few, monday + 2 * day, now, now).state, "learning");

	const scattered = [0, 1, 2, 12, 13, 25, 26, 27].map(
		(d) => monday + d * day + 9 * hour,
	);
	const irregular = learnPattern(scattered, now);
	assert.equal(irregular.kind, "irregular");
	assert.equal(judge(irregular, scattered[7], now, now).state, "irregular");
});

test("a set expectation replaces the learned one, and off never warns", () => {
	const custom = readLatenessSetting({
		mode: "custom",
		everyHours: 12,
		weekdaysOnly: true,
	});
	const pattern = learnPattern([], monday, custom);
	assert.equal(pattern.kind, "regular");
	assert.equal(pattern.setBy, "custom");
	assert.match(
		describePattern(pattern),
		/^Expected to update on weekdays, about every 12 hours\.$/,
	);
	const friday = monday + 4 * day + 20 * hour;
	// Twelve weekday hours after Friday 20:00 is Monday 08:00.
	const judged = judge(pattern, friday, null, friday + day, custom);
	assert.equal(judged.expectedBy, monday + 7 * day + 8 * hour);

	const off = readLatenessSetting({ mode: "off" });
	assert.equal(judge(pattern, 0, 0, monday, off).state, "off");
	assert.deepEqual(readLatenessSetting({ mode: "nonsense" }), {
		mode: "auto",
	});
});

test("daily loads either side of midnight are not averaged to midday", () => {
	// Around five to midnight, some just before and some just after.
	const history: number[] = [];
	for (let d = 0; d < 21; d++) {
		history.push(
			monday +
				d * day +
				23 * hour +
				55 * minute +
				((d % 3) - 1) * 10 * minute,
		);
	}
	const pattern = learnPattern(history, monday + 22 * day);
	assert.ok(pattern.usualMinute !== null);
	// About ten past midnight UTC, not noon.
	assert.ok(
		(pattern.usualMinute ?? 0) < 60 || (pattern.usualMinute ?? 0) > 1400,
	);
});
