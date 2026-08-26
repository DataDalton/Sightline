"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { Select } from "../components/shared/Select";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Modal } from "../components/shared/Modal";
import { ShareDialog } from "../authoring/PageActions";
import { SkeletonCards } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { usePageTitle } from "../hooks/usePageTitle";
import {
	slotsComplete,
	TemplateChooser,
	type ChooserSource,
} from "../authoring/TemplateChooser";
import form from "../authoring/Authoring.module.css";
import styles from "./MyPages.module.css";

interface PersonalPage {
	reportId: string;
	slug: string;
	title: string;
	sourceKey: string | null;
	ownerEmail: string;
	modifiedOn: string;
	sharedWith: number;
}

interface Listing {
	mine: PersonalPage[];
	sharedWithMe: PersonalPage[];
	authored: PersonalPage[];
}

function when(iso: string): string {
	const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
	if (days < 1) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return `${days} days ago`;
	return `${Math.floor(days / 30)} months ago`;
}

export default function MyPagesView() {
	usePageTitle("My pages");

	const { data, isLoading, mutate } = useSWR<Listing>("/api/personal");
	const showSkeleton = useDeferredLoading(isLoading && !data);
	const [creating, setCreating] = useState(false);
	const [sharing, setSharing] = useState<PersonalPage | null>(null);
	const [removing, setRemoving] = useState<{
		page: PersonalPage;
		curated: boolean;
	} | null>(null);
	const [deleting, setDeleting] = useState(false);

	const mine = data?.mine ?? [];
	const shared = data?.sharedWithMe ?? [];
	const authored = data?.authored ?? [];

	// A curated report goes through the authoring path, which checks that the
	// caller could edit it. A personal page goes through its own, which checks
	// ownership.
	const remove = async () => {
		if (!removing) return;
		const { page, curated } = removing;
		setDeleting(true);
		try {
			await fetch(curated ? "/api/authoring" : "/api/personal", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(
					curated
						? { action: "removeReport", reportId: page.reportId }
						: { action: "remove", reportId: page.reportId },
				),
			});
			await mutate();
			setRemoving(null);
		} finally {
			setDeleting(false);
		}
	};

	// A card rather than a link wrapping everything: the actions on it are not
	// navigation, and a button inside an anchor is a click that does two things.
	//
	// Three kinds sit on this page and each answers a different question. Yours
	// can be shared and deleted. One you authored is curated, so sharing it is
	// not a thing it does. One shared with you is somebody else's, so it carries
	// their name and nothing to act with.
	const card = (page: PersonalPage, kind: "mine" | "authored" | "shared") => (
		<div key={page.reportId} className={styles.card}>
			<Link href={`/r/${page.slug}`} className={styles.cardTitle}>
				{page.title}
			</Link>
			<span className={styles.cardMeta}>
				{page.sourceKey && (
					<span className={styles.tag}>{page.sourceKey}</span>
				)}
				{kind === "shared" ? (
					<span>{page.ownerEmail}</span>
				) : kind === "mine" && page.sharedWith > 0 ? (
					<span>
						Shared with {page.sharedWith}
						{page.sharedWith === 1 ? " person" : " people"}
					</span>
				) : null}
				<span>{when(page.modifiedOn)}</span>
			</span>

			{kind !== "shared" && (
				<div className={styles.cardActions}>
					<Link
						href={`/r/${page.slug}?edit=1`}
						className={styles.cardAction}
					>
						Edit
					</Link>
					{kind === "mine" && (
						<button
							type="button"
							className={styles.cardAction}
							onClick={() => setSharing(page)}
						>
							Share
						</button>
					)}
					<button
						type="button"
						className={styles.cardAction}
						onClick={() =>
							setRemoving({ page, curated: kind === "authored" })
						}
					>
						Delete
					</button>
				</div>
			)}
		</div>
	);

	return (
		<div className={styles.page}>
			<div className={styles.heading}>
				<div>
					<h1 className={styles.title}>My pages</h1>
					<p className={styles.subtitle}>
						Visible to you and anyone you share them with.
					</p>
				</div>
			</div>

			{showSkeleton ? (
				<SkeletonCards count={4} />
			) : (
				<>
					<div className={styles.grid}>
						{mine.map((page) => card(page, "mine"))}
						<button
							type="button"
							className={styles.newCard}
							onClick={() => setCreating(true)}
						>
							<span
								className={styles.newCardPlus}
								aria-hidden="true"
							>
								+
							</span>
							New page
						</button>
					</div>

					{authored.length > 0 && (
						<>
							<div className={styles.sectionTitle}>
								Reports I author
								<span className={styles.sectionNote}>
									In a category, so everyone who can open it
									sees them
								</span>
							</div>
							<div className={styles.grid}>
								{authored.map((page) => card(page, "authored"))}
							</div>
						</>
					)}

					{shared.length > 0 && (
						<>
							<div className={styles.sectionTitle}>
								Shared with me
							</div>
							<div className={styles.grid}>
								{shared.map((page) => card(page, "shared"))}
							</div>
						</>
					)}
				</>
			)}

			{creating && (
				<NewPageDialog
					onClose={() => setCreating(false)}
					onCreated={() => void mutate()}
				/>
			)}

			{removing && (
				<ConfirmDialog
					title={
						removing.curated
							? "Delete this report"
							: "Delete this page"
					}
					body={
						removing.curated ? (
							<>
								<strong>{removing.page.title}</strong> is in a
								category, so everyone who can open it loses it.
							</>
						) : removing.page.sharedWith > 0 ? (
							<>
								<strong>{removing.page.title}</strong> will be
								removed, and the {removing.page.sharedWith}
								{removing.page.sharedWith === 1
									? " person"
									: " people"}{" "}
								it is shared with will lose it.
							</>
						) : (
							<>
								<strong>{removing.page.title}</strong> will be
								removed.
							</>
						)
					}
					busy={deleting}
					onConfirm={remove}
					onCancel={() => setRemoving(null)}
				/>
			)}

			{sharing && (
				<ShareDialog
					reportId={sharing.reportId}
					title={sharing.title}
					onClose={() => {
						setSharing(null);
						void mutate();
					}}
				/>
			)}
		</div>
	);
}

interface AuthoringOptions {
	sources: ChooserSource[];
}

interface ReportChoice {
	slug: string;
	title: string;
	categoryName: string | null;
}

function NewPageDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: () => void;
}) {
	const router = useRouter();
	const { data } = useSWR<AuthoringOptions>("/api/authoring");
	const { data: existing } = useSWR<{ reports: ReportChoice[] }>(
		"/api/personal?scope=copyable",
	);

	const [start, setStart] = useState<"new" | "copy">("new");
	const [title, setTitle] = useState("");
	const [sourceKey, setSourceKey] = useState("");
	const [template, setTemplate] = useState<string | null>(null);
	const [slots, setSlots] = useState<Record<string, string>>({});
	const [copyFrom, setCopyFrom] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const sources = data?.sources ?? [];
	const reports = existing?.reports ?? [];
	// Nothing to copy from, so the choice is not offered. A permanently disabled
	// option is a question nobody can answer.
	const canCopy = reports.length > 0;
	const source = sources.find((s) => s.sourceKey === sourceKey) ?? null;

	const ready =
		title.trim() !== "" &&
		(start === "copy"
			? copyFrom !== ""
			: sourceKey !== "" && slotsComplete(template, slots));

	const create = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/personal", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body:
					start === "copy"
						? JSON.stringify({
								action: "copy",
								slug: copyFrom,
								title,
							})
						: JSON.stringify({
								action: "create",
								title,
								sourceKey,
								template,
								slots,
							}),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(body?.error ?? "Could not create that page.");
				return;
			}
			onCreated();
			router.push(`/r/${body.slug}?edit=1`);
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not create that page.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal isOpen onClose={onClose} title="New page" width="720px">
			<div className={form.form}>
				<label className={form.field}>
					<span className={form.label}>Name</span>
					<input
						className={form.input}
						value={title}
						placeholder="Revenue by region"
						onChange={(e) => setTitle(e.target.value)}
						autoFocus
					/>
				</label>

				{canCopy && (
					<div className={styles.startRow}>
						<button
							type="button"
							className={`${styles.startOption} ${
								start === "new" ? styles.startOptionOn : ""
							}`}
							onClick={() => setStart("new")}
							aria-pressed={start === "new"}
						>
							<span className={styles.startName}>
								Build a new one
							</span>
							<span className={styles.startBlurb}>
								Pick a source and a layout.
							</span>
						</button>
						<button
							type="button"
							className={`${styles.startOption} ${
								start === "copy" ? styles.startOptionOn : ""
							}`}
							onClick={() => setStart("copy")}
							aria-pressed={start === "copy"}
						>
							<span className={styles.startName}>
								Start from a report
							</span>
							<span className={styles.startBlurb}>
								Copy one you can open, then change it.
							</span>
						</button>
					</div>
				)}

				{canCopy && start === "copy" ? (
					<label className={form.field}>
						<span className={form.label}>Copy of</span>
						<Select
							value={copyFrom}
							onChange={setCopyFrom}
							placeholder="Choose one"
							searchable={reports.length > 12}
							options={reports.map((r) => ({
								value: r.slug,
								label: r.title,
								note: r.categoryName ?? undefined,
							}))}
						/>
					</label>
				) : (
					<>
						<label className={form.field}>
							<span className={form.label}>Reads from</span>
							<Select
								value={sourceKey}
								onChange={(v) => {
									setSourceKey(v);
									setSlots({});
								}}
								placeholder="Choose one"
								searchable={sources.length > 12}
								options={sources.map((s) => ({
									value: s.sourceKey,
									label: s.title,
								}))}
							/>
						</label>

						<TemplateChooser
							source={source}
							template={template}
							slots={slots}
							onTemplate={setTemplate}
							onSlots={setSlots}
						/>
					</>
				)}

				{failure && <div className={form.failure}>{failure}</div>}

				<div className={form.actions}>
					<button
						type="button"
						className={form.secondary}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={form.primary}
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
