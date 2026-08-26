"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { Select } from "../components/shared/Select";
import { useUser } from "../context/UserContext";
import styles from "./Editor.module.css";

// Where this report sits, changed from the report.
//
// Neither the category nor the address could be changed once a report existed,
// so one filed in the wrong place had to be deleted and rebuilt, losing its
// URL, its saved views and its history.
//
// Saved on its own rather than through the editor's operation log. The op log
// carries changes to what is on a page and replays them into other sessions;
// this changes where the page lives and can change the URL under the person
// making it, which is a navigation rather than an edit.

interface Category {
	categoryId: string;
	name: string;
}

export function ReportPlacement({
	reportId,
	slug,
	categoryId,
	dirty,
}: {
	reportId: string;
	slug: string;
	categoryId: string | null;
	// Unsaved work on the page. Moving the report reloads it at a new address,
	// so it is refused until that work is saved or discarded.
	dirty: boolean;
}) {
	const router = useRouter();
	const { mutate } = useSWRConfig();
	const { user } = useUser();

	// Only fetched by somebody who could act on it. The endpoint is an admin
	// one, so asking without the capability is a request that answers 404.
	const canManage = user?.capabilities?.includes("category.manage") ?? false;
	const { data } = useSWR<{ categories?: Category[] }>(
		canManage ? "/api/admin/categories" : null,
	);

	const [draftCategory, setDraftCategory] = useState(categoryId ?? "");
	const [draftSlug, setDraftSlug] = useState(slug);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const changed =
		draftCategory !== (categoryId ?? "") || draftSlug.trim() !== slug;

	const save = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const body: Record<string, unknown> = {
				action: "moveReport",
				reportId,
			};
			// Only the halves that changed are sent, so an editor without the
			// navigation capability can still fix an address.
			if (draftSlug.trim() !== slug) body.slug = draftSlug.trim();
			if (draftCategory !== (categoryId ?? "")) {
				body.categoryId = draftCategory;
			}

			const response = await fetch("/api/authoring", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? "That did not work.");
				return;
			}

			const result = (await response.json()) as { slug?: string };
			await mutate("/api/navigation");
			await mutate("/api/search");

			// The address is part of the URL, so a changed slug means the page
			// currently open no longer exists. Replaced rather than pushed: the
			// old address is gone, and leaving it in history offers a back
			// button that 404s.
			if (result.slug && result.slug !== slug) {
				router.replace(`/r/${result.slug}?edit=1`);
			} else {
				router.refresh();
			}
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			{canManage && (
				<label className={styles.settingsField}>
					<span className={styles.settingsLabel}>Category</span>
					<Select
						value={draftCategory}
						onChange={setDraftCategory}
						placeholder="Choose one"
						disabled={busy}
						searchable={(data?.categories?.length ?? 0) > 12}
						options={(data?.categories ?? []).map((c) => ({
							value: c.categoryId,
							label: c.name,
						}))}
					/>
					<span className={styles.settingsHint}>
						Which section of the navigation this sits in. Moving it
						puts it last in the category it lands in.
					</span>
				</label>
			)}

			<label className={styles.settingsField}>
				<span className={styles.settingsLabel}>Address</span>
				<input
					type="text"
					className={styles.settingsInput}
					value={draftSlug}
					disabled={busy}
					onChange={(e) => setDraftSlug(e.target.value)}
				/>
				<span className={styles.settingsHint}>
					/r/{draftSlug.trim() || slug}. Changing this breaks existing
					links and any bookmark somebody kept.
				</span>
			</label>

			{failure && <div className={styles.settingsError}>{failure}</div>}

			{changed && (
				<div className={styles.settingsActions}>
					<button
						type="button"
						className={styles.settingsSave}
						onClick={save}
						disabled={busy || dirty || !draftSlug.trim()}
						title={
							dirty
								? "Save or discard the changes on this page first."
								: undefined
						}
					>
						{busy ? "Moving" : "Move report"}
					</button>
					<button
						type="button"
						className={styles.settingsDiscard}
						onClick={() => {
							setDraftCategory(categoryId ?? "");
							setDraftSlug(slug);
							setFailure(null);
						}}
						disabled={busy}
					>
						Discard
					</button>
				</div>
			)}

			{changed && dirty && (
				<span className={styles.settingsHint}>
					Save the changes on this page first. Moving the report
					reloads it.
				</span>
			)}
		</>
	);
}
