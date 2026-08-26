"use client";

import { useEffect, useRef, useState } from "react";
import { useUser } from "../context/UserContext";
import { useTheme, type ThemePreference } from "../context/ThemeContext";
import styles from "./AccountBlock.module.css";

// Who you are signed in as, at the foot of the navigation.
//
// Identity sat top right, which is where a marketing site puts it. An
// application with a persistent left rail puts it at the bottom of that rail,
// and moving it frees the header for the thing people actually reach for.
//
// It also gives the theme control somewhere to live. As a header icon it was a
// three-state cycle behind one unlabelled button, so following the system and
// being explicitly dark looked identical and the only way to find out was to
// click and see what happened.

const themeChoices: { id: ThemePreference; label: string }[] = [
	{ id: "system", label: "System" },
	{ id: "light", label: "Light" },
	{ id: "dark", label: "Dark" },
];

export function AccountBlock() {
	const { user, loading, error, refresh } = useUser();
	const { preference, setPreference } = useTheme();
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Each of these changes what the app can do, and each has a different
	// person who can fix it. Said in words here because the dot in the header
	// only has room to say that something is wrong.
	const notes: string[] = [];
	if (user && !user.authenticated) {
		notes.push("Running locally. No workspace identity is in play.");
	}
	if (user?.policy.stale) {
		notes.push(
			"Group membership could not be refreshed. Showing last known access.",
		);
	}
	if (user?.policy.degraded) {
		notes.push(
			"Group membership could not be resolved, so reports are hidden until it recovers.",
		);
	}
	if (user && !user.canQueryAsUser) {
		notes.push(
			"No user token was forwarded, so queries cannot run under your identity.",
		);
	}

	return (
		<div className={styles.wrap} ref={wrapRef}>
			{open && (
				<div className={styles.menu} role="menu">
					<div className={styles.identity}>
						<div className={styles.identityName}>
							{user?.name ?? "Unknown"}
						</div>
						{user?.email && (
							<div className={styles.identityEmail}>
								{user.email}
							</div>
						)}
					</div>

					<div className={styles.group}>
						<div className={styles.groupTitle}>Theme</div>
						<div
							className={styles.segmented}
							role="radiogroup"
							aria-label="Theme"
						>
							{themeChoices.map((choice) => (
								<button
									key={choice.id}
									type="button"
									role="radio"
									aria-checked={preference === choice.id}
									className={`${styles.segment} ${
										preference === choice.id
											? styles.segmentOn
											: ""
									}`}
									onClick={() => setPreference(choice.id)}
								>
									{choice.label}
								</button>
							))}
						</div>
					</div>

					{notes.length > 0 && (
						<div className={styles.group}>
							<div className={styles.groupTitle}>Session</div>
							{notes.map((note) => (
								<p key={note} className={styles.note}>
									{note}
								</p>
							))}
						</div>
					)}

					{error && (
						<button
							type="button"
							className={styles.retry}
							onClick={() => {
								void refresh();
								setOpen(false);
							}}
						>
							Retry connection
						</button>
					)}
				</div>
			)}

			<button
				type="button"
				className={styles.trigger}
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-haspopup="menu"
			>
				<span className={styles.avatar}>
					{loading ? "" : (user?.initials ?? "?")}
				</span>
				<span className={styles.label}>
					<span className={styles.name}>
						{loading
							? "Connecting"
							: error
								? "Offline"
								: (user?.name ?? "Unknown")}
					</span>
					{notes.length > 0 && (
						<span className={styles.subtle}>
							{user?.policy.degraded || user?.policy.stale
								? "Access limited"
								: "Local session"}
						</span>
					)}
				</span>
				<svg
					className={styles.chevron}
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
					style={{
						transform: open ? "rotate(180deg)" : undefined,
					}}
				>
					<path d="M18 15l-6-6-6 6" />
				</svg>
			</button>
		</div>
	);
}
