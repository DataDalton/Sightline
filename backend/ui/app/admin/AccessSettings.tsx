"use client";

import { useState } from "react";
import useSWR from "swr";
import { Select } from "../components/shared/Select";
import admin from "./Admin.module.css";
import styles from "./Roles.module.css";

// Where reachability comes from, and the groups that hold a permission before
// any role or grant does.
//
// These lived under Configuration, one pane away from the roles and grants they
// decide the behaviour of, so working out who could open what meant reading
// four pages and holding three of them in your head.

interface Values {
	accessModel?: "catalog" | "grants";
	editorGroups: string[];
	adminGroups: string[];
}

export function AccessSettings() {
	const { data, mutate } = useSWR<{ settings: Values }>(
		"/api/admin/settings",
	);
	const [draft, setDraft] = useState<Values | null>(null);
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const values = draft ?? data?.settings ?? null;
	const dirty = draft !== null;

	const set = (patch: Partial<Values>) => {
		if (!values) return;
		setSaved(false);
		setDraft({ ...values, ...patch });
	};

	const groups = (key: "editorGroups" | "adminGroups") => (
		<input
			className={admin.input}
			placeholder="None set"
			value={(values?.[key] ?? []).join(", ")}
			onChange={(e) =>
				set({
					[key]: e.target.value
						.split(",")
						.map((g) => g.trim())
						.filter(Boolean),
				} as Partial<Values>)
			}
		/>
	);

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		setFailure(null);
		try {
			const response = await fetch("/api/admin/settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(draft),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? "Could not save.");
				return;
			}
			setDraft(null);
			setSaved(true);
			await mutate();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "Could not save.",
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className={styles.group}>
			<div className={styles.groupHead}>
				<div>
					<h3 className={styles.groupTitle}>How access is decided</h3>
					<p className={styles.groupBlurb}>
						Applies before any role or grant below.
					</p>
				</div>
			</div>

			<div className={admin.fieldRow}>
				<label className={admin.field}>
					<span className={admin.fieldLabel}>Reachability</span>
					<Select
						value={values?.accessModel ?? "catalog"}
						onChange={(v) =>
							set({ accessModel: v as "catalog" | "grants" })
						}
						options={[
							{
								value: "catalog",
								label: "Follows Unity Catalog",
								note: "SELECT implies view",
							},
							{
								value: "grants",
								label: "Access grants only",
								note: "Nothing implied",
							},
						]}
					/>
				</label>

				<label className={admin.field}>
					<span className={admin.fieldLabel}>Editor groups</span>
					{groups("editorGroups")}
					<span className={admin.fieldHint}>
						May edit any report. Case sensitive.
					</span>
				</label>

				<label className={admin.field}>
					<span className={admin.fieldLabel}>Admin groups</span>
					{groups("adminGroups")}
					<span className={admin.fieldHint}>
						Hold every permission, including this page.
					</span>
				</label>

				{(dirty || failure || saved) && (
					<div className={admin.rowActions}>
						<button
							type="button"
							className={admin.saveButton}
							onClick={save}
							disabled={saving || !dirty}
						>
							{saving ? "Saving" : saved ? "Saved" : "Save"}
						</button>
						{dirty && (
							<button
								type="button"
								className={admin.linkButton}
								onClick={() => setDraft(null)}
							>
								Discard
							</button>
						)}
					</div>
				)}
			</div>

			{failure && <div className={admin.saveError}>{failure}</div>}
		</section>
	);
}
