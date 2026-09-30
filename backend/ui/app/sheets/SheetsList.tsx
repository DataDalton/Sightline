"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import type { SheetSummary } from "../../lib/sheets/store";
import { describeFetchError } from "../../lib/swr";
import { ago } from "../admin/when";
import { SkeletonText } from "../components/shared/Skeleton";
import { usePageTitle } from "../hooks/usePageTitle";
import type { SourceMeta } from "../visuals/types";
import { SheetActions } from "./SheetActions";
import styles from "./Sheets.module.css";

// Every sheet somebody has, their own first and then those shared with them.

export async function createSheet(
	title: string,
	definition?: unknown,
): Promise<string | null> {
	const response = await fetch("/api/sheets", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title, definition }),
	});
	if (!response.ok) return null;
	const body = await response.json();
	return body.sheet?.id ?? null;
}

export default function SheetsList() {
	usePageTitle("Sheets");
	const router = useRouter();
	const { data, error, isLoading, mutate } = useSWR<{
		sheets: SheetSummary[];
	}>("/api/sheets");
	const { data: authoring } = useSWR<{ sources: SourceMeta[] }>(
		"/api/authoring",
	);
	const [creating, setCreating] = useState(false);

	const titleOf = (key: string) =>
		authoring?.sources.find((s) => s.sourceKey === key)?.title ?? key;

	const mine = (data?.sheets ?? []).filter((s) => s.permission === "owner");
	const shared = (data?.sheets ?? []).filter((s) => s.permission !== "owner");

	const create = async () => {
		setCreating(true);
		let id: string | null = null;
		try {
			id = await createSheet("Untitled sheet");
		} catch {
			// Offline or an unreadable reply. The button is offered again.
		} finally {
			setCreating(false);
		}
		if (id) router.push(`/sheets/${id}/`);
	};

	const list = (sheets: SheetSummary[]) => (
		<ul className={styles.sheetList}>
			{sheets.map((s) => (
				<li key={s.id}>
					<Link
						href={`/sheets/${s.id}/`}
						className={styles.sheetCard}
					>
						<span className={styles.sheetIcon} aria-hidden="true">
							<svg
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.8"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18" />
							</svg>
						</span>
						<span className={styles.sheetText}>
							<span className={styles.sheetTitle}>{s.title}</span>
							<span className={styles.sheetMeta}>
								{s.sourceKey
									? titleOf(s.sourceKey)
									: "No dataset yet"}
								{" · "}
								{s.mode === "pivot" ? "Pivot" : "Table"}
								{" · "}
								{s.permission === "owner"
									? s.sharedWith > 0
										? `Shared with ${s.sharedWith}`
										: "Only you"
									: `From ${s.ownerEmail}${s.permission === "view" ? ", view only" : ""}`}
							</span>
						</span>
						<span className={styles.sheetWhen}>
							{ago(s.modifiedOn)}
						</span>
					</Link>
					<SheetActions
						id={s.id}
						title={s.title}
						permission={s.permission}
						onDeleted={() => void mutate()}
						onDuplicated={(id) => router.push(`/sheets/${id}/`)}
					/>
				</li>
			))}
		</ul>
	);

	return (
		<div className={styles.page}>
			<header className={styles.listHead}>
				<div>
					<h1 className={styles.pageTitle}>Sheets</h1>
					<p className={styles.subtitle}>
						A live table from any dataset, with your own formula and
						note columns and pivots on top. The data stays current,
						and the dataset is never changed.
					</p>
				</div>
				{(data?.sheets ?? []).length > 0 && (
					<button
						type="button"
						className={styles.primary}
						onClick={create}
						disabled={creating}
					>
						{creating ? "Creating" : "New sheet"}
					</button>
				)}
			</header>

			{error ? (
				<div className={styles.empty}>
					{describeFetchError(error, "list")}
				</div>
			) : isLoading ? (
				<SkeletonText lines={4} />
			) : (data?.sheets ?? []).length === 0 ? (
				<div className={styles.emptyLarge}>
					<span className={styles.emptyIcon} aria-hidden="true">
						<svg
							width="22"
							height="22"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18" />
						</svg>
					</span>
					<span className={styles.emptyText}>
						<h2 className={styles.emptyTitle}>No sheets yet</h2>
						<p className={styles.fieldHint}>
							Start one here, or open anything you build in
							Explore as a sheet.
						</p>
					</span>
					<button
						type="button"
						className={styles.primary}
						onClick={create}
						disabled={creating}
					>
						New sheet
					</button>
				</div>
			) : (
				<>
					{mine.length > 0 && (
						<section className={styles.listSection}>
							<h2 className={styles.sectionTitle}>Yours</h2>
							{list(mine)}
						</section>
					)}
					{shared.length > 0 && (
						<section className={styles.listSection}>
							<h2 className={styles.sectionTitle}>
								Shared with you
							</h2>
							{list(shared)}
						</section>
					)}
				</>
			)}
		</div>
	);
}
