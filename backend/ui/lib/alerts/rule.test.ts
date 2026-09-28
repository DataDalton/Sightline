import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AlertDefinitionError,
	cleanDefinition,
	describeFirings,
	describeRule,
	evaluate,
	type AlertState,
	type Wording,
} from "./rule";

const above = {
	condition: "above" as const,
	threshold: 100,
	notifyRecover: false,
};

test("a threshold fires on the check that crosses it, and not again while it holds", () => {
	const first = evaluate(above, [{ group: null, value: 150 }], {});
	assert.equal(first.firings.length, 1);
	assert.equal(first.firings[0].kind, "fired");

	const second = evaluate(above, [{ group: null, value: 180 }], first.state);
	assert.equal(second.firings.length, 0);

	const dropped = evaluate(above, [{ group: null, value: 90 }], second.state);
	assert.equal(dropped.firings.length, 0, "no recovery message unless asked");

	const again = evaluate(above, [{ group: null, value: 120 }], dropped.state);
	assert.equal(again.firings.length, 1, "crossing again fires again");
});

test("says it is back to normal only when asked to", () => {
	const rule = { ...above, notifyRecover: true };
	const held: AlertState = { "": { value: 150, met: true } };
	const back = evaluate(rule, [{ group: null, value: 80 }], held);
	assert.deepEqual(
		back.firings.map((f) => [f.kind, f.value, f.previous]),
		[["recovered", 80, 150]],
	);
});

test("below compares the other way, and a blank value never meets it", () => {
	const rule = {
		condition: "below" as const,
		threshold: 10,
		notifyRecover: false,
	};
	assert.equal(
		evaluate(rule, [{ group: null, value: 5 }], {}).firings.length,
		1,
	);
	assert.equal(
		evaluate(rule, [{ group: null, value: null }], {}).firings.length,
		0,
	);
});

test("each group is followed on its own", () => {
	const previous: AlertState = {
		West: { value: 150, met: true },
		East: { value: 50, met: false },
	};
	const out = evaluate(
		above,
		[
			{ group: "West", value: 160 },
			{ group: "East", value: 130 },
			{ group: "North", value: 400 },
		],
		previous,
	);
	assert.deepEqual(
		out.firings.map((f) => f.group),
		["East", "North"],
	);
	assert.deepEqual(Object.keys(out.state).sort(), ["East", "North", "West"]);
});

test("a percentage change needs a previous value, and fires on every check that moves enough", () => {
	const rule = {
		condition: "rises_by" as const,
		threshold: 10,
		notifyRecover: false,
	};
	const first = evaluate(rule, [{ group: null, value: 100 }], {});
	assert.equal(
		first.firings.length,
		0,
		"nothing to compare the first check with",
	);

	const up = evaluate(rule, [{ group: null, value: 115 }], first.state);
	assert.equal(up.firings.length, 1);
	assert.equal(Math.round(up.firings[0].change ?? 0), 15);

	const again = evaluate(rule, [{ group: null, value: 130 }], up.state);
	assert.equal(again.firings.length, 1, "each rise is its own news");

	const small = evaluate(rule, [{ group: null, value: 131 }], again.state);
	assert.equal(small.firings.length, 0);
});

test("falls and either way", () => {
	const falls = {
		condition: "falls_by" as const,
		threshold: 20,
		notifyRecover: false,
	};
	const prev: AlertState = { "": { value: 100, met: false } };
	assert.equal(
		evaluate(falls, [{ group: null, value: 70 }], prev).firings.length,
		1,
	);
	assert.equal(
		evaluate(falls, [{ group: null, value: 130 }], prev).firings.length,
		0,
	);

	const either = {
		condition: "changes_by" as const,
		threshold: 20,
		notifyRecover: false,
	};
	assert.equal(
		evaluate(either, [{ group: null, value: 130 }], prev).firings.length,
		1,
	);
	assert.equal(
		evaluate(either, [{ group: null, value: 70 }], prev).firings.length,
		1,
	);
});

test("a change from zero is not a percentage", () => {
	const rule = {
		condition: "changes_by" as const,
		threshold: 5,
		notifyRecover: false,
	};
	const out = evaluate(rule, [{ group: null, value: 10 }], {
		"": { value: 0, met: false },
	});
	assert.equal(out.firings.length, 0);
});

test("changes fires on any difference after the first check", () => {
	const rule = {
		condition: "changes" as const,
		threshold: null,
		notifyRecover: false,
	};
	const first = evaluate(rule, [{ group: null, value: 3 }], {});
	assert.equal(first.firings.length, 0);
	assert.equal(
		evaluate(rule, [{ group: null, value: 3 }], first.state).firings.length,
		0,
	);
	assert.equal(
		evaluate(rule, [{ group: null, value: 4 }], first.state).firings.length,
		1,
	);
});

test("cleans a definition and refuses the parts it cannot run", () => {
	const ok = cleanDefinition({
		sourceKey: "sales",
		measure: "Revenue",
		groupBy: "Region",
		condition: "above",
		threshold: "1,000,000",
		conditions: [
			{ field: "Category", op: "eq", value: "Hardware", join: "and" },
		],
		schedule: {
			frequency: "weekly",
			hour: 9,
			weekday: 1,
			timeZone: "America/Chicago",
		},
	});
	assert.equal(ok.threshold, 1_000_000);
	assert.equal(ok.groupBy, "Region");
	assert.equal(ok.conditions.length, 1);
	assert.equal(ok.schedule.frequency, "weekly");
	assert.equal(ok.name, "Revenue is above 1000000");

	assert.throws(
		() =>
			cleanDefinition({
				sourceKey: "sales",
				measure: "Revenue",
				condition: "above",
			}),
		AlertDefinitionError,
	);
	assert.throws(
		() =>
			cleanDefinition({
				sourceKey: "sales",
				measure: "Revenue",
				condition: "rises_by",
				threshold: -5,
			}),
		AlertDefinitionError,
	);
	assert.throws(
		() => cleanDefinition({ sourceKey: "sales" }),
		AlertDefinitionError,
	);

	const any = cleanDefinition({
		sourceKey: "sales",
		measure: "Units",
		condition: "changes",
	});
	assert.equal(any.threshold, null);
});

const wording: Wording = {
	measure: "Revenue",
	groupBy: "Region",
	condition: "above",
	threshold: 1000,
	format: (v) => (v === null ? "-" : `$${v}`),
};

test("describes the rule and what happened in words", () => {
	assert.equal(
		describeRule(wording),
		"Revenue for any Region is above $1000",
	);
	assert.equal(
		describeRule({
			...wording,
			groupBy: null,
			condition: "falls_by",
			threshold: 10,
		}),
		"Revenue falls by more than 10%",
	);

	const one = describeFirings("Big regions", wording, [
		{
			group: "West",
			value: 1200,
			previous: 900,
			change: null,
			kind: "fired",
		},
	]);
	assert.deepEqual(one, {
		title: "Big regions",
		body: "West: Revenue is $1200, above $1000",
	});

	const many = describeFirings(
		"Big regions",
		wording,
		Array.from({ length: 7 }, (_, i) => ({
			group: `R${i}`,
			value: 2000,
			previous: null,
			change: null,
			kind: "fired" as const,
		})),
	);
	assert.equal(many?.title, "Big regions: 7 Region values");
	assert.equal(many?.body.split("\n").length, 6);
	assert.match(many?.body ?? "", /and 2 more$/);

	assert.equal(describeFirings("x", wording, []), null);
});
