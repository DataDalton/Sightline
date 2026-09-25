"use client";

import { useState } from "react";
import useSWR from "swr";
import { ago } from "../admin/when";
import { conversationsKey, useAssistant } from "./AssistantContext";
import styles from "./Assist.module.css";

// The person's past conversations, newest first. Opening one puts it back
// exactly as it was, with its steps and results as they came back then.

interface Summary {
	id: string;
	title: string;
	modifiedOn: string;
	questions: number;
}

function EmptyState() {
	return (
		<div className={styles.historyEmptyState}>
			<span className={styles.historyEmptyIcon} aria-hidden="true">
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
					<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z" />
					<path d="M8.5 10.5h7M8.5 13.5h4.5" />
				</svg>
			</span>
			<p className={styles.historyEmptyTitle}>No conversations yet</p>
			<p className={styles.historyEmptyText}>
				Conversations are saved here after their first answer.
			</p>
		</div>
	);
}

export function ConversationList({
	onOpened,
	compact = false,
}: {
	onOpened?: () => void;
	// The narrow list in the floating panel, where each row is one line.
	compact?: boolean;
}) {
	const { data, isLoading } = useSWR<{ conversations: Summary[] }>(
		conversationsKey,
	);
	const { conversationId, openConversation, deleteConversation, busy } =
		useAssistant();
	const [term, setTerm] = useState("");
	// Asked before deleting, on the row itself, so a stray click on the bin
	// does not lose a conversation.
	const [confirming, setConfirming] = useState<string | null>(null);

	const all = data?.conversations ?? [];
	const needle = term.trim().toLowerCase();
	const shown = needle
		? all.filter((c) => c.title.toLowerCase().includes(needle))
		: all;

	return (
		<div
			className={`${styles.history} ${compact ? styles.historyCompact : ""}`}
		>
			{all.length > 4 && (
				<input
					className={styles.historySearch}
					type="search"
					value={term}
					placeholder="Search conversations"
					aria-label="Search conversations"
					onChange={(e) => setTerm(e.target.value)}
				/>
			)}

			{isLoading && <p className={styles.historyEmpty}>Loading</p>}
			{!isLoading && all.length === 0 && <EmptyState />}
			{!isLoading && all.length > 0 && shown.length === 0 && (
				<p className={styles.historyEmpty}>
					No conversation matches that.
				</p>
			)}

			<ul className={styles.historyList}>
				{shown.map((c) => (
					<li
						key={c.id}
						className={`${styles.historyItem} ${
							c.id === conversationId ? styles.historyCurrent : ""
						}`}
					>
						<button
							type="button"
							className={styles.historyOpen}
							disabled={busy}
							onClick={() => {
								void openConversation(c.id).then(() =>
									onOpened?.(),
								);
							}}
						>
							<span className={styles.historyTitle}>
								{c.title}
							</span>
							<span className={styles.historyMeta}>
								{ago(c.modifiedOn)} · {c.questions}{" "}
								{c.questions === 1 ? "question" : "questions"}
							</span>
						</button>
						{confirming === c.id ? (
							<span className={styles.historyConfirm}>
								<button
									type="button"
									className={styles.historyDelete}
									onClick={() => {
										setConfirming(null);
										void deleteConversation(c.id);
									}}
								>
									Delete
								</button>
								<button
									type="button"
									className={styles.footButton}
									onClick={() => setConfirming(null)}
								>
									Keep
								</button>
							</span>
						) : (
							<button
								type="button"
								className={styles.iconButton}
								title="Delete this conversation"
								aria-label={`Delete ${c.title}`}
								onClick={() => setConfirming(c.id)}
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
								</svg>
							</button>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
