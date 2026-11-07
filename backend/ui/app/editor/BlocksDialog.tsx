"use client";

import { useState } from "react";
import useSWR from "swr";
import type { BlockVisual } from "../../lib/visuals/blocks";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Modal } from "../components/shared/Modal";
import form from "../authoring/Authoring.module.css";
import styles from "./Editor.module.css";
import type { EditableVisual } from "./types";

// Saving selected visuals as a block, dropping a block on the page, and changing one.

interface Block {
	blockId: string;
	name: string;
	description: string | null;
	visuals: BlockVisual[];
	createdBy: string;
	usedIn: number;
	canChange: boolean;
}

function asBlockInput(visual: EditableVisual) {
	return {
		visualType: visual.visualType,
		title: visual.title,
		sourceKey: visual.sourceKey,
		config: visual.config,
		layout: visual.layout,
	};
}

export function BlocksDialog({
	selected,
	onPlace,
	onLinked,
	onClose,
}: {
	selected: EditableVisual[];
	onPlace: (block: { blockId: string; visuals: BlockVisual[] }) => void;
	// The selected visuals now belong to this block, in the order they were sent.
	onLinked: (block: { blockId: string; visuals: BlockVisual[] }) => void;
	onClose: () => void;
}) {
	const { data, mutate } = useSWR<{ blocks: Block[] }>("/api/blocks");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [result, setResult] = useState<string | null>(null);
	const [removing, setRemoving] = useState<Block | null>(null);

	const post = async (body: Record<string, unknown>) => {
		setBusy(true);
		setFailure(null);
		setResult(null);
		try {
			const response = await fetch("/api/blocks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const detail = await response.json().catch(() => null);
			if (!response.ok) {
				setFailure(detail?.error ?? "That did not work.");
				return null;
			}
			await mutate();
			return detail;
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
			return null;
		} finally {
			setBusy(false);
		}
	};

	const blocks = data?.blocks ?? [];

	return (
		<Modal isOpen onClose={onClose} title="Blocks" width="620px">
			<div className={styles.deckSections}>
				<p className={styles.panelAbout}>
					A block is a set of visuals other reports can use. Updating
					a block updates it everywhere it is used.
				</p>

				<section className={styles.blockSection}>
					<h3 className={styles.deckSectionTitle}>
						Save what is selected
					</h3>
					{selected.length === 0 ? (
						<p className={styles.panelEmpty}>
							Close this and select visuals on the page, then open
							Blocks again to save them.
						</p>
					) : (
						<div className={styles.blockSave}>
							<input
								className={form.input}
								value={name}
								placeholder="Name, such as Regional summary"
								aria-label="Block name"
								onChange={(e) => setName(e.target.value)}
							/>
							<button
								type="button"
								className={form.primary}
								disabled={busy || !name.trim()}
								onClick={async () => {
									const detail = await post({
										action: "create",
										name,
										visuals: selected.map(asBlockInput),
									});
									if (detail) {
										onLinked(detail.block);
										setName("");
										setResult(
											`Saved. These visuals now follow "${detail.block.name}".`,
										);
									}
								}}
							>
								Save {selected.length} visual
								{selected.length === 1 ? "" : "s"}
							</button>
						</div>
					)}
				</section>

				<section className={styles.blockSection}>
					<h3 className={styles.deckSectionTitle}>Blocks</h3>
					{blocks.length === 0 && data && (
						<p className={styles.panelEmpty}>No blocks yet.</p>
					)}
					{blocks.map((block) => (
						<div key={block.blockId} className={styles.listRow}>
							<span className={styles.listRowWords}>
								<strong>{block.name}</strong>
								<span className={styles.panelAbout}>
									{block.visuals.length} visual
									{block.visuals.length === 1 ? "" : "s"}, in{" "}
									{block.usedIn} report
									{block.usedIn === 1 ? "" : "s"}. Built by{" "}
									{block.createdBy}.
								</span>
							</span>
							<div className={styles.listRowActions}>
								<button
									type="button"
									className={styles.panelAdd}
									disabled={busy}
									onClick={() => {
										onPlace(block);
										onClose();
									}}
								>
									Add to this page
								</button>
								{block.canChange && selected.length > 0 && (
									<button
										type="button"
										className={styles.panelAdd}
										disabled={busy}
										title="Replaces this block with what is selected, everywhere it is used"
										onClick={async () => {
											const detail = await post({
												action: "update",
												blockId: block.blockId,
												visuals:
													selected.map(asBlockInput),
											});
											if (detail) {
												onLinked({
													blockId: block.blockId,
													visuals: detail.visuals,
												});
												const held = detail.lockedOut
													.length
													? ` Locked, so left as they were: ${detail.lockedOut.join(", ")}.`
													: "";
												setResult(
													`Updated ${detail.updated.length} report${detail.updated.length === 1 ? "" : "s"}.${held}`,
												);
											}
										}}
									>
										Update from selection
									</button>
								)}
								{block.canChange && (
									<button
										type="button"
										className={styles.panelAdd}
										disabled={busy}
										onClick={() => setRemoving(block)}
									>
										Remove
									</button>
								)}
							</div>
						</div>
					))}
				</section>

				{result && <p className={styles.panelAbout}>{result}</p>}
				{failure && <div className={form.failure}>{failure}</div>}
			</div>

			{removing && (
				<ConfirmDialog
					title="Remove this block"
					body={
						<>
							<strong>{removing.name}</strong> stops being
							offered. What is already on pages stays there and
							stops following it.
						</>
					}
					confirmLabel="Remove block"
					busy={busy}
					onConfirm={async () => {
						await post({
							action: "remove",
							blockId: removing.blockId,
						});
						setRemoving(null);
					}}
					onCancel={() => setRemoving(null)}
				/>
			)}
		</Modal>
	);
}
