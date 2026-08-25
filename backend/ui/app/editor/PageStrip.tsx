"use client";

import { useState } from "react";
import styles from "./Editor.module.css";

// The pages of a report, along the top of the editor.
//
// Pages are the structure of the report, so they belong where the structure is
// visible and switchable, not inside a settings panel two clicks away. A strip
// under the toolbar is where every tool that has pages puts them, and it makes
// the thing an author is about to add or leave obvious before they do it.
//
// One flat list. Nesting was offered for a while and cost more than it gave:
// two buttons an author had to choose between, where the difference was only
// how deep the tab sat. A page that belongs with another can sit next to it.

export interface StripPage {
	pageId: string;
	title: string;
}

interface PageStripProps {
	pages: StripPage[];
	activePageId: string;
	// True when the editor has unsaved work. Switching page would discard it,
	// so it is refused rather than done quietly.
	dirty: boolean;
	onSelect: (pageId: string) => void;
	onAdd: (title: string) => void;
	onRemove: (pageId: string) => void;
}

export function PageStrip({
	pages,
	activePageId,
	dirty,
	onSelect,
	onAdd,
	onRemove,
}: PageStripProps) {
	const [adding, setAdding] = useState(false);
	const [title, setTitle] = useState("");

	const commit = () => {
		const trimmed = title.trim();
		if (trimmed) onAdd(trimmed);
		setTitle("");
		setAdding(false);
	};

	return (
		<div className={styles.pageStrip}>
			<div className={styles.pageTabs} role="tablist">
				{pages.map((page) => {
					const on = page.pageId === activePageId;
					return (
						<div
							key={page.pageId}
							className={`${styles.pageTab} ${on ? styles.pageTabActive : ""}`}
						>
							<button
								type="button"
								role="tab"
								aria-selected={on}
								className={styles.pageTabButton}
								onClick={() => onSelect(page.pageId)}
								disabled={dirty && !on}
								title={
									dirty && !on
										? "Save or discard first. Switching page would lose the changes on this one."
										: page.title
								}
							>
								{page.title}
							</button>

							{/* Only the page being edited offers removal, so a
							    stray click on a tab cannot delete a page the
							    author is not even looking at. */}
							{on && pages.length > 1 && (
								<button
									type="button"
									className={styles.pageTabRemove}
									onClick={() => onRemove(page.pageId)}
									aria-label={`Remove ${page.title}`}
									title="Remove this page"
								>
									✕
								</button>
							)}
						</div>
					);
				})}

				{adding ? (
					<div className={styles.pageAdd}>
						<input
							type="text"
							className={styles.pageAddInput}
							placeholder="Page name"
							value={title}
							// eslint-disable-next-line jsx-a11y/no-autofocus
							autoFocus
							onChange={(e) => setTitle(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									commit();
								}
								if (e.key === "Escape") {
									setAdding(false);
									setTitle("");
								}
							}}
							onBlur={commit}
						/>
					</div>
				) : (
					<button
						type="button"
						className={styles.pageAddButton}
						onClick={() => setAdding(true)}
						title="Add a page to this report"
					>
						+ Page
					</button>
				)}
			</div>

			{dirty && (
				<span className={styles.pageStripNote}>
					Save to switch page
				</span>
			)}
		</div>
	);
}
