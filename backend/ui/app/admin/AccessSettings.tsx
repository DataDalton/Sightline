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

type GroupKey = "editorGroups" | "adminGroups";

// Only the keys this pane owns, and only those that differ from what was
// loaded. The settings endpoint takes a partial body, so sending the whole
// loaded object would write back every other setting as it was when this pane
// opened and undo a change saved from elsewhere in the meantime.
function changedKeys(draft: Values, base: Values | undefined) {
	const changes: Partial<Values> = {};
	if (draft.accessModel !== base?.accessModel) {
		changes.accessModel = draft.accessModel;
	}
	for (const key of ["editorGroups", "adminGroups"] as const) {
		if (JSON.stringify(draft[key]) !== JSON.stringify(base?.[key] ?? [])) {
			changes[key] = draft[key];
		}
	}
	return changes;
}

const splitGroups = (text: string) =>
	text
		.split(",")
		.map((g) => g.trim())
		.filter(Boolean);

export function AccessSettings() {
	const { data, mutate } = useSWR<{ settings: Values }>(
		"/api/admin/settings",
	);
	const [draft, setDraft] = useState<Values | null>(null);
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	// What is typed into each group field, held as text. Parsing it into a list
	// on every keystroke and joining it back dropped a trailing comma the moment
	// it was typed, so a second group could not be entered.
	const [groupText, setGroupText] = useState<
		Partial<Record<GroupKey, string>>
	>({});

	const values = draft ?? data?.settings ?? null;
	const dirty = draft !== null;

	const set = (patch: Partial<Values>) => {
		if (!values) return;
		setSaved(false);
		setDraft({ ...values, ...patch });
	};

	const groups = (key: GroupKey) => (
		<input
			className={admin.input}
			placeholder="None set"
			value={groupText[key] ?? (values?.[key] ?? []).join(", ")}
			onChange={(e) => {
				const text = e.target.value;
				setGroupText((prev) => ({ ...prev, [key]: text }));
				set({ [key]: splitGroups(text) } as Partial<Values>);
			}}
		/>
	);

	const discard = () => {
		setDraft(null);
		setGroupText({});
	};

	const save = async () => {
		if (!draft) return;
		const changes = changedKeys(draft, data?.settings);
		if (Object.keys(changes).length === 0) {
			discard();
			return;
		}
		setSaving(true);
		setFailure(null);
		try {
			const response = await fetch("/api/admin/settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(changes),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? "Could not save.");
				return;
			}
			discard();
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
								onClick={discard}
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
