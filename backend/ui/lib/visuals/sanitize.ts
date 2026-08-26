// Sanitises rich text before it is stored or rendered.
//
// A text panel is authored by one person and read by everyone else, so its
// content is untrusted input on the way in and on the way out. Anything an
// editor pastes from a browser or another document arrives carrying whatever
// markup that source produced, which is where script injection would enter.
//
// The approach is an allow-list: unknown elements are unwrapped rather than
// dropped, so pasting from a word processor keeps the words even when the
// wrapper is discarded. A deny-list would have to anticipate every tag and
// attribute that could carry script, which is not a list anyone finishes.

const allowedTags = new Set([
	"p",
	"br",
	"hr",
	"div",
	"span",
	"h1",
	"h2",
	"h3",
	"h4",
	"strong",
	"b",
	"em",
	"i",
	"u",
	"s",
	"code",
	"pre",
	"ul",
	"ol",
	"li",
	"blockquote",
	"a",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
]);

// Style properties an author can set. Anything else, including position and
// anything that could load a URL, is dropped.
const allowedStyleProperties = new Set([
	"color",
	"background-color",
	"font-size",
	"font-weight",
	"font-style",
	"text-align",
	"text-decoration",
]);

// Rejects url(), expression() and anything else that could fetch or execute.
// Values are simple literals: a colour, a length, a keyword.
const safeStyleValue = /^[#a-zA-Z0-9\s.,()%-]*$/;

function sanitizeStyle(value: string): string {
	const kept: string[] = [];

	for (const declaration of value.split(";")) {
		const [rawProperty, ...rest] = declaration.split(":");
		if (rest.length === 0) continue;

		const property = rawProperty.trim().toLowerCase();
		const propertyValue = rest.join(":").trim();

		if (!allowedStyleProperties.has(property)) continue;
		if (!safeStyleValue.test(propertyValue)) continue;
		// url() would fetch, and behaviours would execute, regardless of which
		// property carries them.
		if (/url\s*\(|expression\s*\(|javascript:/i.test(propertyValue))
			continue;

		kept.push(`${property}: ${propertyValue}`);
	}

	return kept.join("; ");
}

function sanitizeHref(value: string): string | null {
	const trimmed = value.trim();
	// Relative links and fragments are fine. Of the absolute schemes, only
	// http, https and mailto are; javascript: and data: are how a link becomes
	// an execution vector.
	if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[/#]/.test(trimmed)) return trimmed;
	return null;
}

// Browser-side sanitiser. Parses into a detached document so nothing runs, and
// rebuilds the tree keeping only what is allowed.
export function sanitizeHtml(input: string): string {
	if (typeof window === "undefined" || typeof DOMParser === "undefined") {
		// No DOM, so no allow-list, so no markup. See the note on
		// escapeToText: the server render is what reaches the browser first,
		// and it must not carry anything a parser could read as a tag.
		return escapeToText(input);
	}

	const parsed = new DOMParser().parseFromString(
		`<div id="root">${input}</div>`,
		"text/html",
	);
	const root = parsed.getElementById("root");
	if (!root) return "";

	const clean = (node: Node): Node[] => {
		if (node.nodeType === Node.TEXT_NODE) {
			return [document.createTextNode(node.textContent ?? "")];
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return [];

		const element = node as Element;
		const tag = element.tagName.toLowerCase();
		const children = Array.from(element.childNodes).flatMap(clean);

		// An element that is not allowed is unwrapped rather than removed, so
		// pasted content keeps its text even when the wrapper goes.
		if (!allowedTags.has(tag)) return children;

		const replacement = document.createElement(tag);

		const style = element.getAttribute("style");
		if (style) {
			const safe = sanitizeStyle(style);
			if (safe) replacement.setAttribute("style", safe);
		}

		if (tag === "a") {
			const href = element.getAttribute("href");
			const safe = href ? sanitizeHref(href) : null;
			if (safe) {
				replacement.setAttribute("href", safe);
				// External links open away from the app, and noopener stops
				// the opened page reaching back through window.opener.
				replacement.setAttribute("target", "_blank");
				replacement.setAttribute("rel", "noopener noreferrer");
			}
		}

		for (const child of children) replacement.appendChild(child);
		return [replacement];
	};

	const container = document.createElement("div");
	for (const child of Array.from(root.childNodes).flatMap(clean)) {
		container.appendChild(child);
	}
	return container.innerHTML;
}

// Server-side fallback: the text, with every character that could begin markup
// escaped so it cannot.
//
// This used to strip tags with regular expressions, which is the thing the note
// at the top of this file says nobody finishes. It did not finish. An
// unterminated tag has no closing bracket, so `<[^>]+>` does not match it and
// `<img src=x onerror=alert(1)` passed through whole. In a server render that
// string is not at the end of anything: the rest of the document follows it, the
// parser goes on looking for the bracket, finds one further down the page, and
// closes the tag with the handler intact.
//
// Escaping has no such edge. Nothing here can start a tag, so there is no
// grammar left to get wrong. The cost is that a server-rendered panel shows its
// text unformatted for the moment before the browser sanitises it properly,
// which is why the panel renders this only until it has mounted.
function escapeToText(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// Plain text for a server render, with the markup dropped rather than escaped
// into view. Only ever used as text content, never as markup.
function textOnlyFallback(input: string): string {
	return input
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]*>?/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Plain text for previews and search, with entities resolved.
export function toPlainText(html: string): string {
	if (typeof window === "undefined" || typeof DOMParser === "undefined") {
		// Text, not markup: the caller renders this as a string. The trailing
		// `>?` matters, so an unterminated tag at the end is dropped too.
		return textOnlyFallback(html);
	}
	const parsed = new DOMParser().parseFromString(html, "text/html");
	return parsed.body.textContent?.trim() ?? "";
}
