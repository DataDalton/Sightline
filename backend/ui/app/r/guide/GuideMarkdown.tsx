"use client";

import { Fragment, type ReactNode } from "react";
import Link from "../../components/AppLink";
import type { Block, Inline } from "../../../lib/guide/markdown";
import styles from "./Guide.module.css";

// A guide's blocks drawn as elements. Nothing is ever set as HTML, so text an
// author or the assistant wrote cannot become markup.

export interface Targets {
	// The address of a file attached to the guide, by its name, or null when
	// no file of that name is attached.
	fileHref: (name: string) => string | null;
	// Moves the panel to a heading of the same guide.
	onAnchor: (id: string) => void;
}

function inline(parts: Inline[], targets: Targets): ReactNode[] {
	return parts.map((part, i) => {
		switch (part.t) {
			case "text":
				return <Fragment key={i}>{part.v}</Fragment>;
			case "strong":
				return <strong key={i}>{inline(part.c, targets)}</strong>;
			case "em":
				return <em key={i}>{inline(part.c, targets)}</em>;
			case "code":
				return (
					<code key={i} className={styles.inlineCode}>
						{part.v}
					</code>
				);
			case "link": {
				const content = inline(part.c, targets);
				if (part.kind === "external") {
					return (
						<a
							key={i}
							href={part.href}
							target="_blank"
							rel="noopener noreferrer"
							className={styles.link}
						>
							{content}
						</a>
					);
				}
				if (part.kind === "internal") {
					return (
						<Link key={i} href={part.href} className={styles.link}>
							{content}
						</Link>
					);
				}
				if (part.kind === "anchor") {
					return (
						<a
							key={i}
							href={`#${part.href}`}
							className={styles.link}
							onClick={(event) => {
								event.preventDefault();
								targets.onAnchor(part.href);
							}}
						>
							{content}
						</a>
					);
				}
				const href = targets.fileHref(part.href);
				return href ? (
					<a
						key={i}
						href={href}
						target="_blank"
						rel="noopener noreferrer"
						className={styles.link}
					>
						{content}
					</a>
				) : (
					// A link to a file that is no longer attached reads as its words.
					<span key={i} className={styles.missingFile}>
						{content}
					</span>
				);
			}
		}
	});
}

// Inline content alone, for a section heading the reader draws with its own
// controls beside it.
export function GuideInline({
	parts,
	...targets
}: Targets & { parts: Inline[] }) {
	return <>{inline(parts, targets)}</>;
}

export function GuideMarkdown({
	blocks,
	idPrefix,
	...targets
}: Targets & { blocks: Block[]; idPrefix: string }) {
	return (
		<div className={styles.markdown}>
			{blocks.map((block, i) => {
				switch (block.t) {
					case "heading": {
						const Tag = (["h3", "h3", "h4", "h5"] as const)[
							block.level - 1
						];
						return (
							<Tag
								key={i}
								id={`${idPrefix}${block.id}`}
								className={
									block.level <= 2
										? styles.heading
										: styles.subheading
								}
							>
								{inline(block.c, targets)}
							</Tag>
						);
					}
					case "paragraph":
						return (
							<p key={i} className={styles.paragraph}>
								{inline(block.c, targets)}
							</p>
						);
					case "list": {
						const List = block.ordered ? "ol" : "ul";
						return (
							<List key={i} className={styles.list}>
								{block.items.map((item, n) => (
									<li key={n}>{inline(item, targets)}</li>
								))}
							</List>
						);
					}
					case "table":
						return (
							<div key={i} className={styles.tableWrap}>
								<table className={styles.table}>
									<thead>
										<tr>
											{block.head.map((cell, c) => (
												<th key={c}>
													{inline(cell, targets)}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{block.rows.map((row, r) => (
											<tr key={r}>
												{row.map((cell, c) => (
													<td key={c}>
														{inline(cell, targets)}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						);
					case "quote":
						return (
							<blockquote key={i} className={styles.quote}>
								{block.c.map((line, n) => (
									<p key={n}>{inline(line, targets)}</p>
								))}
							</blockquote>
						);
					case "code":
						return (
							<pre key={i} className={styles.codeBlock}>
								<code>{block.v}</code>
							</pre>
						);
					case "rule":
						return <hr key={i} className={styles.rule} />;
				}
			})}
		</div>
	);
}
