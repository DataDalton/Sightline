import { test } from "node:test";
import assert from "node:assert/strict";
import {
	changesBetween,
	defaultConfig,
	duplicateAt,
	formatKey,
	likeness,
	numberOfKey,
	ownersFor,
	refuseMove,
	withDefaults,
	type ItemFacts,
	type WorkConfig,
} from "./model";

const item: ItemFacts = {
	status: "backlog",
	workType: "newField",
	priority: "high",
	effort: "fewDays",
	domain: null,
	layer: null,
	assignees: [],
	reviewer: null,
	approver: null,
	approved: false,
	securityReviewed: false,
	target: null,
	criteria: 0,
	closed: false,
};
const engineer = { engineer: true, devSecOps: false };
const devSecOps = { engineer: false, devSecOps: true };

function config(change: (c: WorkConfig) => void): WorkConfig {
	const copy = withDefaults(JSON.parse(JSON.stringify(defaultConfig)));
	change(copy);
	return copy;
}

test("the defaults are generic, with layers and domains empty", () => {
	assert.equal(defaultConfig.layers.length, 0);
	assert.equal(defaultConfig.domains.length, 0);
	assert.deepEqual(
		defaultConfig.columns.map((c) => c.id),
		[
			"new",
			"needsInfo",
			"backlog",
			"ready",
			"inProgress",
			"inReview",
			"validating",
			"readyToDeploy",
			"done",
		],
	);
	assert.equal(defaultConfig.rules.approval.enabled, false);
	assert.equal(defaultConfig.rules.autoAssign, false);
	assert.equal(defaultConfig.rules.onlyDevSecOpsDeploys, false);
	assert.equal(defaultConfig.rules.securityReview.enabled, false);
});

test("effort is named by time, and every span is ordered", () => {
	const labels = defaultConfig.efforts.map((e) => e.label);
	assert.deepEqual(labels, [
		"Under an hour",
		"Half a day",
		"A day",
		"A few days",
		"A week or two",
		"A few weeks",
		"Over a month",
	]);
	for (let i = 1; i < defaultConfig.efforts.length; i++) {
		assert.ok(
			defaultConfig.efforts[i].minHours >=
				defaultConfig.efforts[i - 1].minHours,
		);
	}
});

test("a stored configuration keeps the defaults it does not mention", () => {
	const merged = withDefaults({
		prefix: "DE",
		rules: { autoAssign: true } as never,
	});
	assert.equal(merged.prefix, "DE");
	assert.equal(merged.rules.autoAssign, true);
	assert.equal(merged.rules.approval.enabled, false);
	assert.equal(merged.columns.length, 9);
});

test("keys read both ways", () => {
	assert.equal(formatKey("DE", 142), "DE-142");
	assert.equal(numberOfKey("DE-142"), 142);
	assert.equal(numberOfKey("de-7"), 7);
	assert.equal(numberOfKey("142"), null);
});

test("only engineers move requests, and only into real columns", () => {
	assert.match(
		refuseMove(
			item,
			"inProgress",
			{ engineer: false, devSecOps: false },
			defaultConfig,
		) ?? "",
		/engineers/,
	);
	assert.match(
		refuseMove(item, "nowhere", engineer, defaultConfig) ?? "",
		/not a column/,
	);
	assert.equal(refuseMove(item, "inProgress", engineer, defaultConfig), null);
	assert.match(
		refuseMove(
			{ ...item, closed: true },
			"backlog",
			engineer,
			defaultConfig,
		) ?? "",
		/Reopen/,
	);
});

test("required fields are asked for by name", () => {
	const strict = config((c) => {
		c.rules.required.ready = ["criteria", "assignees"];
	});
	assert.equal(
		refuseMove(item, "ready", engineer, strict),
		"It needs acceptance criteria, somebody assigned first.",
	);
	assert.equal(
		refuseMove(
			{ ...item, criteria: 2, assignees: ["a@x.com"] },
			"ready",
			engineer,
			strict,
		),
		null,
	);
});

test("approval holds back work only when switched on and the size calls for it", () => {
	assert.equal(refuseMove(item, "inProgress", engineer, defaultConfig), null);
	const approving = config((c) => {
		c.rules.approval = {
			enabled: true,
			efforts: ["fewWeeks", "overMonth"],
			workTypes: [],
		};
	});
	assert.equal(refuseMove(item, "inProgress", engineer, approving), null);
	const big = { ...item, effort: "fewWeeks" };
	assert.match(
		refuseMove(big, "inProgress", engineer, approving) ?? "",
		/approval/,
	);
	assert.match(
		refuseMove(big, "done", engineer, approving) ?? "",
		/approval/,
	);
	assert.equal(refuseMove(big, "ready", engineer, approving), null);
	assert.equal(
		refuseMove(
			{ ...big, approved: true },
			"inProgress",
			engineer,
			approving,
		),
		null,
	);
});

test("security review and deploying are DevSecOps rules, off by default", () => {
	const secure = config((c) => {
		c.rules.securityReview = { enabled: true, workTypes: ["newData"] };
		c.rules.onlyDevSecOpsDeploys = true;
	});
	const data = { ...item, workType: "newData", status: "validating" };
	assert.match(
		refuseMove(data, "readyToDeploy", engineer, secure) ?? "",
		/security review/,
	);
	assert.equal(
		refuseMove(
			{ ...data, securityReviewed: true },
			"readyToDeploy",
			engineer,
			secure,
		),
		null,
	);
	assert.match(
		refuseMove(
			{ ...data, securityReviewed: true },
			"done",
			engineer,
			secure,
		) ?? "",
		/DevSecOps/,
	);
	assert.equal(
		refuseMove(
			{ ...data, securityReviewed: true },
			"done",
			devSecOps,
			secure,
		),
		null,
	);
});

test("allowed moves name where it can go", () => {
	const narrow = config((c) => {
		c.rules.allowedMoves = { backlog: ["ready"] };
	});
	assert.equal(
		refuseMove(item, "done", engineer, narrow),
		"From Backlog it can only move to Ready.",
	);
	assert.equal(refuseMove(item, "ready", engineer, narrow), null);
});

test("auto-assign goes to the domain's owners, else the layer's, and only when on", () => {
	const owned = config((c) => {
		c.owners.domains.sales = ["sam@x.com"];
		c.owners.layers.reporting = ["lee@x.com"];
	});
	assert.deepEqual(ownersFor(owned, "sales", "reporting"), []);
	owned.rules.autoAssign = true;
	assert.deepEqual(ownersFor(owned, "sales", "reporting"), ["sam@x.com"]);
	assert.deepEqual(ownersFor(owned, "finance", "reporting"), ["lee@x.com"]);
	assert.deepEqual(ownersFor(owned, null, null), []);
});

test("changes are listed field by field, and order in a list does not count", () => {
	const changes = changesBetween(
		{ priority: "low", tags: ["a", "b"], assignees: ["x"] },
		{ priority: "high", tags: ["b", "a"], assignees: ["x", "y"] },
	);
	assert.deepEqual(changes, [
		{ field: "priority", from: "low", to: "high" },
		{ field: "assignees", from: ["x"], to: ["x", "y"] },
	]);
	assert.deepEqual(changesBetween({ priority: "low" }, {}), []);
});

test("requests about the same thing read as likely duplicates", () => {
	const a = {
		title: "Add discount band to sales orders",
		description: "We need the discount band field",
		sources: ["orders"],
	};
	const b = {
		title: "Discount band field on sales orders",
		description: "Please add discount band",
		sources: ["orders"],
	};
	const c = {
		title: "Warehouse dashboard is slow",
		description: "Takes a minute to load",
		sources: ["shipments"],
	};
	assert.ok(likeness(a, b) >= duplicateAt);
	assert.ok(likeness(a, c) < duplicateAt);
	assert.equal(likeness({ title: "", description: "", sources: [] }, a), 0);
});
