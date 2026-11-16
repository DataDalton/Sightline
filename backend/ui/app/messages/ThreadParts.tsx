"use client";

import { useState } from "react";
import useSWR from "swr";
import type { SharedTurn } from "../../lib/feedback/sharedLog";
import styles from "./Messages.module.css";

// The parts of a conversation the assistant brings: a change it proposes, with
// Apply and Suggest, and the assistant conversation the person chose to share.

interface ProposalPayload {
	reportSlug?: string | null;
	visualTitle?: string | null;
	before?: {
		visualType?: string;
		title?: string | null;
		dimensions?: string[];
		measures?: string[];
	};
	after?: {
		visualType?: string;
		title?: string | null;
		dimensions?: string[];
		measures?: string[];
	};
	state?: "open" | "applied" | "suggested";
	by?: string;
	version?: number;
}

function describe(shape: ProposalPayload["after"]): string {
	if (!shape) return "";
	const fields = [
		...(shape.measures ?? []),
		...(shape.dimensions?.length
			? [`by ${shape.dimensions.join(", ")}`]
			: []),
	].join(" ");
	return `${shape.title ?? "Untitled"}, a ${shape.visualType ?? "visual"}${fields ? ` of ${fields}` : ""}`;
}

export function ProposalCard({
	threadKey,
	messageId,
	body,
	payload,
	onDone,
}: {
	threadKey: string;
	messageId: string;
	body: string;
	payload: ProposalPayload | null;
	onDone: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	if (!payload) return <p className={styles.bubble}>{body}</p>;

	const decide = async (action: "apply" | "suggest") => {
		setBusy(true);
		setFailure(null);
		try {
			const response = await fetch(threadKey, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, messageId }),
			});
			if (!response.ok) {
				const result = (await response.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(result.error ?? "That did not work.");
			}
			onDone();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={styles.proposal}>
			<span className={styles.proposalKind}>Proposed change</span>
			<p className={styles.proposalWhy}>{body}</p>
			{payload.before && payload.after && (
				<dl className={styles.proposalChange}>
					<dt>Now</dt>
					<dd>{describe(payload.before)}</dd>
					<dt>After</dt>
					<dd>{describe(payload.after)}</dd>
				</dl>
			)}
			{payload.state === "applied" ? (
				<span className={styles.proposalState}>
					Applied by {payload.by}
					{payload.version ? `, version ${payload.version}` : ""}
				</span>
			) : payload.state === "suggested" ? (
				<span className={styles.proposalState}>
					Suggested by {payload.by}, waiting for a maintainer
				</span>
			) : (
				<div className={styles.proposalActions}>
					<button
						type="button"
						className={styles.proposalSecondary}
						disabled={busy}
						onClick={() => void decide("suggest")}
						title="Send it to the report's maintainers to approve"
					>
						Suggest
					</button>
					<button
						type="button"
						className={styles.proposalPrimary}
						disabled={busy}
						onClick={() => void decide("apply")}
						title="Make the change now, if you can edit this report"
					>
						Apply
					</button>
				</div>
			)}
			{failure && <span className={styles.formError}>{failure}</span>}
		</div>
	);
}

export function SharedConversation({ threadKey }: { threadKey: string }) {
	const [open, setOpen] = useState(false);
	const { data } = useSWR<{ turns: SharedTurn[] }>(
		open ? `${threadKey}?log=1` : null,
	);
	return (
		<div className={styles.shared}>
			<button
				type="button"
				className={styles.sharedToggle}
				aria-expanded={open}
				onClick={() => setOpen((held) => !held)}
			>
				{open ? "Hide" : "Show"} the conversation with the assistant
				they shared
			</button>
			{open && (
				<div className={styles.sharedBody}>
					<p className={styles.sharedNote}>
						Questions, answers and what was queried. The rows the
						queries returned are not shared.
					</p>
					{(data?.turns ?? []).map((turn, index) =>
						turn.role === "user" ? (
							<p key={index} className={styles.sharedAsked}>
								{turn.content}
								{turn.pointedAt.length > 0 && (
									<span className={styles.sharedMeta}>
										{" "}
										Pointing at {turn.pointedAt.join(", ")}
									</span>
								)}
							</p>
						) : (
							<div key={index} className={styles.sharedAnswer}>
								{turn.steps.map((step, i) => (
									<span key={i} className={styles.sharedMeta}>
										{step.label}
										{step.summary
											? `, ${step.summary}`
											: ""}
									</span>
								))}
								{turn.answer && <p>{turn.answer}</p>}
							</div>
						),
					)}
				</div>
			)}
		</div>
	);
}
