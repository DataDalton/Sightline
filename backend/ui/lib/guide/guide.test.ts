import { test } from "node:test";
import assert from "node:assert/strict";
import {
	dropUnfinished,
	guideText,
	headingsOf,
	linkTarget,
	parseGuide,
	parseInline,
	plainText,
} from "./markdown";
import { mentionedFields, renameField } from "./mentions";
import { diffLines } from "./diff";

test("links are kept only when they go somewhere safe", () => {
	assert.deepEqual(linkTarget("https://example.com/a"), {
		kind: "external",
		href: "https://example.com/a",
	});
	assert.deepEqual(linkTarget("mailto:team@example.com"), {
		kind: "external",
		href: "mailto:team@example.com",
	});
	assert.deepEqual(linkTarget("/r/sales"), {
		kind: "internal",
		href: "/r/sales",
	});
	assert.deepEqual(linkTarget("#which-number"), {
		kind: "anchor",
		href: "which-number",
	});
	assert.deepEqual(linkTarget("file:Validation.pdf"), {
		kind: "file",
		href: "Validation.pdf",
	});
	assert.equal(linkTarget("javascript:alert(1)"), null);
	assert.equal(linkTarget("//evil.example.com"), null);
	assert.equal(linkTarget("data:text/html,hi"), null);
});

test("an unsafe link keeps its words and loses its target", () => {
	const parts = parseInline("see [here](javascript:alert(1)) now");
	assert.equal(
		parts.some((part) => part.t === "link"),
		false,
	);
	assert.equal(plainText(parts).includes("here"), true);
});

test("inline formatting nests inside links and emphasis", () => {
	const parts = parseInline("Use **Addressable** and [the `rules`](#rules)");
	assert.equal(parts[1].t, "strong");
	const link = parts.find((part) => part.t === "link");
	assert.ok(link && link.t === "link");
	assert.equal(link.kind, "anchor");
	assert.equal(plainText(link.c), "the rules");
});

test("blocks are read in order with unique heading anchors", () => {
	const blocks = parseGuide(
		[
			"# What this report is for",
			"",
			"It sizes the opportunity.",
			"Second line of the same paragraph.",
			"",
			"## Notes",
			"- one",
			"- two",
			"",
			"## Notes",
			"1. first",
			"2. second",
			"",
			"> Quote line",
			"",
			"| Term | Meaning |",
			"| --- | --- |",
			"| A | B |",
			"",
			"```",
			"code **not bold**",
			"```",
			"---",
		].join("\n"),
	);
	assert.deepEqual(
		blocks.map((block) => block.t),
		[
			"heading",
			"paragraph",
			"heading",
			"list",
			"heading",
			"list",
			"quote",
			"table",
			"code",
			"rule",
		],
	);
	const headings = headingsOf(blocks);
	assert.deepEqual(
		headings.map((heading) => heading.id),
		["what-this-report-is-for", "notes", "notes-2"],
	);
	const paragraph = blocks[1];
	assert.ok(paragraph.t === "paragraph");
	assert.equal(
		plainText(paragraph.c),
		"It sizes the opportunity. Second line of the same paragraph.",
	);
	const code = blocks[8];
	assert.ok(code.t === "code");
	assert.equal(code.v, "code **not bold**");
});

test("an unclosed code fence takes the rest of the text", () => {
	const blocks = parseGuide("```\nline one\nline two");
	assert.equal(blocks.length, 1);
	assert.ok(blocks[0].t === "code");
	assert.equal(blocks[0].v, "line one\nline two");
});

test("guide text flattens every block for search", () => {
	const text = guideText(
		parseGuide(
			"# Title\n\n- **Bold** item\n\n| a | b |\n| - | - |\n| c | d |",
		),
	);
	assert.equal(text, "Title\nBold item\na | b\nc | d");
});

test("a field inside a longer field name is not counted", () => {
	const names = ["Opportunity", "Weighted Opportunity", "Sales"];
	assert.deepEqual(
		mentionedFields("Weighted Opportunity is part of the total.", names),
		["Weighted Opportunity"],
	);
	assert.deepEqual(
		mentionedFields(
			"Opportunity and weighted opportunity both appear, unlike Salesforce.",
			names,
		),
		["Opportunity", "Weighted Opportunity"],
	);
});

test("renaming a field leaves longer names that contain it alone", () => {
	const names = ["Opportunity", "Weighted Opportunity"];
	assert.equal(
		renameField(
			"Opportunity, then Weighted Opportunity, then opportunity.",
			"Opportunity",
			"Gap",
			names,
		),
		"Gap, then Weighted Opportunity, then Gap.",
	);
	assert.equal(
		renameField("Nothing here.", "Opportunity", "Gap", names),
		"Nothing here.",
	);
});

test("a line the writer stopped partway through is dropped", () => {
	assert.deepEqual(
		dropUnfinished(
			"## Things to know\n\n- **Capacity.** Latest year only.\n- **Coverage.",
		),
		{
			text: "## Things to know\n\n- **Capacity.** Latest year only.",
			cut: true,
		},
	);
	assert.deepEqual(
		dropUnfinished(
			"Intro.\n\n## Things to know\n\n- Covers the latest year and",
		),
		{ text: "Intro.", cut: true },
	);
	assert.deepEqual(dropUnfinished("Done.\n\n| a | b |\n"), {
		text: "Done.\n\n| a | b |",
		cut: false,
	});
	assert.deepEqual(dropUnfinished("- **Bold** item ends here."), {
		text: "- **Bold** item ends here.",
		cut: false,
	});
});

test("a changed guide reads as kept, added and removed lines", () => {
	assert.deepEqual(
		diffLines(
			"## Terms\n\n- Sales is booked.\n- Opportunity is the gap.",
			"## Terms\n\n- Sales is invoiced.\n- Opportunity is the gap.\n- Weighted is likely.",
		),
		[
			{ kind: "same", text: "## Terms" },
			{ kind: "removed", text: "- Sales is booked." },
			{ kind: "added", text: "- Sales is invoiced." },
			{ kind: "same", text: "- Opportunity is the gap." },
			{ kind: "added", text: "- Weighted is likely." },
		],
	);
	assert.deepEqual(diffLines("", "One line."), [
		{ kind: "added", text: "One line." },
	]);
	assert.deepEqual(diffLines("Same.\n\n", "Same."), [
		{ kind: "same", text: "Same." },
	]);
});
