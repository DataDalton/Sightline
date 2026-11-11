import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAboutNames, cleanInput, builtinTypes } from "../updates/model";
import { cleanDeckInput } from "../visuals/deck";
import {
	buildDeck,
	buildFollows,
	buildGoals,
	buildReads,
	buildRuleRuns,
	buildRules,
	buildUpdates,
	demoDatasets,
	failureDays,
	fieldAbout,
	lowerIsBetter,
	makeRandom,
	ruleSpecs,
	tableAbout,
	tableSchemas,
	type ScalePage,
	type ScaleReport,
} from "./scaleData";

const now = Date.UTC(2026, 10, 10, 12);
const people = [
	"a.person@example.com",
	"b.person@example.com",
	"c.person@example.com",
];
const reports: ScaleReport[] = [
	{
		reportId: "r1",
		slug: "one",
		title: "One",
		categoryId: "sales",
		sourceKey: "sales_orders",
	},
	{
		reportId: "r2",
		slug: "two",
		title: "Two",
		categoryId: "sales",
		sourceKey: "sales_orders",
	},
];
const pages: ScalePage[] = [
	{ pageId: "p1", reportId: "r1", title: "Overview", sourceKey: null },
	{ pageId: "p2", reportId: "r1", title: "Detail", sourceKey: null },
];

test("the generator repeats for the same seed and stays in range", () => {
	const first = makeRandom(7);
	const second = makeRandom(7);
	for (let i = 0; i < 200; i += 1) {
		const value = first.next();
		assert.equal(value, second.next());
		assert.ok(value >= 0 && value < 1);
	}
	const random = makeRandom(3);
	for (let i = 0; i < 200; i += 1) {
		const value = random.int(2, 5);
		assert.ok(value >= 2 && value <= 5 && Number.isInteger(value));
	}
	assert.notEqual(makeRandom(1).next(), makeRandom(2).next());
});

test("a sample has no repeats and a uuid has the version four shape", () => {
	const random = makeRandom(11);
	const drawn = random.sample([1, 2, 3, 4, 5, 6], 4);
	assert.equal(drawn.length, 4);
	assert.equal(new Set(drawn).size, 4);
	assert.equal(random.sample([1, 2], 5).length, 2);
	assert.match(
		random.uuid(),
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
});

test("field items name real fields unless removed, and pass the update checks", () => {
	const random = makeRandom(5);
	for (let i = 0; i < 300; i += 1) {
		const about = fieldAbout(random);
		assert.ok(about.length >= 1 && about.length <= 12);
		const datasets = new Set(about.map((item) => item.sourceKey));
		assert.ok(datasets.size >= 1 && datasets.size <= 3);
		for (const item of about) {
			const fields = demoDatasets.find(
				(d) => d.sourceKey === item.sourceKey,
			)!.fields;
			if (item.change === "removed") continue;
			assert.ok(
				fields.includes(item.id),
				`${item.id} is a field of ${item.sourceKey}`,
			);
			if (item.change === "renamed") assert.ok(item.from);
		}
		assert.doesNotThrow(() => checkAboutNames(about, demoDatasets));
	}
});

test("table items are three part names, and a wide list spans many schemas", () => {
	const random = makeRandom(9);
	for (let i = 0; i < 100; i += 1) {
		const narrow = tableAbout(random, false);
		assert.ok(narrow.length >= 1 && narrow.length <= 10);
		const wide = tableAbout(random, true);
		assert.ok(wide.length >= 50 && wide.length <= 150);
		const schemas = new Set(wide.map((item) => item.id.split(".")[1]));
		assert.ok(schemas.size >= 3 && schemas.size <= 12);
		for (const item of [...narrow, ...wide]) {
			assert.equal(item.kind, "table");
			assert.equal(item.id.split(".").length, 3);
		}
		assert.equal(new Set(wide.map((item) => item.id)).size, wide.length);
	}
	assert.ok(tableSchemas.every((schema) => schema.tables.length >= 50));
});

test("updates come out cleaned, with unique references and a realistic mix", () => {
	const updates = buildUpdates(
		makeRandom(20261110),
		{ now, people, reports, pages },
		600,
	);
	assert.equal(updates.length, 600);
	assert.equal(updates[0].input.reference, "demo-scale-1");
	assert.equal(new Set(updates.map((u) => u.input.reference)).size, 600);
	const links = updates.flatMap((u) => u.input.links.map((link) => link.url));
	assert.equal(new Set(links).size, links.length);

	const types = new Map(builtinTypes.map((type) => [type.typeId, type]));
	const share = (match: (u: (typeof updates)[number]) => boolean) =>
		updates.filter(match).length / updates.length;
	for (const update of updates) {
		// Cleaning again changes nothing, so the row reads back as it was written.
		const again = cleanInput(
			{ ...update.input },
			types.get(update.input.type),
		);
		assert.deepEqual(again, update.input);
		assert.ok(
			update.input.authors.length >= 1 &&
				update.input.authors.length <= 3,
		);
		assert.equal(update.input.delivery.banner, false);
		assert.equal(update.input.delivery.popup, false);
		assert.ok(new Date(update.postedOn).getTime() <= now);
		if (update.input.placement === "history") {
			assert.ok(update.input.effectiveOn! <= update.postedOn);
		}
	}
	assert.ok(share((u) => u.input.impact === "info") > 0.65);
	assert.ok(share((u) => u.input.impact === "breaking") < 0.1);
	assert.ok(
		share(
			(u) =>
				u.input.type === "dataChange" ||
				u.input.type === "reportChange",
		) > 0.65,
	);
	assert.ok(share((u) => u.input.placement === "history") > 0.1);
	assert.ok(
		share((u) => u.input.about.some((item) => item.kind === "field")) > 0.3,
	);
	assert.ok(share((u) => u.input.about.length === 0) > 0.05);
	assert.ok(
		updates.some(
			(u) =>
				u.input.about.filter((item) => item.kind === "table").length >=
				50,
		),
	);
	assert.ok(
		updates.some((u) => u.input.authors.some((author) => author.github)),
	);
	assert.ok(share((u) => u.input.whatToDo !== null) > 0.08);
	assert.ok(updates.some((u) => u.input.requireAck));
});

test("reads come after posting, and only entries asking for one are acknowledged", () => {
	const random = makeRandom(4);
	const updates = buildUpdates(random, { now, people, reports, pages }, 80);
	const reads = buildReads(random, updates, people, now);
	assert.ok(reads.length > 0);
	for (const read of reads) {
		const update = updates[read.index - 1];
		assert.ok(read.readOn >= update.postedOn);
		if (read.ackedOn) assert.ok(update.input.requireAck);
	}
});

test("follows are two to five a person with no repeats", () => {
	const follows = buildFollows(makeRandom(2), people);
	for (const email of people) {
		const own = follows.filter((f) => f.email === email);
		assert.ok(own.length >= 2 && own.length <= 5);
		assert.equal(
			new Set(own.map((f) => `${f.kind}|${f.value}`)).size,
			own.length,
		);
	}
});

test("every rule compiles against its demo table", () => {
	const rules = buildRules(
		makeRandom(1),
		(key) => `demo.schema_of.${key}`,
		() => ["One", "Two"],
		people,
	);
	assert.equal(rules.length, Object.values(ruleSpecs).flat().length);
	for (const [sourceKey, specs] of Object.entries(ruleSpecs)) {
		assert.ok(specs.length >= 6 && specs.length <= 10, sourceKey);
	}
	for (const rule of rules) {
		if (rule.spec.kind === "allowedValues") {
			assert.deepEqual(rule.spec.params.values, ["One", "Two"]);
		}
	}
});

test("rule history has a run a day and opens an incident only on failures", () => {
	const random = makeRandom(8);
	const rules = Array.from({ length: 12 }, () => ({
		kind: "notBlank" as const,
		severity: "warning" as const,
		rowCount: 1000,
		groupLabels: [],
	}));
	const { runs, incidents } = buildRuleRuns(random, rules, 90, now, [0, 5]);
	assert.equal(runs.length, 12 * 90);
	for (const index of [0, 5]) {
		const latest = runs.filter((run) => run.ruleIndex === index).at(-1)!;
		assert.equal(latest.status, "fail");
		assert.ok(
			incidents.some(
				(i) => i.ruleIndex === index && i.resolvedOn === null,
			),
		);
	}
	const open = incidents
		.filter((i) => i.resolvedOn === null)
		.map((i) => i.ruleIndex);
	assert.deepEqual(open.sort(), [0, 5]);
	assert.ok(
		runs.filter((run) => run.status === "pass").length > runs.length * 0.85,
	);
	assert.ok(failureDays(makeRandom(1), 90, true).has(0));
});

test("goals take measures from their report and lower is better for costs", () => {
	const goals = buildGoals(
		makeRandom(6),
		[
			{
				reportId: "r1",
				measures: [
					{ sourceKey: "sales_orders", measure: "Revenue" },
					{ sourceKey: "sales_orders", measure: "Orders" },
					{ sourceKey: "sales_orders", measure: "Gross Margin" },
				],
			},
			{ reportId: "r2", measures: [] },
		],
		people,
		() => [{ field: "Region", values: ["Europe"] }],
	);
	assert.ok(goals.length >= 2 && goals.length <= 3);
	assert.ok(goals.every((goal) => goal.reportId === "r1"));
	assert.equal(lowerIsBetter("Cost per Conversion"), true);
	assert.equal(lowerIsBetter("Revenue"), false);
});

test("decks survive the server's cleaning unchanged", () => {
	const random = makeRandom(12);
	const report = {
		reportId: "r1",
		title: "One",
		pages: [
			{
				pageId: "p1",
				title: "Overview",
				visuals: [1, 2, 3].map((n) => ({
					visualId: `v${n}`,
					title: `Visual ${n}`,
				})),
			},
			{
				pageId: "p2",
				title: "Detail",
				visuals: [{ visualId: "v9", title: null }],
			},
		],
	};
	for (const kind of ["walkthrough", "slides"] as const) {
		const deck = buildDeck(random, report, kind);
		assert.equal(deck.kind, kind);
		assert.ok(deck.steps.length > 0);
		assert.deepEqual(
			cleanDeckInput(deck, () => "unused"),
			deck,
		);
	}
});
