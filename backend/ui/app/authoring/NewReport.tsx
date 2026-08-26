"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { Modal } from "../components/shared/Modal";
import { useUser } from "../context/UserContext";
import {
	slotsComplete,
	TemplateChooser,
	type ChooserSource,
} from "./TemplateChooser";
import { Select } from "../components/shared/Select";
import styles from "./Authoring.module.css";

// Creating a report, without leaving the application.
//
// Until this existed there was no INSERT against the reports table anywhere in
// the codebase. Standing up a new one meant somebody writing SQL against the
// platform store by hand, and the first page then had to be built from an empty
// grid one visual at a time. Both halves are here: where it goes and what it
// reads, then the shape it starts in.

interface AuthoringOptions {
	sources: ChooserSource[];
	// Only the ones this caller may create a report in. Somebody scoped to a
	// single subject area sees that one, rather than a list they would be
	// refused from.
	categories: { id: string; name: string }[];
}

export function NewReportButton({
	categoryId,
	label = "New report",
	className,
}: {
	// Preselected when opened from inside a category.
	categoryId?: string;
	label?: string;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const { user } = useUser();

	// Loaded only once the dialog is asked for, so a reader does not pay for
	// the source list on every page.
	const { data } = useSWR<AuthoringOptions>(open ? "/api/authoring" : null);

	if (!user?.capabilities?.includes("report.create")) return null;

	return (
		<>
			<button
				type="button"
				className={className ?? styles.openButton}
				onClick={() => setOpen(true)}
			>
				<span aria-hidden="true">+</span> {label}
			</button>
			{open && (
				<NewReportDialog
					options={data}
					categoryId={categoryId}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

function NewReportDialog({
	options,
	categoryId,
	onClose,
}: {
	options: AuthoringOptions | undefined;
	categoryId?: string;
	onClose: () => void;
}) {
	const router = useRouter();

	const [title, setTitle] = useState("");
	const [category, setCategory] = useState(categoryId ?? "");
	const [sourceKey, setSourceKey] = useState("");
	const [template, setTemplate] = useState<string | null>(null);
	const [slots, setSlots] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const loading = options === undefined;
	const sources = options?.sources ?? [];
	const categories = options?.categories ?? [];
	const source = sources.find((s) => s.sourceKey === sourceKey) ?? null;

	// A source is required. Without one every visual on the page has nothing to
	// read, which shows as an empty field picker rather than an error, so the
	// report looks broken instead of unfinished.
	const ready =
		title.trim() !== "" &&
		category !== "" &&
		sourceKey !== "" &&
		slotsComplete(template, slots);

	const create = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/authoring", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "createReport",
					title,
					categoryId: category,
					sourceKey: sourceKey || null,
					template,
					slots,
				}),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(body?.error ?? "Could not create that report.");
				return;
			}
			// Straight into the editor. The author came here to build something,
			// and landing on the read-only view would make them find the report
			// again and press Edit.
			router.push(`/r/${body.slug}?edit=1`);
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not create that report.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal isOpen onClose={onClose} title="New report" width="720px">
			<div className={styles.form}>
				<div className={styles.row}>
					<label className={styles.field}>
						<span className={styles.label}>Title</span>
						<input
							className={styles.input}
							value={title}
							placeholder="Weekly summary"
							onChange={(e) => setTitle(e.target.value)}
							autoFocus
						/>
					</label>

					<label className={styles.field}>
						<span className={styles.label}>Category</span>
						<Select
							value={category}
							onChange={setCategory}
							placeholder={loading ? "Loading" : "Choose one"}
							options={categories.map((c) => ({
								value: c.id,
								label: c.name,
							}))}
						/>
						{!loading && categories.length === 0 && (
							<span className={styles.hint}>
								No categories you can add to.
							</span>
						)}
					</label>
				</div>

				<label className={styles.field}>
					<span className={styles.label}>Reads from</span>
					<Select
						value={sourceKey}
						onChange={(v) => {
							setSourceKey(v);
							// The slots hold field names from the previous source, which this
							// one may not define.
							setSlots({});
						}}
						placeholder={loading ? "Loading" : "Choose one"}
						searchable={sources.length > 12}
						options={sources.map((s) => ({
							value: s.sourceKey,
							label: s.title,
						}))}
					/>
					{!loading && sources.length === 0 && (
						<span className={styles.hint}>
							No sources have been added yet. An administrator
							adds them under Administration, Platform, Sources.
						</span>
					)}
				</label>

				<TemplateChooser
					source={source}
					template={template}
					slots={slots}
					onTemplate={setTemplate}
					onSlots={setSlots}
				/>

				{failure && <div className={styles.failure}>{failure}</div>}

				<div className={styles.actions}>
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
						disabled={busy || !ready}
						onClick={create}
					>
						{busy ? "Creating" : "Create"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
