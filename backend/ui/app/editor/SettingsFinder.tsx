"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { rankSettings, type EditorSetting } from "./settingsIndex";
import type { EditorPanel } from "./EditorRail";
import styles from "./Editor.module.css";

// Finds a setting across every panel, for someone who knows what they want and not where it
// lives. Choosing one opens its panel and scrolls to it.

export function SettingsFinder({
	hasSelection,
	onOpen,
}: {
	hasSelection: boolean;
	onOpen: (panel: EditorPanel) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const box = useRef<HTMLDivElement | null>(null);
	const results = useMemo(() => rankSettings(query), [query]);

	useEffect(() => {
		const away = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) {
				setQuery("");
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", away);
		return () => document.removeEventListener("mousedown", away);
	}, []);

	const choose = (setting: EditorSetting) => {
		if (setting.panel === "visual" && !hasSelection) return;
		setQuery("");
		setOpen(false);
		onOpen(setting.panel);
		if (!setting.section) return;
		// Once the panel has drawn. A collapsed group is opened, so what was asked for shows.
		window.setTimeout(() => {
			const section = document.querySelector<HTMLElement>(
				`[data-section="${setting.section}"]`,
			);
			if (!section) return;
			const head = section.querySelector<HTMLButtonElement>(
				"button[aria-expanded]",
			);
			if (head?.getAttribute("aria-expanded") === "false") head.click();
			section.scrollIntoView({ block: "start", behavior: "smooth" });
		}, 60);
	};

	return (
		<div ref={box} className={styles.finderRail}>
			<button
				type="button"
				className={`${styles.railButton} ${open ? styles.railButtonOn : ""}`}
				aria-expanded={open}
				title="Find any setting, in any panel"
				onClick={() => setOpen((held) => !held)}
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="7" />
					<path d="M21 21l-4.35-4.35" />
				</svg>
				<span className={styles.railLabel}>Find</span>
			</button>
			{open && (
				<div className={styles.finderPopover}>
					<input
						className={styles.finderInput}
						autoFocus
						value={query}
						placeholder="Find a setting, such as legend or theme"
						aria-label="Find a setting in any panel"
						onChange={(e) => {
							setQuery(e.target.value);
							setActive(0);
						}}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								setQuery("");
								setOpen(false);
							}
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setActive((held) =>
									Math.min(held + 1, results.length - 1),
								);
							}
							if (e.key === "ArrowUp") {
								e.preventDefault();
								setActive((held) => Math.max(held - 1, 0));
							}
							if (e.key === "Enter" && results[active]) {
								e.preventDefault();
								choose(results[active]);
							}
						}}
					/>
					{query.trim() && (
						<div className={styles.finderResults} role="listbox">
							{results.length === 0 && (
								<p className={styles.finderEmpty}>
									Nothing by that name.
								</p>
							)}
							{results.map((setting, index) => {
								const blocked =
									setting.panel === "visual" && !hasSelection;
								return (
									<button
										key={setting.label}
										type="button"
										role="option"
										aria-selected={index === active}
										disabled={blocked}
										className={`${styles.finderResult} ${index === active ? styles.finderResultOn : ""}`}
										onClick={() => choose(setting)}
									>
										<span>{setting.label}</span>
										<span className={styles.finderWhere}>
											{blocked
												? "Select a visual first"
												: setting.where}
										</span>
									</button>
								);
							})}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
