import assert from "node:assert/strict";
import { test } from "node:test";
import { scrollRootFor, type ScrollNode, type ScrollStyle } from "./lazyLoad";

interface FakeNode extends ScrollNode {
	name: string;
	style: ScrollStyle;
	parentElement: FakeNode | null;
}

function node(
	name: string,
	parent: FakeNode | null,
	style: Partial<ScrollStyle> = {},
	heights: { scroll?: number; client?: number } = {},
): FakeNode {
	return {
		name,
		parentElement: parent,
		style: { overflowY: "visible", position: "static", ...style },
		scrollHeight: heights.scroll ?? 100,
		clientHeight: heights.client ?? 100,
	};
}

const styleOf = (n: FakeNode) => n.style;

test("the ancestor that scrolls is the root", () => {
	const body = node("body", null);
	const main = node(
		"main",
		body,
		{ overflowY: "auto" },
		{ scroll: 3000, client: 800 },
	);
	const grid = node("grid", main, { position: "relative" });
	const frame = node("frame", grid, { position: "absolute" });
	assert.equal(scrollRootFor(frame, styleOf)?.name, "main");
});

test("an ancestor that could scroll but holds nothing extra is passed over", () => {
	const body = node("body", null);
	const main = node(
		"main",
		body,
		{ overflowY: "auto" },
		{ scroll: 3000, client: 800 },
	);
	const groupBody = node(
		"groupBody",
		main,
		{ overflowY: "auto" },
		{ scroll: 400, client: 400 },
	);
	const frame = node("frame", groupBody);
	assert.equal(scrollRootFor(frame, styleOf)?.name, "main");
});

test("a scroller nested inside the page scroller gives way to it", () => {
	const main = node(
		"main",
		null,
		{ overflowY: "auto" },
		{ scroll: 3000, client: 800 },
	);
	const groupBody = node(
		"groupBody",
		main,
		{ overflowY: "auto" },
		{ scroll: 900, client: 300 },
	);
	const frame = node("frame", groupBody);
	assert.equal(scrollRootFor(frame, styleOf)?.name, "main");
});

test("with no scrolling ancestor the viewport is the root", () => {
	const body = node("body", null);
	const frame = node("frame", body);
	assert.equal(scrollRootFor(frame, styleOf), null);
});

test("a fixed ancestor that does not scroll ends the search at the viewport", () => {
	const main = node(
		"main",
		null,
		{ overflowY: "auto" },
		{ scroll: 3000, client: 800 },
	);
	const dialog = node("dialog", main, { position: "fixed" });
	const frame = node("frame", dialog);
	assert.equal(scrollRootFor(frame, styleOf), null);
});

test("a fixed ancestor that scrolls is the root, whatever is outside it", () => {
	const main = node(
		"main",
		null,
		{ overflowY: "auto" },
		{ scroll: 3000, client: 800 },
	);
	const dialog = node(
		"dialog",
		main,
		{ position: "fixed", overflowY: "scroll" },
		{ scroll: 2000, client: 600 },
	);
	const frame = node("frame", dialog);
	assert.equal(scrollRootFor(frame, styleOf)?.name, "dialog");
});

test("a fixed element is measured against the viewport", () => {
	const main = node(
		"main",
		null,
		{ overflowY: "auto" },
		{ scroll: 3000, client: 800 },
	);
	const frame = node("frame", main, { position: "fixed" });
	assert.equal(scrollRootFor(frame, styleOf), null);
});

test("the document body is left to the viewport", () => {
	const html = node(
		"html",
		null,
		{ overflowY: "auto" },
		{ scroll: 900, client: 800 },
	);
	const body = node(
		"body",
		html,
		{ overflowY: "auto" },
		{ scroll: 900, client: 800 },
	);
	const frame = node("frame", body);
	const isDocument = (n: FakeNode) => n.name === "html" || n.name === "body";
	assert.equal(scrollRootFor(frame, styleOf, isDocument), null);
});
