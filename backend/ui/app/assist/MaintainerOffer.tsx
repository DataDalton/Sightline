"use client";

import { useState } from "react";
import type { MaintainerOffer } from "../../lib/assistant/events";
import { useAssistantStatus } from "./AssistantContext";
import styles from "./Assist.module.css";

// The assistant's offer to put somebody in touch with a report's maintainers.
//
// Nothing is sent until they press Start, and their conversation with the
// assistant goes with it only if they tick the box. The rows its queries
// returned never go, since the maintainers may not be allowed to see them.
export function MaintainerOfferCard({ offer }: { offer: MaintainerOffer }) {
	const { conversationId } = useAssistantStatus();
	const [share, setShare] = useState(false);
	const [message, setMessage] = useState(offer.message);
	const [state, setState] = useState<
		"open" | "sending" | "sent" | "declined"
	>("open");
	const [threadId, setThreadId] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const start = async () => {
		setState("sending");
		setFailure(null);
		try {
			const response = await fetch("/api/feedback/maintainers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					reportSlug: offer.reportSlug,
					visualId: offer.visualId,
					subject: offer.subject,
					message,
					checked: offer.checked,
					shareConversationId: share ? conversationId : undefined,
				}),
			});
			const body = (await response.json().catch(() => null)) as {
				threadId?: string;
				error?: string;
			} | null;
			if (!response.ok || !body?.threadId) {
				throw new Error(body?.error ?? "It could not be sent.");
			}
			setThreadId(body.threadId);
			setState("sent");
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "It could not be sent.",
			);
			setState("open");
		}
	};

	if (state === "declined") {
		return (
			<p className={styles.offerNote}>
				Not sent. You can ask the maintainers from the report at any
				time.
			</p>
		);
	}

	if (state === "sent" && threadId) {
		return (
			<a
				href={`/inbox/?view=conversations&thread=${threadId}`}
				className={styles.created}
			>
				<span className={styles.createdKind}>Conversation started</span>
				<span className={styles.createdTitle}>{offer.subject}</span>
				<span className={styles.createdOpen}>Open it</span>
			</a>
		);
	}

	return (
		<div className={styles.offer}>
			<span className={styles.createdKind}>
				Ask the maintainers of {offer.reportTitle}
			</span>
			<p className={styles.offerLead}>
				The people who look after this report can check it. I&apos;ll
				join the conversation and tell them what I already checked.
			</p>
			<label className={styles.offerField}>
				<span>Your message</span>
				<textarea
					className={styles.offerInput}
					rows={3}
					value={message}
					onChange={(e) => setMessage(e.target.value)}
				/>
			</label>
			<label className={styles.offerShare}>
				<input
					type="checkbox"
					checked={share}
					disabled={!conversationId}
					onChange={(e) => setShare(e.target.checked)}
				/>
				<span>
					Share this conversation with them. They see your questions,
					my answers and what I queried, but not the rows the queries
					returned.
				</span>
			</label>
			{failure && <p className={styles.failure}>{failure}</p>}
			<div className={styles.offerActions}>
				<button
					type="button"
					className={styles.offerSecondary}
					onClick={() => setState("declined")}
				>
					Not now
				</button>
				<button
					type="button"
					className={styles.offerPrimary}
					disabled={state === "sending" || !message.trim()}
					onClick={() => void start()}
				>
					{state === "sending" ? "Starting" : "Start conversation"}
				</button>
			</div>
		</div>
	);
}
