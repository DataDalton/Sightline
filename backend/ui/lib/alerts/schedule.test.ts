import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSchedule, describeSchedule, nextRun } from "./schedule";

test("hourly lands on the next top of the hour", () => {
	const s = cleanSchedule({ frequency: "hourly", timeZone: "UTC" });
	assert.equal(
		nextRun(s, new Date("2026-03-02T10:15:00Z")).toISOString(),
		"2026-03-02T11:00:00.000Z",
	);
	assert.equal(
		nextRun(s, new Date("2026-03-02T11:00:00Z")).toISOString(),
		"2026-03-02T12:00:00.000Z",
		"a check on the hour is followed by the next one",
	);
});

test("daily is the owner's hour, not the server's", () => {
	const s = cleanSchedule({
		frequency: "daily",
		hour: 8,
		timeZone: "America/Chicago",
	});
	// 8 AM in Chicago in March after the change is 13:00 UTC.
	assert.equal(
		nextRun(s, new Date("2026-03-10T12:00:00Z")).toISOString(),
		"2026-03-10T13:00:00.000Z",
	);
	// Already past today, so tomorrow.
	assert.equal(
		nextRun(s, new Date("2026-03-10T14:00:00Z")).toISOString(),
		"2026-03-11T13:00:00.000Z",
	);
});

test("follows the zone across a daylight saving change", () => {
	const s = cleanSchedule({
		frequency: "daily",
		hour: 8,
		timeZone: "America/Chicago",
	});
	// Clocks go forward on 8 March 2026. 8 AM is 14:00 UTC the day before and
	// 13:00 UTC on the day.
	assert.equal(
		nextRun(s, new Date("2026-03-07T15:00:00Z")).toISOString(),
		"2026-03-08T13:00:00.000Z",
	);
});

function runs(
	schedule: ReturnType<typeof cleanSchedule>,
	from: string,
	count: number,
): string[] {
	const out: string[] = [];
	let at = new Date(from);
	for (let i = 0; i < count; i++) {
		at = nextRun(schedule, at);
		out.push(at.toISOString());
	}
	return out;
}

test("a daily hour skipped by clocks going forward runs as they jump", () => {
	const s = cleanSchedule({
		frequency: "daily",
		hour: 2,
		timeZone: "America/New_York",
	});
	// 8 March 2026 in New York goes from 01:59 EST to 03:00 EDT, which is
	// 07:00 UTC. There is no 2 AM that day.
	assert.deepEqual(runs(s, "2026-03-07T00:00:00Z", 3), [
		"2026-03-07T07:00:00.000Z",
		"2026-03-08T07:00:00.000Z",
		"2026-03-09T06:00:00.000Z",
	]);
});

test("a daily hour repeated by clocks going back runs once, the first time", () => {
	const s = cleanSchedule({
		frequency: "daily",
		hour: 1,
		timeZone: "America/New_York",
	});
	// 1 November 2026 in New York reads 1 AM at 05:00 UTC in EDT and again at
	// 06:00 UTC in EST. Only the first is a run.
	assert.deepEqual(runs(s, "2026-10-31T00:00:00Z", 3), [
		"2026-10-31T05:00:00.000Z",
		"2026-11-01T05:00:00.000Z",
		"2026-11-02T06:00:00.000Z",
	]);
	// Asked from between the two readings, the day's run has passed.
	assert.equal(
		nextRun(s, new Date("2026-11-01T05:30:00Z")).toISOString(),
		"2026-11-02T06:00:00.000Z",
	);
});

test("hours either side of a change keep their own offset", () => {
	const s = cleanSchedule({
		frequency: "daily",
		hour: 3,
		timeZone: "America/New_York",
	});
	// 3 AM exists on both change days.
	assert.equal(
		nextRun(s, new Date("2026-03-08T00:00:00Z")).toISOString(),
		"2026-03-08T07:00:00.000Z",
	);
	assert.equal(
		nextRun(s, new Date("2026-11-01T00:00:00Z")).toISOString(),
		"2026-11-01T08:00:00.000Z",
	);
});

test("hourly runs on every real hour through both changes", () => {
	const s = cleanSchedule({
		frequency: "hourly",
		timeZone: "America/New_York",
	});
	assert.deepEqual(runs(s, "2026-03-08T05:30:00Z", 3), [
		"2026-03-08T06:00:00.000Z",
		"2026-03-08T07:00:00.000Z",
		"2026-03-08T08:00:00.000Z",
	]);
	assert.deepEqual(runs(s, "2026-11-01T04:30:00Z", 3), [
		"2026-11-01T05:00:00.000Z",
		"2026-11-01T06:00:00.000Z",
		"2026-11-01T07:00:00.000Z",
	]);
});

test("a half hour zone runs on its own whole hours", () => {
	const daily = cleanSchedule({
		frequency: "daily",
		hour: 9,
		timeZone: "Asia/Kolkata",
	});
	// 9 AM at UTC+5:30 is 03:30 UTC.
	assert.equal(
		nextRun(daily, new Date("2026-06-01T00:00:00Z")).toISOString(),
		"2026-06-01T03:30:00.000Z",
	);
	assert.equal(
		nextRun(daily, new Date("2026-06-01T03:30:00Z")).toISOString(),
		"2026-06-02T03:30:00.000Z",
	);

	const hourly = cleanSchedule({
		frequency: "hourly",
		timeZone: "Asia/Kolkata",
	});
	assert.deepEqual(runs(hourly, "2026-06-01T10:00:00Z", 2), [
		"2026-06-01T10:30:00.000Z",
		"2026-06-01T11:30:00.000Z",
	]);
});

test("a three quarter hour zone runs on its own whole hours", () => {
	const hourly = cleanSchedule({
		frequency: "hourly",
		timeZone: "Asia/Kathmandu",
	});
	// UTC+5:45, so every local hour is a quarter past in UTC.
	assert.deepEqual(runs(hourly, "2026-06-01T10:00:00Z", 2), [
		"2026-06-01T10:15:00.000Z",
		"2026-06-01T11:15:00.000Z",
	]);
});

test("a half hour zone with daylight saving follows both changes", () => {
	const s = cleanSchedule({
		frequency: "daily",
		hour: 2,
		timeZone: "Australia/Adelaide",
	});
	// Adelaide goes back from 3 AM at +10:30 to 2 AM at +9:30 on 5 April
	// 2026, so 2 AM happens twice. The first, at +10:30, is the run.
	assert.deepEqual(runs(s, "2026-04-04T12:00:00Z", 2), [
		"2026-04-04T15:30:00.000Z",
		"2026-04-05T16:30:00.000Z",
	]);
	// It goes from +9:30 to +10:30 at 2 AM on 4 October 2026, which skips
	// 2 AM. The run happens as the clocks jump, at 16:30 UTC.
	assert.equal(
		nextRun(s, new Date("2026-10-03T12:00:00Z")).toISOString(),
		"2026-10-03T16:30:00.000Z",
	);
	assert.equal(
		nextRun(s, new Date("2026-10-03T16:30:00Z")).toISOString(),
		"2026-10-04T15:30:00.000Z",
	);
});

test("London runs once across the autumn change and at the jump in spring", () => {
	const spring = cleanSchedule({
		frequency: "daily",
		hour: 1,
		timeZone: "Europe/London",
	});
	// 29 March 2026 goes from 01:00 GMT straight to 02:00 BST.
	assert.deepEqual(runs(spring, "2026-03-28T00:00:00Z", 3), [
		"2026-03-28T01:00:00.000Z",
		"2026-03-29T01:00:00.000Z",
		"2026-03-30T00:00:00.000Z",
	]);

	const autumn = cleanSchedule({
		frequency: "daily",
		hour: 1,
		timeZone: "Europe/London",
	});
	// 25 October 2026 reads 1 AM at 00:00 UTC in BST and at 01:00 UTC in GMT.
	assert.deepEqual(runs(autumn, "2026-10-24T12:00:00Z", 2), [
		"2026-10-25T00:00:00.000Z",
		"2026-10-26T01:00:00.000Z",
	]);
});

test("weekly counts the owner's weekday, not the UTC one", () => {
	const s = cleanSchedule({
		frequency: "weekly",
		hour: 8,
		weekday: 1,
		timeZone: "Pacific/Auckland",
	});
	// Monday 8 AM in Auckland in June (+12) is Sunday 20:00 UTC.
	assert.equal(
		nextRun(s, new Date("2026-06-03T00:00:00Z")).toISOString(),
		"2026-06-07T20:00:00.000Z",
	);
});

test("weekdays skip the weekend and weekly waits for its day", () => {
	const weekdays = cleanSchedule({
		frequency: "weekdays",
		hour: 9,
		timeZone: "UTC",
	});
	// Friday 6 March 2026 after nine, so Monday.
	assert.equal(
		nextRun(weekdays, new Date("2026-03-06T10:00:00Z")).toISOString(),
		"2026-03-09T09:00:00.000Z",
	);

	const weekly = cleanSchedule({
		frequency: "weekly",
		hour: 7,
		weekday: 3,
		timeZone: "UTC",
	});
	assert.equal(
		nextRun(weekly, new Date("2026-03-02T00:00:00Z")).toISOString(),
		"2026-03-04T07:00:00.000Z",
	);
});

test("cleans what it cannot use to a safe default", () => {
	const s = cleanSchedule({
		frequency: "every minute",
		hour: 40,
		timeZone: "Mars/Olympus",
	});
	assert.deepEqual(s, {
		frequency: "daily",
		hour: 8,
		weekday: 1,
		timeZone: "UTC",
	});
});

test("reads the schedule aloud", () => {
	assert.equal(
		describeSchedule(cleanSchedule({ frequency: "hourly" })),
		"Every hour",
	);
	assert.equal(
		describeSchedule(cleanSchedule({ frequency: "daily", hour: 0 })),
		"Every day at 12:00 AM",
	);
	assert.equal(
		describeSchedule(
			cleanSchedule({ frequency: "weekly", hour: 13, weekday: 5 }),
		),
		"Fridays at 1:00 PM",
	);
});
