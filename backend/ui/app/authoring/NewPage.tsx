"use client";

import { useState } from "react";
import { Modal } from "../components/shared/Modal";
import {
	slotsComplete,
	TemplateChooser,
	type ChooserSource,
} from "./TemplateChooser";
import styles from "./Authoring.module.css";

// Adding a page to a report that already exists.
//
// Two paths out of one dialog, because the two are genuinely different writes.
//
//   Blank goes through the editor's own addPage operation, which travels over
//   the live change feed so every open session applies the same insert. It has
//   to: two people can be editing when it happens.
//
//   A template does not. It carries a dozen visuals, and encoding that as a
//   dozen operations to keep the feed happy would be inventing work. It is one
//   server call, and the editor reloads afterwards.

export function NewPageDialog({
	source,
	reportId,
	onBlank,
	onCreated,
	onClose,
}: {
	// The source the report reads, which is what the template slots are filled
	// from. Null where the report has none, in which case only a blank page can
	// be made.
	source: ChooserSource | null;
	reportId: string;
	onBlank: (title: string) => void;
	// Handed the new page's id, because the editor has to move onto it. Its
	// state is seeded from its props once, so a page added underneath it would
	// leave it holding a report version one behind the server and the next save
	// would be rejected as stale.
	onCreated: (pageId: string) => void;
	onClose: () => void;
}) {
	const [title, setTitle] = useState("");
	const [template, setTemplate] = useState<string | null>(null);
	const [slots, setSlots] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const ready = title.trim() !== "" && slotsComplete(template, slots);

	const create = async () => {
		if (!template) {
			onBlank(title.trim());
			onClose();
			return;
		}

		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch("/api/authoring", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "addPage",
					reportId,
					title,
					sourceKey: source?.sourceKey ?? null,
					template,
					slots,
				}),
			});
			const detail = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(detail?.error ?? "Could not add that page.");
				return;
			}
			onCreated(String(detail?.pageId ?? ""));
			onClose();
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not add that page.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal isOpen onClose={onClose} title="Add a page" width="720px">
			<div className={styles.form}>
				<label className={styles.field}>
					<span className={styles.label}>Page name</span>
					<input
						className={styles.input}
						value={title}
						placeholder="Detail"
						onChange={(e) => setTitle(e.target.value)}
						autoFocus
					/>
				</label>

				{source ? (
					<TemplateChooser
						source={source}
						template={template}
						slots={slots}
						onTemplate={setTemplate}
						onSlots={setSlots}
					/>
				) : (
					<p className={styles.hint}>
						This report has no source, so the page starts blank.
					</p>
				)}

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
						{busy ? "Adding" : "Add page"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
