"use client";

import { useState } from "react";
import { Modal } from "../components/shared/Modal";
import { Toggle } from "../components/shared/Toggle";
import { Hint } from "./PanelSection";
import {
	effective,
	type PageProtection,
	type ReportProtection,
} from "../../lib/platform/pageProtection";
import styles from "./Editor.module.css";

// Locking a report, or the pages in it.
//
// Two switches rather than one, because they answer different worries. A page
// that has been signed off usually needs to survive somebody tidying up the
// report while still being correctable when a figure is wrong. A page quoted in
// a board pack needs the opposite: it must stop moving, but it can still be
// retired.
//
// Two scopes for the same reason. Locking the whole report is the common case
// and covers pages added later; locking one page is for the report where a
// single sheet is the one that matters.
//
// Both scopes are edited and then saved, rather than one saving on the spot and
// the other on a button. The same gesture should mean the same thing on both
// tabs, and a switch that writes the instant it moves gives an author no way to
// change their mind before it lands.
//
// The report's locks and a page's own combine rather than one overriding the
// other, so a page locked by its report says so and offers no switch that would
// appear to lift it. The refusal that decides anything is the server's: every
// write goes through applyEdits.

export interface PageLock {
	pageId: string;
	title: string;
	protectDelete: boolean;
	protectEdit: boolean;
}

const deleteLabel = "Prevent deletion";
const editLabel = "Prevent changes";
const addLabel = "Prevent new pages";

export function ProtectDialog({
	reportTitle,
	report,
	pages,
	busy,
	onSaveReport,
	onSavePages,
	onClose,
}: {
	reportTitle: string;
	report: ReportProtection;
	pages: PageLock[];
	busy: boolean;
	onSaveReport: (next: ReportProtection) => void;
	onSavePages: (changed: PageLock[]) => void;
	onClose: () => void;
}) {
	const [scope, setScope] = useState<"report" | "pages">("report");
	const [draft, setDraft] = useState<ReportProtection>(report);
	const [pageDraft, setPageDraft] = useState<PageLock[]>(pages);

	const reportChanged =
		draft.protectDelete !== report.protectDelete ||
		draft.protectEdit !== report.protectEdit ||
		draft.protectAddPage !== report.protectAddPage;

	const changedPages = pageDraft.filter((next) => {
		const before = pages.find((p) => p.pageId === next.pageId);
		return (
			before &&
			(before.protectDelete !== next.protectDelete ||
				before.protectEdit !== next.protectEdit)
		);
	});

	const setPage = (pageId: string, patch: Partial<PageLock>) =>
		setPageDraft((prev) =>
			prev.map((p) => (p.pageId === pageId ? { ...p, ...patch } : p)),
		);

	return (
		<Modal isOpen onClose={onClose} title="Protection" width="540px">
			<div className={styles.protectBody}>
				<div className={styles.tabs} role="tablist">
					<button
						type="button"
						role="tab"
						aria-selected={scope === "report"}
						className={`${styles.tab} ${scope === "report" ? styles.tabActive : ""}`}
						onClick={() => setScope("report")}
					>
						Whole report
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={scope === "pages"}
						className={`${styles.tab} ${scope === "pages" ? styles.tabActive : ""}`}
						onClick={() => setScope("pages")}
					>
						Individual pages
					</button>
				</div>

				{scope === "report" ? (
					<>
						<p className={styles.protectIntro}>
							What every page of <strong>{reportTitle}</strong>{" "}
							refuses, including pages added later.
						</p>

						<div className={styles.protectOption}>
							<Toggle
								checked={draft.protectDelete}
								onChange={(next) =>
									setDraft((d) => ({
										...d,
										protectDelete: next,
									}))
								}
								label={deleteLabel}
								disabled={busy}
							/>
							<Hint>
								No page can be removed from the report. Pages
								can still be edited.
							</Hint>
						</div>

						<div className={styles.protectOption}>
							<Toggle
								checked={draft.protectEdit}
								onChange={(next) =>
									setDraft((d) => ({
										...d,
										protectEdit: next,
									}))
								}
								label={editLabel}
								disabled={busy}
							/>
							<Hint>
								Visuals, layout and page settings are read-only
								throughout. Pages can still be deleted.
							</Hint>
						</div>

						{/* Report scope only. A page cannot stop a page that
						    does not exist yet from being created, so this has
						    no counterpart on the other tab. */}
						<div className={styles.protectOption}>
							<Toggle
								checked={draft.protectAddPage}
								onChange={(next) =>
									setDraft((d) => ({
										...d,
										protectAddPage: next,
									}))
								}
								label={addLabel}
								disabled={busy}
							/>
							<Hint>
								No page can be added to the report. The pages
								already on it are unaffected.
							</Hint>
						</div>

						<div className={styles.protectActions}>
							<button
								type="button"
								className={styles.discardButton}
								onClick={onClose}
								disabled={busy}
							>
								Close
							</button>
							<button
								type="button"
								className={styles.saveButton}
								onClick={() => onSaveReport(draft)}
								disabled={busy || !reportChanged}
							>
								{busy ? "Saving" : "Save protection"}
							</button>
						</div>
					</>
				) : (
					<>
						<p className={styles.protectIntro}>
							A lock on one page, on top of whatever{" "}
							<strong>{reportTitle}</strong> itself is set to.
						</p>

						<div className={styles.lockList}>
							<div className={styles.lockHead}>
								<span className={styles.lockRowName}>Page</span>
								<span className={styles.lockHeadLabel}>
									{deleteLabel}
								</span>
								<span className={styles.lockHeadLabel}>
									{editLabel}
								</span>
							</div>

							{pageDraft.map((page) => {
								const own: PageProtection = {
									protectDelete: page.protectDelete,
									protectEdit: page.protectEdit,
								};
								const net = effective(report, own);
								return (
									<div
										key={page.pageId}
										className={styles.lockRow}
									>
										<span className={styles.lockRowName}>
											{page.title}
										</span>
										<LockCell
											label={`${deleteLabel} on ${page.title}`}
											checked={net.protectDelete}
											// Set by the report, so the cell
											// says so rather than offering to
											// lift what it cannot.
											fromReport={report.protectDelete}
											busy={busy}
											onChange={(v) =>
												setPage(page.pageId, {
													protectDelete: v,
												})
											}
										/>
										<LockCell
											label={`${editLabel} on ${page.title}`}
											checked={net.protectEdit}
											fromReport={report.protectEdit}
											busy={busy}
											onChange={(v) =>
												setPage(page.pageId, {
													protectEdit: v,
												})
											}
										/>
									</div>
								);
							})}
						</div>

						{(report.protectDelete || report.protectEdit) && (
							<Hint>
								Some of these are set by the whole report and
								cannot be lifted here.
							</Hint>
						)}

						<div className={styles.protectActions}>
							<button
								type="button"
								className={styles.discardButton}
								onClick={onClose}
								disabled={busy}
							>
								Close
							</button>
							<button
								type="button"
								className={styles.saveButton}
								onClick={() => onSavePages(changedPages)}
								disabled={busy || changedPages.length === 0}
							>
								{busy
									? "Saving"
									: changedPages.length > 1
										? `Save ${changedPages.length} pages`
										: "Save protection"}
							</button>
						</div>
					</>
				)}
			</div>
		</Modal>
	);
}

function LockCell({
	label,
	checked,
	fromReport,
	busy,
	onChange,
}: {
	label: string;
	checked: boolean;
	fromReport: boolean;
	busy: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<span
			className={`${styles.lockCell} ${fromReport ? styles.lockCellFixed : ""}`}
			title={
				fromReport
					? "Set by the whole report. Change it on the other tab."
					: undefined
			}
		>
			<input
				type="checkbox"
				aria-label={label}
				checked={checked}
				disabled={busy || fromReport}
				onChange={(e) => onChange(e.target.checked)}
			/>
		</span>
	);
}
