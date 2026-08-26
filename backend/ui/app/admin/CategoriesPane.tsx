"use client";

import { Fragment, useState } from "react";
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

interface ReportRow {
	reportId: string;
	title: string;
	slug: string;
	categoryId: string | null;
	sortOrder: number;
}

interface CategoriesResponse {
	categories: Category[];
	reports?: ReportRow[];
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
	// The reports come with the categories, so opening one costs nothing.
	// Which category a report sits in is changed from the report itself, in the
	// editor; what is decided here is the order they appear in, which is a
	// property of the category rather than of any one report.
	const { data, isLoading, mutate } = useSWR<CategoriesResponse>(
		"/api/admin/categories?reports=1",
	);
	const showSkeleton = useDeferredLoading(isLoading);

	const [draft, setDraft] = useState(emptyDraft);
	const [opened, setOpened] = useState<string | null>(null);
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
							<Fragment key={category.categoryId}>
								<tr>
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
										{category.reportCount > 0 ? (
											<button
												type="button"
												className={styles.linkButton}
												onClick={() =>
													setOpened(
														opened ===
															category.categoryId
															? null
															: category.categoryId,
													)
												}
												aria-expanded={
													opened ===
													category.categoryId
												}
											>
												{category.reportCount}
											</button>
										) : (
											category.reportCount
										)}
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
													categoryId:
														category.categoryId,
													name: category.name,
													description:
														category.description ??
														"",
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
								{opened === category.categoryId && (
									<tr>
										<td colSpan={5}>
											<ReportOrder
												categoryId={category.categoryId}
												reports={(
													data?.reports ?? []
												).filter(
													(r) =>
														r.categoryId ===
														category.categoryId,
												)}
												busy={busy}
												onReorder={(reportIds) =>
													post(
														{
															action: "reorderReports",
															categoryId:
																category.categoryId,
															reportIds,
														},
														"Could not reorder",
													)
												}
											/>
										</td>
									</tr>
								)}
							</Fragment>
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

// The order reports appear in inside one category.
//
// Categories have carried an order since the beginning and reports never did,
// so a category listed alphabetically and the report a team opens every morning
// sat wherever its title happened to fall.
//
// Only the order lives here. Which category a report belongs to is changed from
// the report, in the editor, where somebody is already looking at it rather than
// hunting for it in a list.
function ReportOrder({
	categoryId,
	reports,
	busy,
	onReorder,
}: {
	categoryId: string;
	reports: ReportRow[];
	busy: boolean;
	onReorder: (reportIds: string[]) => void;
}) {
	const ordered = [...reports].sort(
		(a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title),
	);

	// The whole list is sent rather than a pair of positions, so the server does
	// not have to work out what moved.
	const move = (index: number, delta: number) => {
		const target = index + delta;
		if (target < 0 || target >= ordered.length) return;
		const next = ordered.map((r) => r.reportId);
		[next[index], next[target]] = [next[target], next[index]];
		onReorder(next);
	};

	if (ordered.length === 0) return null;

	return (
		<div className={styles.nested}>
			<div className={styles.fieldLabel}>Order in {categoryId}</div>
			{ordered.map((report, index) => (
				<div key={report.reportId} className={styles.nestedRow}>
					<span className={styles.nestedName}>{report.title}</span>
					<span className={styles.mono}>/r/{report.slug}</span>
					<button
						type="button"
						className={styles.linkButton}
						disabled={busy || index === 0}
						onClick={() => move(index, -1)}
						aria-label={`Move ${report.title} up`}
					>
						↑
					</button>
					<button
						type="button"
						className={styles.linkButton}
						disabled={busy || index === ordered.length - 1}
						onClick={() => move(index, 1)}
						aria-label={`Move ${report.title} down`}
					>
						↓
					</button>
				</div>
			))}
		</div>
	);
}
