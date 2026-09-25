import { Fragment, type ReactNode } from "react";
import styles from "./Assist.module.css";

// The subset of markdown a written analysis uses: headings, paragraphs, bullet
// and numbered lists, simple tables, bold, italics and inline code.
//
// Built as elements rather than injected as HTML. The text comes from a model,
// and a model can be talked into writing a script tag by the data it read, so
// nothing it writes is ever parsed as markup.

function inline(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
	let last = 0;
	let match: RegExpExecArray | null;
	let key = 0;
	while ((match = pattern.exec(text))) {
		if (match.index > last) out.push(text.slice(last, match.index));
		const token = match[0];
		if (token.startsWith("**")) {
			out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
		} else if (token.startsWith("`")) {
			out.push(<code key={key++}>{token.slice(1, -1)}</code>);
		} else {
			out.push(<em key={key++}>{token.slice(1, -1)}</em>);
		}
		last = match.index + token.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

function cells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
}

export function Markdown({ text }: { text: string }) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: ReactNode[] = [];
	let i = 0;
	let key = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			i++;
			continue;
		}

		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			blocks.push(
				<p
					key={key++}
					className={level <= 2 ? styles.mdH2 : styles.mdH3}
				>
					{inline(heading[2])}
				</p>,
			);
			i++;
			continue;
		}

		// A table is a header row, a divider row of dashes, then rows.
		if (
			line.includes("|") &&
			i + 1 < lines.length &&
			/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])
		) {
			const head = cells(line);
			const body: string[][] = [];
			i += 2;
			while (i < lines.length && lines[i].includes("|")) {
				body.push(cells(lines[i]));
				i++;
			}
			blocks.push(
				<div key={key++} className={styles.mdTableWrap}>
					<table className={styles.mdTable}>
						<thead>
							<tr>
								{head.map((h, c) => (
									<th key={c}>{inline(h)}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{body.map((row, r) => (
								<tr key={r}>
									{row.map((cell, c) => (
										<td key={c}>{inline(cell)}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>,
			);
			continue;
		}

		const bullet = /^\s*[-*•]\s+/;
		const numbered = /^\s*\d+[.)]\s+/;
		if (bullet.test(line) || numbered.test(line)) {
			const ordered = numbered.test(line);
			const marker = ordered ? numbered : bullet;
			const items: string[] = [];
			while (i < lines.length && marker.test(lines[i])) {
				items.push(lines[i].replace(marker, ""));
				i++;
			}
			const List = ordered ? "ol" : "ul";
			blocks.push(
				<List key={key++} className={styles.mdList}>
					{items.map((item, n) => (
						<li key={n}>{inline(item)}</li>
					))}
				</List>,
			);
			continue;
		}

		const paragraph: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() &&
			!/^(#{1,4})\s/.test(lines[i]) &&
			!bullet.test(lines[i]) &&
			!numbered.test(lines[i])
		) {
			paragraph.push(lines[i]);
			i++;
		}
		blocks.push(
			<p key={key++} className={styles.mdP}>
				{paragraph.map((part, n) => (
					<Fragment key={n}>
						{n > 0 && " "}
						{inline(part)}
					</Fragment>
				))}
			</p>,
		);
	}

	return <div className={styles.md}>{blocks}</div>;
}
