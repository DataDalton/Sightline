import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyScenario,
	paceFromRows,
	rankForecasts,
	cleanNarrativeDraft,
	scenarioFactor,
	escapeForHtml,
	fillNarrative,
	findOddOnes,
	goalStatus,
	paceToTarget,
	parseNarrative,
	scoreForecasts,
	wouldHaveToBe,
} from "./insight";

const points = (values: number[]) =>
	values.map((value, index) => ({ label: `p${index}`, value }));

test("one bar far from the rest stands out", () => {
	const odd = findOddOnes(
		points([10, 11, 9, 10, 12, 95, 10, 11]),
		"category",
	);
	assert.deepEqual(
		odd.map((o) => o.label),
		["p5"],
	);
	assert.match(odd[0].reason, /well above/);
});

test("a low one is called low", () => {
	const odd = findOddOnes(
		points([50, 52, 49, 51, 2, 50, 48, 51]),
		"category",
	);
	assert.match(odd[0].reason, /well below/);
});

test("a steady climb over time is not unusual", () => {
	assert.deepEqual(
		findOddOnes(points([10, 20, 30, 40, 50, 60, 70, 80, 90]), "time"),
		[],
	);
});

test("a spike in a climb over time is", () => {
	const odd = findOddOnes(
		points([10, 20, 30, 40, 400, 60, 70, 80, 90, 100]),
		"time",
	);
	assert.equal(odd[0].label, "p4");
});

test("too few points, or none different, say nothing", () => {
	assert.deepEqual(findOddOnes(points([1, 100, 1]), "category"), []);
	assert.deepEqual(
		findOddOnes(points([5, 5, 5, 5, 5, 5, 5]), "category"),
		[],
	);
});

test("worst first when several stand out", () => {
	const odd = findOddOnes(
		points([10, 11, 9, 10, 300, 11, 900, 10, 9]),
		"category",
	);
	assert.equal(odd[0].label, "p6");
});

test("what each part would have to do, nearest to doable first", () => {
	const answer = wouldHaveToBe(100, 120, [
		{ label: "Small", value: 10 },
		{ label: "Big", value: 90 },
	]);
	assert.equal(answer.gap, 20);
	assert.equal(answer.everyonePercent, 20);
	assert.equal(answer.singles[0].label, "Big");
	assert.equal(answer.singles[0].needed, 110);
	assert.equal(answer.singles[1].percent, 200);
});

test("a part at zero has no percentage to show", () => {
	const answer = wouldHaveToBe(0, 10, [{ label: "New", value: 0 }]);
	assert.equal(answer.everyonePercent, null);
	assert.equal(answer.singles[0].percent, null);
});

test("a scenario changes the measure it names", () => {
	const rows = [{ r: "W", m: 100, o: 5 }];
	const [row] = applyScenario(rows, { measure: "m", percent: 10 });
	assert.ok(Math.abs(Number(row.m) - 110) < 1e-9);
	assert.equal(row.o, 5);
});

test("a scenario can be limited to one value", () => {
	const rows = [
		{ r: "W", m: 100 },
		{ r: "E", m: 100 },
	];
	const out = applyScenario(rows, {
		measure: "m",
		percent: -50,
		field: "r",
		value: "W",
	});
	assert.equal(out[0].m, 50);
	assert.equal(out[1].m, 100);
});

test("no scenario hands back the same rows", () => {
	const rows = [{ m: 1 }];
	assert.equal(applyScenario(rows, null), rows);
	assert.equal(applyScenario(rows, { measure: "m", percent: 0 }), rows);
});

test("a narrative names what it needs", () => {
	const tokens = parseNarrative(
		"Revenue is {{Revenue}}, led by {{top Region by Revenue}}, and {{ Revenue }} again.",
	);
	assert.equal(tokens.length, 3);
	assert.deepEqual(tokens[1], {
		kind: "extreme",
		text: "{{top Region by Revenue}}",
		which: "top",
		dimension: "Region",
		measure: "Revenue",
	});
	assert.equal(tokens[0].kind === "value" && tokens[0].measure, "Revenue");
});

test("a narrative fills in, and a value is never read as markup", () => {
	const html = "<b>{{Name}}</b> {{Gone}}";
	assert.equal(
		fillNarrative(html, new Map([["{{Name}}", "<script>x</script>"]])),
		`<b>${escapeForHtml("<script>x</script>")}</b> -`,
	);
});

test("forecasts are scored on what has an actual", () => {
	const score = scoreForecasts([
		{ period: "a", predicted: 100, low: 90, high: 110, actual: 105 },
		{ period: "b", predicted: 100, low: 90, high: 110, actual: 150 },
		{ period: "c", predicted: 100, low: 90, high: 110, actual: null },
	]);
	assert.equal(score.scored, 2);
	assert.equal(score.withinRange, 1);
	assert.ok(
		Math.abs((score.typicalMissPercent ?? 0) - (100 / 3 + 100 / 21) / 2) <
			1e-6,
	);
});

test("nothing scored yet says so", () => {
	assert.equal(scoreForecasts([]).typicalMissPercent, null);
});

test("pace adds what has happened to what is forecast", () => {
	const pace = paceToTarget([10, 20], [30, 40], 90);
	assert.equal(pace.expected, 100);
	assert.equal(pace.onPace, true);
	assert.equal(paceToTarget([10], [10], 90).onPace, false);
});

const goal = {
	start: 100,
	current: 150,
	target: 200,
	startedOn: "2026-01-01",
	dueOn: "2026-12-31",
};
const at = (day: string) => new Date(day).getTime();

test("a goal ahead of a steady line is on track, and behind it is not", () => {
	assert.equal(
		goalStatus({ ...goal, now: at("2026-03-01") }).state,
		"onTrack",
	);
	assert.equal(
		goalStatus({ ...goal, now: at("2026-11-01") }).state,
		"behind",
	);
	assert.equal(goalStatus({ ...goal, now: at("2026-03-01") }).percent, 50);
});

test("a goal past its date, or reached, says so", () => {
	assert.equal(goalStatus({ ...goal, now: at("2027-02-01") }).state, "late");
	assert.equal(
		goalStatus({ ...goal, current: 200, now: at("2027-02-01") }).state,
		"done",
	);
});

test("a goal to bring a number down works the same", () => {
	const down = { ...goal, start: 200, target: 100, now: at("2026-03-01") };
	assert.equal(goalStatus({ ...down, current: 150 }).percent, 50);
	assert.equal(goalStatus({ ...down, current: 90 }).state, "done");
});

test("a goal with no date cannot be behind", () => {
	assert.equal(
		goalStatus({ ...goal, dueOn: null, now: at("2030-01-01") }).state,
		"onTrack",
	);
});

test("a goal set moments ago is not behind", () => {
	assert.equal(
		goalStatus({
			start: 100,
			current: 100,
			target: 200,
			startedOn: "2026-01-01",
			dueOn: "2026-12-31",
			now: at("2026-01-02"),
		}).state,
		"onTrack",
	);
});

test("a figure moves only when it sits within the chosen value", () => {
	const scenario = {
		measure: "Revenue",
		percent: 50,
		field: "Region",
		value: "West",
	};
	assert.equal(scenarioFactor(scenario, "Revenue", { Region: "West" }), 1.5);
	assert.equal(scenarioFactor(scenario, "Revenue", { Region: "East" }), 1);
	assert.equal(scenarioFactor(scenario, "Revenue", {}), 1);
	assert.equal(scenarioFactor(scenario, "Cost", { Region: "West" }), 1);
	assert.equal(
		scenarioFactor({ measure: "Revenue", percent: -10 }, "Revenue", {}),
		0.9,
	);
	assert.equal(scenarioFactor(null, "Revenue", {}), 1);
});

test("a drafted narrative keeps only sentences on real fields with no figure of its own", () => {
	const fields = { dimensions: ["Region"], measures: ["Revenue"] };
	assert.equal(
		cleanNarrativeDraft(
			"Revenue is {{Revenue}}. {{top Region by Revenue}} leads. Margin is {{Margin}}. It rose 12% to {{Revenue}}. Sales look healthy.",
			fields,
		),
		"<p>Revenue is {{Revenue}}. {{top Region by Revenue}} leads.</p>",
	);
	assert.equal(cleanNarrativeDraft("Nothing usable here.", fields), "");
});

test("a figure's pace is what has happened plus what is forecast", () => {
	const rows = [1, 2, 3].map((month) => ({
		period: `2026-0${month}-01`,
		value: 10,
	}));
	const held = paceFromRows(rows, "period", "value", 20, "2026-04-15");
	assert.equal(held.year, "2026");
	assert.equal(held.forecasted, false);
	assert.equal(held.pace.expected, 30);
	assert.equal(held.pace.onPace, true);
});

test("too little history ranks nothing, rather than guessing", () => {
	assert.deepEqual(
		rankForecasts(
			[{ region: "West", period: "2026-01-01", value: 1 }],
			"region",
			"period",
			"value",
			"2026-06-01",
		),
		[],
	);
});

test("assumptions add up, each to what it names", () => {
	const rows = [
		{ region: "West", revenue: 100, cost: 50 },
		{ region: "East", revenue: 100, cost: 50 },
	];
	const moved = applyScenario(rows, [
		{ measure: "revenue", percent: 10 },
		{ measure: "revenue", percent: 100, field: "region", value: "West" },
		{ measure: "cost", percent: -50 },
	]);
	assert.ok(Math.abs(Number(moved[0].revenue) - 220) < 0.0001);
	assert.ok(Math.abs(Number(moved[1].revenue) - 110) < 0.0001);
	assert.equal(moved[0].cost, 25);
	assert.ok(
		Math.abs(
			scenarioFactor(
				[
					{ measure: "revenue", percent: 10 },
					{
						measure: "revenue",
						percent: 100,
						field: "region",
						value: "West",
					},
				],
				"revenue",
				{ region: "West" },
			) - 2.2,
		) < 0.0001,
	);
});
