"use client";

import { useState } from "react";
import useSWR from "swr";
import type { Release } from "../../lib/work/releases";
import { DatePicker } from "../components/shared/DatePicker";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { postJson } from "./labels";
import styles from "./Work.module.css";

// Releases, worked from the board. Items join a release from their card, their
// page or the table, a release is made from any of those pickers, and it ships
// from its group on the board.

export const releasesKey = "/api/work/releases";

const newRelease = "__new";

export function useReleases() {
	const { data, mutate } = useSWR<{ releases: Release[] }>(releasesKey);
	return { releases: data?.releases ?? [], refresh: mutate };
}

export function releaseDate(target: string | null): string {
	if (!target) return "No date";
	const [year, month, day] = target.slice(0, 10).split("-").map(Number);
	return new Date(year, month - 1, day).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

// Chooses a release, or makes one and chooses it. Shipped releases are left
// out, since nothing joins a release once it is out.
export function ReleaseSelect({
	value,
	onChange,
	disabled,
	none = "No release",
}: {
	value: string;
	onChange: (releaseId: string) => void;
	disabled?: boolean;
	none?: string;
}) {
	const { releases, refresh } = useReleases();
	const [making, setMaking] = useState(false);
	return (
		<>
			<Select
				value={value}
				ariaLabel="Release"
				disabled={disabled}
				onChange={(next) => {
					if (next === newRelease) setMaking(true);
					else onChange(next);
				}}
				options={[
					{ value: "", label: none },
					...releases
						.filter((r) => !r.shippedOn || r.id === value)
						.map((r) => ({
							value: r.id,
							label: r.name,
							note: releaseDate(r.target),
						})),
					{ value: newRelease, label: "New release…" },
				]}
			/>
			{making && (
				<ReleaseDialog
					onClose={() => setMaking(false)}
					onSaved={async (id) => {
						await refresh();
						setMaking(false);
						onChange(id);
					}}
				/>
			)}
		</>
	);
}

// Makes a release, or changes one when given it.
export function ReleaseDialog({
	release,
	onClose,
	onSaved,
}: {
	release?: Release;
	onClose: () => void;
	onSaved: (releaseId: string) => void;
}) {
	const [name, setName] = useState(release?.name ?? "");
	const [target, setTarget] = useState(release?.target?.slice(0, 10) ?? "");
	const [notes, setNotes] = useState(release?.notes ?? "");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const save = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const answer = await postJson(releasesKey, {
				id: release?.id ?? null,
				name: name.trim(),
				target: target || null,
				notes,
			});
			onSaved(String(answer.id ?? release?.id ?? ""));
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "It could not be saved.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={release ? `Edit ${release.name}` : "New release"}
			width="520px"
		>
			<div className={styles.form}>
				<label className={styles.field}>
					<span>Name</span>
					<input
						className={styles.input}
						value={name}
						maxLength={120}
						placeholder="Such as Q1 2027"
						autoFocus
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
				<label className={styles.field}>
					<span>Date</span>
					<DatePicker
						size="form"
						value={target}
						ariaLabel="Date"
						placeholder="Choose a date"
						onChange={setTarget}
					/>
					<span className={styles.hint}>
						Every item in the release takes this as its target.
					</span>
				</label>
				<label className={styles.field}>
					<span>Notes</span>
					<textarea
						className={styles.input}
						rows={3}
						value={notes}
						placeholder="What it brings, used for the release notes"
						onChange={(e) => setNotes(e.target.value)}
					/>
				</label>
				{failure && <p className={styles.failure}>{failure}</p>}
				<div className={styles.formActions}>
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
						disabled={busy || !name.trim()}
						onClick={() => void save()}
					>
						{busy ? "Saving" : release ? "Save" : "Create release"}
					</button>
				</div>
			</div>
		</Modal>
	);
}

export function ShipDialog({
	release,
	onClose,
	onShipped,
}: {
	release: Release;
	onClose: () => void;
	onShipped: () => void;
}) {
	const [postNotes, setPostNotes] = useState(true);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const ship = async () => {
		setBusy(true);
		setFailure(null);
		try {
			await postJson(releasesKey, { ship: release.id, postNotes });
			onShipped();
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "It could not be shipped.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={`Ship ${release.name}`}
			width="520px"
		>
			<div className={styles.form}>
				<p className={styles.lead}>
					{release.done} of {release.items}{" "}
					{release.items === 1 ? "item is" : "items are"} done.
				</p>
				<Toggle
					checked={postNotes}
					onChange={setPostNotes}
					label="Post release notes to Updates, listing every item in it. Each item moves to Done once the update is out."
				/>
				{failure && <p className={styles.failure}>{failure}</p>}
				<div className={styles.formActions}>
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
						disabled={busy}
						onClick={() => void ship()}
					>
						{busy ? "Shipping" : "Ship"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
