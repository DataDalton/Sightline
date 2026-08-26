"use client";

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
	// Opens the dialog that asks what shape the page should start in. The strip
	// used to take a name inline and make an empty page, which is one of the
	// answers rather than the question.
	onAdd: () => void;
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

				<button
					type="button"
					className={styles.pageAddButton}
					onClick={onAdd}
					title="Add a page to this report"
				>
					+ Page
				</button>
			</div>

			{dirty && (
				<span className={styles.pageStripNote}>
					Save to switch page
				</span>
			)}
		</div>
	);
}
