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
