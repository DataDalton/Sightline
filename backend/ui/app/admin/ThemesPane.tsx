"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { ThemeManager } from "./ThemeManager";
import styles from "./Admin.module.css";

// The themes Editors can apply to a report, for whoever holds the right to make them.
export default function ThemesPane() {
	const { data, mutate } = useSWR<{ customThemes: string }>("/api/themes");
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	useEffect(() => {
		if (data && draft === null) setDraft(data.customThemes);
	}, [data, draft]);
	if (draft === null) return null;
	const changed = draft !== data?.customThemes;
	return (
		<>
			<ThemeManager value={draft} onChange={setDraft} />
			{failure && <p role="alert">{failure}</p>}
			<div className={styles.actionBar}>
				<button
					type="button"
					className={styles.actionPrimary}
					disabled={!changed || saving}
					onClick={async () => {
						setSaving(true);
						setFailure(null);
						const response = await fetch("/api/themes", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ customThemes: draft }),
						});
						setSaving(false);
						if (response.ok) {
							await mutate();
						} else {
							setFailure("The themes did not save.");
						}
					}}
				>
					{saving ? "Saving" : "Save"}
				</button>
			</div>
		</>
	);
}
