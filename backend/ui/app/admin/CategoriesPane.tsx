"use client";

import { useState } from "react";
import useSWR from "swr";
import { Skeleton } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import styles from "./Admin.module.css";

// The categories navigation is built from.
//
// Nothing in the application could create one. There was no INSERT against the
// categories table anywhere in the codebase, so a new subject area meant
// somebody writing SQL against the platform store by hand.

interface Category {
	categoryId: string;
	name: string;
	description: string | null;
	icon: string | null;
	sortOrder: number;
	reportCount: number;
}

interface CategoriesResponse {
	categories: Category[];
	canCreate: boolean;
	canManage: boolean;
}

const emptyDraft = {
	categoryId: "",
	name: "",
	description: "",
	icon: "",
};

export default function CategoriesPane() {
	const { data, isLoading, mutate } = useSWR<CategoriesResponse>(
		"/api/admin/categories",
	);
	const showSkeleton = useDeferredLoading(isLoading);

	const [draft, setDraft] = useState(emptyDraft);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const categories = data?.categories ?? [];
	const editing = categories.some((c) => c.categoryId === draft.categoryId);

	const post = async (body: Record<string, unknown>, whenWrong: string) => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/authoring", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				setFailure(detail?.error ?? whenWrong);
				return false;
			}
			await mutate();
			return true;
		} catch (error) {
			setFailure(error instanceof Error ? error.message : whenWrong);
			return false;
		} finally {
			setBusy(false);
		}
	};

	// Moved by one place at a time. A drag would be nicer and is not worth a
	// dependency for a list that is rarely more than a dozen long and changes
	// a few times a year.
	const move = async (index: number, by: number) => {
		const next = [...categories];
		const target = index + by;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target], next[index]];
		await post(
			{
				action: "reorderCategories",
				categoryIds: next.map((c) => c.categoryId),
			},
			"Could not reorder",
		);
	};

	return (
		<>
			<div className={styles.tableWrap}>
				<table className={styles.table}>
					<thead>
						<tr>
							<th>Category</th>
							<th>Id</th>
							<th className={styles.numeric}>Reports</th>
							<th>Order</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{categories.map((category, index) => (
							<tr key={category.categoryId}>
								<td>
									{category.icon} {category.name}
									{category.description && (
										<div className={styles.fieldHint}>
											{category.description}
										</div>
									)}
								</td>
								<td>
									<span className={styles.mono}>
										{category.categoryId}
									</span>
								</td>
								<td className={styles.numeric}>
									{category.reportCount}
								</td>
								<td>
									<button
										type="button"
										className={styles.linkButton}
										disabled={busy || index === 0}
										onClick={() => move(index, -1)}
										aria-label={`Move ${category.name} up`}
									>
										↑
									</button>
									<button
										type="button"
										className={styles.linkButton}
										disabled={
											busy ||
											index === categories.length - 1
										}
										onClick={() => move(index, 1)}
										aria-label={`Move ${category.name} down`}
									>
										↓
									</button>
								</td>
								<td>
									<button
										type="button"
										className={styles.linkButton}
										disabled={busy}
										onClick={() =>
											setDraft({
												categoryId: category.categoryId,
												name: category.name,
												description:
													category.description ?? "",
												icon: category.icon ?? "",
											})
										}
									>
										Edit
									</button>
									<button
										type="button"
										className={styles.linkButton}
										disabled={busy}
										onClick={() =>
											post(
												{
													action: "removeCategory",
													categoryId:
														category.categoryId,
												},
												"Could not remove",
											)
										}
									>
										Remove
									</button>
								</td>
							</tr>
						))}
						{!isLoading && categories.length === 0 && (
							<tr>
								<td colSpan={5}>
									No categories yet. Navigation is built from
									these, so the first one is what makes a
									report reachable.
								</td>
							</tr>
						)}
						{showSkeleton &&
							Array.from({ length: 3 }, (_, row) => (
								<tr key={`loading-${row}`}>
									{Array.from({ length: 5 }, (_, col) => (
										<td key={col}>
											<Skeleton height={12} />
										</td>
									))}
								</tr>
							))}
					</tbody>
				</table>
			</div>

			<header className={styles.paneHeader}>
				<h2 className={styles.paneTitle}>
					{editing
						? `Editing ${draft.name || draft.categoryId}`
						: "A new category"}
				</h2>
				<p className={styles.paneBlurb}>
					The id appears in the address of every report inside it and
					cannot be changed later.
				</p>
			</header>

			<div className={styles.fieldRow}>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Id</span>
					<input
						className={styles.input}
						value={draft.categoryId}
						placeholder="sales"
						disabled={editing}
						onChange={(e) =>
							setDraft((d) => ({
								...d,
								categoryId: e.target.value,
							}))
						}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Name</span>
					<input
						className={styles.input}
						value={draft.name}
						placeholder="Sales"
						onChange={(e) =>
							setDraft((d) => ({ ...d, name: e.target.value }))
						}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Icon</span>
					<input
						className={styles.input}
						value={draft.icon}
						placeholder="Optional"
						onChange={(e) =>
							setDraft((d) => ({ ...d, icon: e.target.value }))
						}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.fieldLabel}>Description</span>
					<input
						className={styles.input}
						value={draft.description}
						placeholder="What belongs in here"
						onChange={(e) =>
							setDraft((d) => ({
								...d,
								description: e.target.value,
							}))
						}
					/>
				</label>
				<div className={styles.rowActions}>
					<button
						type="button"
						className={styles.saveButton}
						disabled={
							busy ||
							!draft.categoryId.trim() ||
							!draft.name.trim()
						}
						onClick={async () => {
							const ok = await post(
								{
									action: editing
										? "updateCategory"
										: "createCategory",
									...draft,
								},
								"Could not save that category",
							);
							if (ok) setDraft(emptyDraft);
						}}
					>
						{busy ? "Working" : editing ? "Save changes" : "Add"}
					</button>
					{draft.categoryId !== "" && (
						<button
							type="button"
							className={styles.linkButton}
							onClick={() => setDraft(emptyDraft)}
						>
							Clear
						</button>
					)}
				</div>
			</div>

			{failure && <div className={styles.saveError}>{failure}</div>}
		</>
	);
}
