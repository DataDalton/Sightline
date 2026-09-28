"use client";

import { useState } from "react";
import Link from "next/link";
import { useSWRConfig } from "swr";
import { Modal } from "../components/shared/Modal";
import type { CategoryContact } from "../components/CategoryContacts";
import styles from "./Messages.module.css";

// Asking the people who maintain a category something.
//
// Sent through the application rather than by email, so a group can be asked
// as easily as a person, and the answer comes back to the inbox where the
// conversation carries on. Everyone is ticked to begin with, or only the one
// somebody clicked on, and any of them can be ticked or unticked before
// sending.

export interface ComposerContext {
	// Exactly one of these. A report takes its own category.
	categoryId?: string;
	reportSlug?: string;
	// What it is about, for the subject and the heading.
	about: string;
}

const keyOf = (c: CategoryContact) =>
	`${c.kind === "person" ? "user" : "group"}:${c.id}`;

export function Composer({
	context,
	contacts,
	only,
	onClose,
}: {
	context: ComposerContext;
	contacts: CategoryContact[];
	// The one maintainer somebody clicked, when they clicked one.
	only?: CategoryContact;
	onClose: () => void;
}) {
	const { mutate } = useSWRConfig();
	const [chosen, setChosen] = useState<Set<string>>(
		() => new Set(only ? [keyOf(only)] : contacts.map(keyOf)),
	);
	const [subject, setSubject] = useState(`About ${context.about}`);
	const [body, setBody] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState<string | null>(null);

	const toggle = (key: string) =>
		setChosen((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	const ready = chosen.size > 0 && body.trim().length > 0 && !sending;

	const send = async () => {
		if (!ready) return;
		setSending(true);
		setError(null);
		try {
			const response = await fetch("/api/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					categoryId: context.categoryId,
					reportSlug: context.reportSlug,
					subject,
					body,
					recipients: contacts
						.filter((c) => chosen.has(keyOf(c)))
						.map((c) => ({
							type: c.kind === "person" ? "user" : "group",
							id: c.id,
						})),
				}),
			});
			const result = (await response.json().catch(() => ({}))) as {
				threadId?: string;
				error?: string;
			};
			if (!response.ok || !result.threadId) {
				setError(result.error ?? "It could not be sent. Try again.");
				return;
			}
			setSent(result.threadId);
			void mutate("/api/messages");
		} finally {
			setSending(false);
		}
	};

	if (sent) {
		return (
			<Modal isOpen onClose={onClose} title="Sent" width="480px">
				<div className={styles.sent}>
					<p>
						Your question is with them. Replies arrive in your
						inbox, and you can carry on the conversation there.
					</p>
					<div className={styles.sentActions}>
						<Link
							href={`/inbox/?view=conversations&thread=${sent}`}
							className={styles.primary}
							onClick={onClose}
						>
							Open the conversation
						</Link>
						<button
							type="button"
							className={styles.secondary}
							onClick={onClose}
						>
							Done
						</button>
					</div>
				</div>
			</Modal>
		);
	}

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={`Ask about ${context.about}`}
			width="560px"
			footer={
				<>
					{error && <span className={styles.formError}>{error}</span>}
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
						onClick={send}
						disabled={!ready}
					>
						{sending ? "Sending" : "Send"}
					</button>
				</>
			}
		>
			<div className={styles.form}>
				<div className={styles.field}>
					<span className={styles.fieldLabel}>To</span>
					<div className={styles.recipients}>
						{contacts.map((contact) => {
							const key = keyOf(contact);
							const on = chosen.has(key);
							return (
								<button
									key={key}
									type="button"
									className={`${styles.recipient} ${
										on ? styles.recipientOn : ""
									}`}
									aria-pressed={on}
									onClick={() => toggle(key)}
								>
									<span
										className={styles.tick}
										aria-hidden="true"
									>
										{on && (
											<svg
												width="10"
												height="10"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="3.5"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M20 6L9 17l-5-5" />
											</svg>
										)}
									</span>
									{contact.name}
									{contact.kind === "group" && (
										<span className={styles.groupTag}>
											Group
										</span>
									)}
								</button>
							);
						})}
					</div>
					{[...chosen].some((k) => k.startsWith("group:")) && (
						<span className={styles.fieldHint}>
							Everyone in a group sees the conversation and can
							reply.
						</span>
					)}
				</div>

				<label className={styles.field}>
					<span className={styles.fieldLabel}>Subject</span>
					<input
						className={styles.input}
						value={subject}
						maxLength={200}
						onChange={(e) => setSubject(e.target.value)}
					/>
				</label>

				<label className={styles.field}>
					<span className={styles.fieldLabel}>Message</span>
					<textarea
						className={`${styles.input} ${styles.textarea}`}
						value={body}
						maxLength={4000}
						rows={6}
						autoFocus
						placeholder="What would you like to know? Name the figure or the filter if it is about one."
						onChange={(e) => setBody(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								void send();
							}
						}}
					/>
				</label>
			</div>
		</Modal>
	);
}
