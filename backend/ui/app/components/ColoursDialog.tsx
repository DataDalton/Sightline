"use client";

import { useState } from "react";
import useSWR from "swr";
import {
	allThemes,
	builtinThemes,
	type ReportTheme,
} from "../../lib/visuals/themes";
import { ThemeCard } from "../admin/ThemeManager";
import { personalThemeKey, usePersonalTheme } from "../context/PersonalTheme";
import { useTheme } from "../context/ThemeContext";
import { Modal } from "./shared/Modal";
import styles from "./ColoursDialog.module.css";

// Where somebody chooses their own colours for the app.
//
// One of the workspace's themes, a set of their own, or the app's colours.
// Theirs wins over every report's theme, which is said here because otherwise
// a report's colours not showing would look like a fault.

// The app's colours, as globals.css sets them, for the swatch beside the choice
// that means "nothing of mine".
const appColours: ReportTheme = {
	id: "",
	name: "App colors",
	accent: "#ffb500",
	chart: [
		"#2563eb",
		"#0d9488",
		"#d97706",
		"#7c3aed",
		"#db2777",
		"#0891b2",
		"#65a30d",
		"#dc2626",
	],
};

type Selected =
	| { kind: "app" }
	| { kind: "theme"; id: string }
	| { kind: "own" };

export function ColoursDialog({ onClose }: { onClose: () => void }) {
	const { choice, mutate } = usePersonalTheme();
	const { resolved } = useTheme();
	const { data: info } = useSWR<{ customThemes?: ReportTheme[] }>(
		"/api/info",
	);
	const themes = allThemes(info?.customThemes ?? []);
	const builtinIds = new Set(builtinThemes.map((t) => t.id));
	const workspace = themes.filter((t) => !builtinIds.has(t.id));
	const builtin = themes.filter((t) => builtinIds.has(t.id));

	const [selected, setSelected] = useState<Selected>(() =>
		choice?.own
			? { kind: "own" }
			: choice?.themeId
				? { kind: "theme", id: choice.themeId }
				: { kind: "app" },
	);
	// Starts from what they had, or from the theme they were last looking at,
	// so making their own begins from something close rather than from blank.
	const [own, setOwn] = useState<ReportTheme>(
		() =>
			choice?.own ?? {
				...(themes.find((t) => t.id === choice?.themeId) ?? appColours),
				id: "personal",
				name: "My colors",
			},
	);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const shown: ReportTheme =
		selected.kind === "own"
			? own
			: selected.kind === "theme"
				? (themes.find((t) => t.id === selected.id) ?? appColours)
				: appColours;

	const save = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const body =
				selected.kind === "own"
					? {
							own: {
								name: own.name,
								accent: own.accent,
								chart: own.chart,
							},
						}
					: selected.kind === "theme"
						? { themeId: selected.id }
						: {};
			const response = await fetch(personalThemeKey, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const answer = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(answer?.error ?? "Could not save your colors");
				return;
			}
			await mutate();
			onClose();
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not save your colors",
			);
		} finally {
			setBusy(false);
		}
	};

	const option = (
		key: string,
		theme: ReportTheme,
		label: string,
		isOn: boolean,
		pick: () => void,
	) => (
		<button
			key={key}
			type="button"
			role="radio"
			aria-checked={isOn}
			className={`${styles.option} ${isOn ? styles.optionOn : ""}`}
			onClick={pick}
		>
			<span className={styles.strip} aria-hidden="true">
				<span style={{ background: theme.accent }} />
				{theme.chart.slice(0, 8).map((colour, i) => (
					<span key={i} style={{ background: colour }} />
				))}
			</span>
			<span className={styles.optionLabel}>{label}</span>
		</button>
	);

	return (
		<Modal
			isOpen
			onClose={onClose}
			title="Your colors"
			width="880px"
			footer={
				<div className={styles.footer}>
					{failure && (
						<span className={styles.failure} role="alert">
							{failure}
						</span>
					)}
					<button
						type="button"
						className={styles.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={styles.primary}
						onClick={() => void save()}
						disabled={busy}
					>
						{busy ? "Saving" : "Save"}
					</button>
				</div>
			}
		>
			<div className={styles.body}>
				<p className={styles.lead}>
					Used across the whole app, on every device you sign in on.
					They replace each report&apos;s own colours for you only.
					Light and dark stay as you set them in this menu.
				</p>

				<div className={styles.layout}>
					<div
						className={styles.choices}
						role="radiogroup"
						aria-label="Your colors"
					>
						{option(
							"app",
							appColours,
							"App colors, with each report's own",
							selected.kind === "app",
							() => setSelected({ kind: "app" }),
						)}
						{option(
							"own",
							own,
							"My own colors",
							selected.kind === "own",
							() => setSelected({ kind: "own" }),
						)}
						{workspace.length > 0 && (
							<div className={styles.groupTitle}>
								Made for this workspace
							</div>
						)}
						{workspace.map((theme) =>
							option(
								theme.id,
								theme,
								theme.name,
								selected.kind === "theme" &&
									selected.id === theme.id,
								() =>
									setSelected({
										kind: "theme",
										id: theme.id,
									}),
							),
						)}
						<div className={styles.groupTitle}>Built in</div>
						{builtin.map((theme) =>
							option(
								theme.id,
								theme,
								theme.name,
								selected.kind === "theme" &&
									selected.id === theme.id,
								() =>
									setSelected({
										kind: "theme",
										id: theme.id,
									}),
							),
						)}
					</div>

					<div className={styles.preview}>
						<ThemeCard
							theme={shown}
							ground={resolved}
							onChange={
								selected.kind === "own"
									? (patch) =>
											setOwn((held) => ({
												...held,
												...patch,
											}))
									: undefined
							}
							actions={null}
						/>
						{selected.kind !== "own" && (
							<button
								type="button"
								className={styles.link}
								onClick={() => {
									setOwn({
										...shown,
										id: "personal",
										name: "My colors",
									});
									setSelected({ kind: "own" });
								}}
							>
								Start my own from these
							</button>
						)}
					</div>
				</div>
			</div>
		</Modal>
	);
}
