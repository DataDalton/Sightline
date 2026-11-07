"use client";

import { Modal } from "./shared/Modal";
import styles from "./ShortcutsHelp.module.css";

// The keyboard shortcuts, listed where somebody will look for them. Opened with
// the question mark, the way most tools with shortcuts do it.

interface Shortcut {
	keys: string[];
	does: string;
}

const reading: Shortcut[] = [
	{ keys: ["Ctrl", "K"], does: "Search everything" },
	{ keys: ["["], does: "Previous page of the report" },
	{ keys: ["]"], does: "Next page of the report" },
	{ keys: ["E"], does: "Edit this report, where you can" },
	{ keys: ["?"], does: "Show these shortcuts" },
];

const editing: Shortcut[] = [
	{ keys: ["Ctrl", "S"], does: "Publish your changes" },
	{ keys: ["Ctrl", "Z"], does: "Undo" },
	{ keys: ["Ctrl", "Y"], does: "Redo" },
	{ keys: ["Ctrl", "C"], does: "Copy the visual" },
	{ keys: ["Ctrl", "V"], does: "Paste" },
	{ keys: ["Ctrl", "D"], does: "Duplicate the visual" },
	{ keys: ["Ctrl", "A"], does: "Select every visual on the page" },
	{ keys: ["Shift", "Click"], does: "Add a visual to the selection" },
	{ keys: ["Arrows"], does: "Move the selection" },
	{ keys: ["Shift", "Arrows"], does: "Resize the selection" },
	{ keys: ["Delete"], does: "Remove the selection" },
	{ keys: ["Esc"], does: "Clear the selection" },
	{ keys: ["["], does: "Previous page" },
	{ keys: ["]"], does: "Next page" },
	{ keys: ["?"], does: "Show these shortcuts" },
];

export function ShortcutsHelp({
	isOpen,
	mode,
	onClose,
}: {
	isOpen: boolean;
	mode: "reading" | "editing";
	onClose: () => void;
}) {
	const list = mode === "editing" ? editing : reading;
	return (
		<Modal
			isOpen={isOpen}
			onClose={onClose}
			title="Keyboard shortcuts"
			width="440px"
		>
			<dl className={styles.list}>
				{list.map((shortcut) => (
					<div key={shortcut.does} className={styles.row}>
						<dt className={styles.keys}>
							{shortcut.keys.map((key) => (
								<kbd key={key} className={styles.key}>
									{key}
								</kbd>
							))}
						</dt>
						<dd className={styles.does}>{shortcut.does}</dd>
					</div>
				))}
			</dl>
		</Modal>
	);
}
