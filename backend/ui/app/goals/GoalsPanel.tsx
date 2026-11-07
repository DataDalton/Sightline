"use client";

import { useState } from "react";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { GoalDialog, postGoal, useGoals, type Goal } from "./PageGoals";
import styles from "../editor/Editor.module.css";

// The goals on a report, managed from its editor. A goal belongs to the report and shows on each
// of its pages holding the measure, so one whose measure has gone is listed here to be fixed.

export function GoalsPanel({
	pageId,
	pageTitle,
	onClose,
}: {
	pageId: string;
	pageTitle: string;
	onClose: () => void;
}) {
	const { data, mutate } = useGoals(pageId);
	const [editing, setEditing] = useState<Goal | "new" | null>(null);
	const [removing, setRemoving] = useState<Goal | null>(null);
	const canManage = data?.canManage ?? false;
	const measures = data?.measures ?? [];

	const row = (goal: Goal, where: string) => (
		<div key={goal.goalId} className={styles.listRow}>
			<span className={styles.listRowWords}>
				<strong>{goal.title}</strong>
				<span className={styles.panelAbout}>
					{goal.measure}
					{goal.filter ? `, ${goal.filter.value}` : ""}. {where}
				</span>
			</span>
			{canManage && (
				<div className={styles.listRowActions}>
					<button
						type="button"
						className={styles.rowAction}
						onClick={() => setEditing(goal)}
					>
						Change
					</button>
					<button
						type="button"
						className={styles.rowAction}
						onClick={() => setRemoving(goal)}
					>
						Remove
					</button>
				</div>
			)}
		</div>
	);

	return (
		<div className={styles.panel}>
			<div className={styles.panelHead}>
				<span className={styles.panelKind}>Goals</span>
				<span className={styles.panelSubject}>{pageTitle}</span>
				<button
					type="button"
					className={styles.panelBack}
					onClick={onClose}
					aria-label="Close"
				>
					×
				</button>
			</div>
			<div className={styles.panelBody}>
				<div className={styles.deckSections}>
					<section className={styles.deckSection}>
						<div className={styles.deckSectionHead}>
							<h3 className={styles.deckSectionTitle}>
								On this report
							</h3>
							{canManage && (
								<button
									type="button"
									className={styles.panelAdd}
									disabled={measures.length === 0}
									title={
										measures.length === 0
											? "Add a visual with a measure to this page first"
											: undefined
									}
									onClick={() => setEditing("new")}
								>
									Set a goal
								</button>
							)}
						</div>
						<p className={styles.panelAbout}>
							A target on a measure. Everyone who can open this
							report sees it on the pages showing that measure.
						</p>
						{data && data.all.length === 0 && (
							<p className={styles.panelEmpty}>
								No goals on this report yet.
							</p>
						)}
						{data?.all.map((goal) =>
							row(
								goal,
								data.goals.some(
									(held) => held.goalId === goal.goalId,
								)
									? "On this page."
									: goal.onAnyPage
										? "On another page."
										: "Not on any page, since no page shows this measure.",
							),
						)}
					</section>
				</div>
			</div>

			{editing && (
				<GoalDialog
					pageId={pageId}
					measures={
						editing !== "new" &&
						!measures.some(
							(held) =>
								held.sourceKey === editing.sourceKey &&
								held.measure === editing.measure,
						)
							? [
									...measures,
									{
										sourceKey: editing.sourceKey,
										sourceTitle: editing.sourceKey,
										measure: editing.measure,
										fields: [],
									},
								]
							: measures
					}
					start={editing === "new" ? null : editing}
					onSaved={() => {
						setEditing(null);
						void mutate();
					}}
					onClose={() => setEditing(null)}
				/>
			)}
			{removing && (
				<ConfirmDialog
					title="Remove this goal"
					body={
						<>
							<strong>{removing.title}</strong> stops being
							tracked.
						</>
					}
					confirmLabel="Remove"
					onConfirm={async () => {
						await postGoal({
							action: "remove",
							pageId,
							goalId: removing.goalId,
						});
						setRemoving(null);
						void mutate();
					}}
					onCancel={() => setRemoving(null)}
				/>
			)}
		</div>
	);
}
