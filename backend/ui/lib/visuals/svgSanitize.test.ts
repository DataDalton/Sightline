import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeSvg } from "./svgSanitize";

// An uploaded logo ends up in the document of every page, seen by everyone.
// These are the cases that decide whether that is safe, so they are pinned
// rather than assumed.

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
	<path d="M4 20h16" fill="#ff0000" stroke="#000000"/>
	<circle cx="12" cy="8" r="4" fill="#00ff00"/>
</svg>`;

test("an ordinary mark survives with its shapes intact", () => {
	const result = sanitizeSvg(mark);
	assert.ok(result);
	assert.ok(result.markup.includes("<path"));
	assert.ok(result.markup.includes("<circle"));
	assert.ok(result.markup.includes('viewBox="0 0 24 24"'.toLowerCase()) ||
		result.markup.includes('viewbox="0 0 24 24"'));
});

test("a script is removed along with everything inside it", () => {
	const result = sanitizeSvg(
		`<svg viewBox="0 0 10 10"><script>fetch("/steal")</script><path d="M0 0"/></svg>`,
	);
	assert.ok(result);
	assert.ok(!result.markup.includes("script"));
	assert.ok(!result.markup.includes("steal"));
	assert.ok(result.markup.includes("<path"));
	assert.ok(result.removedElements.includes("script"));
});

test("an event handler does not survive", () => {
	const result = sanitizeSvg(
		`<svg viewBox="0 0 10 10"><path d="M0 0" onload="alert(1)" onclick="alert(2)"/></svg>`,
	);
	assert.ok(result);
	assert.ok(!result.markup.toLowerCase().includes("onload"));
	assert.ok(!result.markup.toLowerCase().includes("onclick"));
	assert.ok(result.markup.includes('d="M0 0"'));
});

test("foreign content and embedded images are dropped", () => {
	const result = sanitizeSvg(
		`<svg viewBox="0 0 10 10"><foreignObject><iframe src="http://elsewhere"></iframe></foreignObject><image href="http://elsewhere/x.png"/><path d="M1 1"/></svg>`,
	);
	assert.ok(result);
	assert.ok(!result.markup.toLowerCase().includes("foreignobject"));
	assert.ok(!result.markup.toLowerCase().includes("iframe"));
	assert.ok(!result.markup.toLowerCase().includes("image"));
	assert.ok(!result.markup.includes("elsewhere"));
});

test("an entity declaration cannot reach a file on the server", () => {
	const result = sanitizeSvg(
		`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 10 10"><path d="M0 0"/></svg>`,
	);
	assert.ok(result);
	assert.ok(!result.markup.includes("ENTITY"));
	assert.ok(!result.markup.includes("passwd"));
});

test("a javascript link is not a colour", () => {
	const result = sanitizeSvg(
		`<svg viewBox="0 0 10 10"><path d="M0 0" fill="url(javascript:alert(1))"/></svg>`,
	);
	assert.ok(result);
	assert.ok(!result.markup.includes("javascript"));
});

test("adapting replaces the colours so the mark follows the theme", () => {
	const result = sanitizeSvg(mark, { adaptive: true });
	assert.ok(result);
	assert.ok(!result.markup.includes("#ff0000"));
	assert.ok(!result.markup.includes("#00ff00"));
	assert.ok(!result.markup.includes("#000000"));
	assert.ok(result.markup.includes('fill="currentColor"'));
});

test("adapting leaves a shape that was already meant to be invisible", () => {
	const result = sanitizeSvg(
		`<svg viewBox="0 0 10 10"><path d="M0 0" fill="none" stroke="currentColor"/></svg>`,
		{ adaptive: true },
	);
	assert.ok(result);
	assert.ok(result.markup.includes('fill="none"'));
});

test("keeping the colours is what happens when adapting is off", () => {
	const result = sanitizeSvg(mark);
	assert.ok(result);
	assert.ok(result.markup.includes("#ff0000"));
});

test("something that is not an SVG is refused rather than repaired", () => {
	assert.equal(sanitizeSvg("<html><body>hello</body></html>"), null);
	assert.equal(sanitizeSvg(""), null);
	assert.equal(sanitizeSvg("not markup at all"), null);
});
