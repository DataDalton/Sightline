"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { ThreadMessage, ThreadSummary } from "../../lib/messages/store";
import { describeFetchError } from "../../lib/swr";
import styles from "./Messages.module.css";

// Conversations with the people who maintain categories, from both sides.
//
// The list on the left and the open conversation on the right, the way a mail
// program lays them out. On a phone only one fits, so the list gives way to
// the conversation and a back button returns to it.
//
// An open conversation is asked for again every few seconds, so a reply lands
// while somebody is looking at it rather than on their next visit.

export const conversationsKey = "/api/messages";

const refreshMs = 8000;
// The app-wide dedupe window is longer than refreshMs, and a poll inside it
// reuses the last answer rather than asking again. These keys use a window
// shorter than the poll so each poll reaches the server.
const dedupeMs = 2000;

function initials(name: string): string {
	return (
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((p) => p[0].toUpperCase())
			.join("") || "?"
	);
}

function when(iso: string): string {
	const date = new Date(iso);
	const today = new Date();
	const sameDay = date.toDateString() === today.toDateString();
	return sameDay
		? date.toLocaleTimeString(undefined, {
				hour: "numeric",
				minute: "2-digit",
			})
		: date.toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			});
}

function Icon({ d, size = 14 }: { d: string; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={d} />
		</svg>
	);
}

const backPath = "M15 18l-6-6 6-6";
const sendPath = "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z";
const bubblePath =
	"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z";

export function Conversations({
	threadId,
	onOpen,
}: {
	threadId: string | null;
	onOpen: (id: string | null) => void;
}) {
	const { data, error, isLoading } = useSWR<{
		threads: ThreadSummary[];
		unread: number;
	}>(conversationsKey, {
		refreshInterval: refreshMs,
		dedupingInterval: dedupeMs,
	});

	if (error) {
		return (
			<div className={styles.state}>
				{describeFetchError(error, "inbox")}
			</div>
		);
	}

	const threads = data?.threads ?? [];

	if (!isLoading && threads.length === 0) {
		return (
			<div className={styles.empty}>
				<span className={styles.emptyIcon}>
					<Icon d={bubblePath} size={20} />
				</span>
				<div>
					<h2 className={styles.emptyTitle}>No conversations yet</h2>
					<p className={styles.emptyText}>
						Every category and report names who maintains it. Ask
						them something from there and the conversation carries
						on here.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className={`${styles.split} ${threadId ? styles.splitOpen : ""}`}>
			<ul className={styles.threadList} aria-label="Conversations">
				{threads.map((thread) => (
					<li key={thread.id}>
						<button
							type="button"
							className={`${styles.threadRow} ${
								thread.id === threadId ? styles.threadRowOn : ""
							} ${thread.unread ? styles.threadRowUnread : ""}`}
							aria-current={
								thread.id === threadId ? "true" : undefined
							}
							onClick={() => onOpen(thread.id)}
						>
							<span className={styles.threadTop}>
								<span className={styles.threadSubject}>
									{thread.unread && (
										<span
											className={styles.unreadDot}
											aria-label="Unread"
										/>
									)}
									{thread.subject}
								</span>
								<span className={styles.threadWhen}>
									{when(thread.lastMessageOn)}
								</span>
							</span>
							<span className={styles.threadPreview}>
								<strong>{thread.lastAuthorName}</strong>{" "}
								{thread.preview}
							</span>
							{thread.categoryName && (
								<span className={styles.threadTag}>
									{thread.categoryName}
								</span>
							)}
						</button>
					</li>
				))}
			</ul>

			<div className={styles.threadPane}>
				{threadId ? (
					<Thread
						key={threadId}
						threadId={threadId}
						onBack={() => onOpen(null)}
					/>
				) : (
					<div className={styles.pick}>
						Choose a conversation to read it.
					</div>
				)}
			</div>
		</div>
	);
}

function Thread({
	threadId,
	onBack,
}: {
	threadId: string;
	onBack: () => void;
}) {
	// The id comes from the address, so it is encoded to stay one path
	// segment under /api/messages.
	const key = `/api/messages/${encodeURIComponent(threadId)}`;
	const { data, error, mutate } = useSWR<{
		thread: ThreadSummary;
		messages: ThreadMessage[];
	}>(key, { refreshInterval: refreshMs, dedupingInterval: dedupeMs });
	const { mutate: mutateList } = useSWR(conversationsKey);

	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);

	// Opening a conversation marks it read, so the list and the unread count
	// are asked again once it has loaded.
	const opened = Boolean(data);
	useEffect(() => {
		if (opened) void mutateList();
	}, [opened, mutateList]);

	// Kept at the newest message as messages arrive.
	const endRef = useRef<HTMLDivElement>(null);
	const count = data?.messages.length ?? 0;
	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "end" });
	}, [count]);

	if (error) {
		return (
			<div className={styles.state}>
				{describeFetchError(error, "conversation")}
			</div>
		);
	}
	if (!data) return <div className={styles.pick}>Loading</div>;

	const { thread, messages } = data;

	const send = async () => {
		const body = draft.trim();
		if (!body || sending) return;
		setSending(true);
		setSendError(null);
		try {
			const response = await fetch(key, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body }),
			});
			if (!response.ok) {
				const result = (await response.json().catch(() => ({}))) as {
					error?: string;
				};
				setSendError(
					result.error ?? "It could not be sent. Try again.",
				);
				return;
			}
			setDraft("");
			void mutate();
			void mutateList();
		} catch {
			setSendError("It could not be sent. Try again.");
		} finally {
			setSending(false);
		}
	};

	return (
		<div className={styles.thread}>
			<header className={styles.threadHeader}>
				<button
					type="button"
					className={styles.back}
					onClick={onBack}
					aria-label="Back to conversations"
				>
					<Icon d={backPath} />
				</button>
				<div className={styles.threadHeading}>
					<h2 className={styles.threadTitle}>{thread.subject}</h2>
					<div className={styles.threadMeta}>
						<Link href={`/c/${thread.categoryId}`}>
							{thread.categoryName ?? thread.categoryId}
						</Link>
						{thread.reportSlug && (
							<>
								<span aria-hidden="true">/</span>
								<Link href={`/r/${thread.reportSlug}`}>
									Open the report
								</Link>
							</>
						)}
						<span aria-hidden="true">·</span>
						<span>
							{thread.members.map((m) => m.name).join(", ")}
						</span>
					</div>
				</div>
			</header>

			<div className={styles.messages}>
				{messages.map((message) => (
					<div
						key={message.id}
						className={`${styles.message} ${
							message.mine ? styles.messageMine : ""
						}`}
					>
						{!message.mine && (
							<span className={styles.messageAvatar}>
								{initials(message.authorName)}
							</span>
						)}
						<div className={styles.messageBody}>
							<span className={styles.messageMeta}>
								{message.mine ? "You" : message.authorName}
								<span>{when(message.createdOn)}</span>
							</span>
							<p className={styles.bubble}>{message.body}</p>
						</div>
					</div>
				))}
				<div ref={endRef} />
			</div>

			<form
				className={styles.reply}
				onSubmit={(e) => {
					e.preventDefault();
					void send();
				}}
			>
				<textarea
					className={styles.replyInput}
					value={draft}
					rows={2}
					maxLength={4000}
					placeholder="Reply"
					aria-label="Reply"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							void send();
						}
					}}
				/>
				<button
					type="submit"
					className={styles.replySend}
					disabled={!draft.trim() || sending}
					aria-label="Send reply"
				>
					<Icon d={sendPath} size={16} />
				</button>
				{sendError && (
					<span className={styles.formError}>{sendError}</span>
				)}
			</form>
		</div>
	);
}
