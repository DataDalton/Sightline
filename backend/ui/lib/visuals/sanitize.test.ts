import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeHtml, toPlainText } from "./sanitize";

// These run without a DOM, which is the branch that produces the server render.
// That output is the first thing a browser parses, so it is the one that has to
// be right: the allow-list sanitiser only gets to run after hydration.
//
// The rule this pins down is that the server never emits markup. Not "emits
// safe markup" — none. Anything else means deciding which tags are safe with
// regular expressions, and the way that failed here is instructive: an
// unterminated tag has no closing bracket, so a strip that matches `<[^>]+>`
// never sees it, and in a document the parser simply keeps reading until it
// finds a bracket further down the page.

const startsATag = /<[a-zA-Z!/]/;

test("no server-rendered output can begin a tag", () => {
	const attempts = [
		"<img src=x onerror=alert(1)>",
		// No closing bracket. The one that got through.
		"<img src=x onerror=alert(1)",
		"<svg onload=alert(1)",
		"<script>alert(1)",
		"<script>alert(1)</script>",
		// A bracket inside an attribute ends a naive match early.
		'<img src="x" onerror="alert(1)" alt=">">',
		// Removing the inner match leaves the outer one looking harmless.
		"<scr<script>ipt>alert(1)</script>",
		"<!--<img src=x onerror=alert(1)>-->",
		'<a href="javascript:alert(1)">click</a>',
		"<iframe srcdoc='<script>alert(1)</script>'>",
	];

	for (const attempt of attempts) {
		const rendered = sanitizeHtml(attempt);
		assert.ok(
			!startsATag.test(rendered),
			`markup survived the server path: ${JSON.stringify(rendered)}`,
		);
	}
});

test("the words survive even though the markup does not", () => {
	const rendered = sanitizeHtml("Revenue is <strong>up</strong> 12%");
	assert.ok(rendered.includes("Revenue is"));
	assert.ok(rendered.includes("12%"));
});

test("an ampersand is escaped before the brackets are, not after", () => {
	// Escaping < first and & second would turn &lt; back into a bracket.
	assert.equal(sanitizeHtml("&lt;img src=x>"), "&amp;lt;img src=x&gt;");
});

test("plain text drops an unterminated tag rather than keeping its attributes", () => {
	// This one is read as text by its caller, so what matters is that the
	// handler does not survive as readable content either.
	const text = toPlainText("Totals <img src=x onerror=alert(1)");
	assert.ok(!text.includes("onerror"), text);
	assert.ok(text.includes("Totals"));
});

test("plain text keeps the words and drops the tags", () => {
	assert.equal(
		toPlainText("<p>Revenue is <strong>up</strong></p>"),
		"Revenue is up",
	);
});
