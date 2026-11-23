// The Markdown a report guide is written in, read into blocks a page can draw.
//
// Parsed into data rather than turned into HTML, so nothing an author or the
// assistant writes is ever read as markup. Links are kept only when they go
// somewhere safe: the web, mail, a page of this app, a heading in the same
// guide, or a file attached to it. Anything else stays as its text.

export type Inline =
	| { t: "text"; v: string }
	| { t: "strong"; c: Inline[] }
	| { t: "em"; c: Inline[] }
	| { t: "code"; v: string }
	| { t: "link"; kind: LinkKind; href: string; c: Inline[] };

export type LinkKind = "external" | "internal" | "anchor" | "file";

export type Block =
	| { t: "heading"; level: 1 | 2 | 3 | 4; id: string; c: Inline[] }
	| { t: "paragraph"; c: Inline[] }
	| { t: "list"; ordered: boolean; items: Inline[][] }
	| { t: "table"; head: Inline[][]; rows: Inline[][][] }
	| { t: "quote"; c: Inline[][] }
	| { t: "code"; v: string }
	| { t: "rule" };

export interface Heading {
	level: 1 | 2 | 3 | 4;
	id: string;
	text: string;
}

// The longest guide kept. Long enough for a full handbook, short enough that
// reading one into the assistant's context does not crowd out the question.
export const maxGuideLength = 50_000;

// Where a link goes, or null when it goes nowhere this app opens.
export function linkTarget(
	raw: string,
): { kind: LinkKind; href: string } | null {
	const href = raw.trim();
	if (/^https?:\/\/[^\s]+$/i.test(href)) return { kind: "external", href };
	if (/^mailto:[^\s]+$/i.test(href)) return { kind: "external", href };
	if (/^#[\w-]+$/.test(href)) return { kind: "anchor", href: href.slice(1) };
	if (/^file:.+$/i.test(href))
		return { kind: "file", href: href.slice(5).trim() };
	// A path in this app, never one that leaves it.
	if (/^\/(?!\/)[^\s]*$/.test(href) && !href.includes("\\"))
		return { kind: "internal", href };
	return null;
}

const inlinePattern =
	/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

export function parseInline(text: string): Inline[] {
	const out: Inline[] = [];
	let last = 0;
	let match: RegExpExecArray | null;
	const pattern = new RegExp(inlinePattern.source, "g");
	while ((match = pattern.exec(text))) {
		if (match.index > last)
			out.push({ t: "text", v: text.slice(last, match.index) });
		const token = match[0];
		if (token.startsWith("**")) {
			out.push({ t: "strong", c: parseInline(token.slice(2, -2)) });
		} else if (token.startsWith("`")) {
			out.push({ t: "code", v: token.slice(1, -1) });
		} else if (token.startsWith("[")) {
			const parts = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
			const target = parts ? linkTarget(parts[2]) : null;
			if (parts && target) {
				out.push({ t: "link", ...target, c: parseInline(parts[1]) });
			} else {
				out.push({ t: "text", v: parts ? parts[1] : token });
			}
		} else {
			out.push({ t: "em", c: parseInline(token.slice(1, -1)) });
		}
		last = match.index + token.length;
	}
	if (last < text.length) out.push({ t: "text", v: text.slice(last) });
	return out;
}

// Plain text of inline content, for anchors, search and the assistant.
export function plainText(inline: Inline[]): string {
	return inline
		.map((part) =>
			part.t === "text" || part.t === "code" ? part.v : plainText(part.c),
		)
		.join("");
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.slice(0, 60) || "section"
	);
}

function cells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

// Every line break a writer can produce, read as a newline. Written as
// escapes because the two Unicode separators end a line in source too.
const lineBreaks = new RegExp("\r\n?|[\u2028\u2029]", "g");
const bullet = /^\s*[-*+]\s+/;
const numbered = /^\s*\d+[.)]\s+/;
const headingLine = /^(#{1,4})\s+(.*)$/;
const ruleLine = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const fence = /^\s*```/;
// The row of dashes under a table's header, one cell per column, each
// optionally marked with colons for alignment.
const tableDivider = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function parseGuide(text: string): Block[] {
	const lines = text.replace(lineBreaks, "\n").split("\n");
	const blocks: Block[] = [];
	const used = new Map<string, number>();
	let i = 0;

	const startsBlock = (line: string) =>
		headingLine.test(line) ||
		ruleLine.test(line) ||
		fence.test(line) ||
		bullet.test(line) ||
		numbered.test(line) ||
		line.trimStart().startsWith(">");

	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}

		if (fence.test(line)) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !fence.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			// Past the closing fence, or the end when it was never closed.
			i++;
			blocks.push({ t: "code", v: body.join("\n") });
			continue;
		}

		if (ruleLine.test(line)) {
			blocks.push({ t: "rule" });
			i++;
			continue;
		}

		const heading = headingLine.exec(line);
		if (heading) {
			const content = parseInline(heading[2].trim());
			const base = slug(plainText(content));
			const seen = used.get(base) ?? 0;
			used.set(base, seen + 1);
			blocks.push({
				t: "heading",
				level: heading[1].length as 1 | 2 | 3 | 4,
				id: seen === 0 ? base : `${base}-${seen + 1}`,
				c: content,
			});
			i++;
			continue;
		}

		// A table is a header row, a divider row of dashes, then rows.
		if (
			line.includes("|") &&
			i + 1 < lines.length &&
			tableDivider.test(lines[i + 1])
		) {
			const head = cells(line).map(parseInline);
			const rows: Inline[][][] = [];
			i += 2;
			while (i < lines.length && lines[i].includes("|")) {
				rows.push(cells(lines[i]).map(parseInline));
				i++;
			}
			blocks.push({ t: "table", head, rows });
			continue;
		}

		if (line.trimStart().startsWith(">")) {
			const quoted: Inline[][] = [];
			while (i < lines.length && lines[i].trimStart().startsWith(">")) {
				const content = lines[i].trimStart().replace(/^>\s?/, "");
				if (content.trim()) quoted.push(parseInline(content));
				i++;
			}
			blocks.push({ t: "quote", c: quoted });
			continue;
		}

		if (bullet.test(line) || numbered.test(line)) {
			const ordered = numbered.test(line);
			const marker = ordered ? numbered : bullet;
			const items: Inline[][] = [];
			while (i < lines.length && marker.test(lines[i])) {
				items.push(parseInline(lines[i].replace(marker, "")));
				i++;
			}
			blocks.push({ t: "list", ordered, items });
			continue;
		}

		const paragraph: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() &&
			(paragraph.length === 0 || !startsBlock(lines[i]))
		) {
			paragraph.push(lines[i].trim());
			i++;
		}
		blocks.push({ t: "paragraph", c: parseInline(paragraph.join(" ")) });
	}
	return blocks;
}

// The headings, in order, for the guide's contents and for search.
export function headingsOf(blocks: Block[]): Heading[] {
	return blocks.flatMap((block) =>
		block.t === "heading"
			? [{ level: block.level, id: block.id, text: plainText(block.c) }]
			: [],
	);
}

// The guide as plain words, for search and for the assistant.
export function guideText(blocks: Block[]): string {
	return blocks
		.map((block) => {
			switch (block.t) {
				case "heading":
				case "paragraph":
					return plainText(block.c);
				case "list":
					return block.items.map(plainText).join("\n");
				case "table":
					return [block.head, ...block.rows]
						.map((row) => row.map(plainText).join(" | "))
						.join("\n");
				case "quote":
					return block.c.map(plainText).join("\n");
				case "code":
					return block.v;
				case "rule":
					return "";
			}
		})
		.filter(Boolean)
		.join("\n");
}
