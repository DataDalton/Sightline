"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { mutate as revalidate } from "swr";
import type { AssistantEvent } from "../../lib/assistant/events";
import {
	applyEvent as apply,
	type Activity,
	type Message,
	type Step,
} from "../../lib/assistant/transcript";

export type { Activity, Message, Step };

// The assistant's conversation, shared by the floating panel on every page and
// the full assistant page.
//
// Held above the page content, so moving from one report to another keeps it
// where it was. Each conversation is saved to the server when an answer
// finishes, so it can be reopened from the history later and on another
// machine, and the open one is also kept in the browser so a reload lands back
// in it at once. An answer still being written when the page reloads is shown
// as stopped rather than as running for ever.

// A part of the page somebody pointed at with the picker, to go with the next
// question.
export interface Attachment {
	id: string;
	label: string;
	visualId: string | null;
	text: string;
}

export const conversationsKey = "/api/assist/conversations";

interface AssistantState {
	conversationId: string;
	messages: Message[];
	busy: boolean;
	send: (question: string, sourceKey?: string) => void;
	stop: () => void;
	retry: (id: string) => void;
	newConversation: () => void;
	openConversation: (id: string) => Promise<void>;
	deleteConversation: (id: string) => Promise<void>;
	// Parts of the page waiting to go with the next question.
	attachments: Attachment[];
	attach: (attachment: Omit<Attachment, "id">) => void;
	detach: (id: string) => void;
	// Whether the picker is waiting for somebody to click a part of the page.
	picking: boolean;
	setPicking: (on: boolean) => void;
	// The floating panel, so the full page and a keyboard shortcut can open
	// and close the same one.
	panelOpen: boolean;
	setPanelOpen: (open: boolean) => void;
}

const Context = createContext<AssistantState | null>(null);

const storageKey = "sightline.assistant.v2";
const keptMessages = 60;

function newId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function newConversationId(): string {
	return crypto.randomUUID();
}

// Anything left running is marked stopped: whatever was writing it is gone.
function settle(messages: Message[]): Message[] {
	return messages.map((m) =>
		m.role === "assistant" && m.status === "streaming"
			? {
					...m,
					status: "stopped",
					answer: m.answer || m.draft,
					draft: "",
					activity: m.activity.map((a) =>
						a.type === "step" && a.step.status === "running"
							? { ...a, step: { ...a.step, status: "failed" } }
							: a,
					),
				}
			: m,
	);
}

function load(): { id: string; messages: Message[] } {
	try {
		const raw = window.localStorage.getItem(storageKey);
		if (raw) {
			const held = JSON.parse(raw) as {
				id?: string;
				messages?: Message[];
			};
			if (typeof held.id === "string" && Array.isArray(held.messages)) {
				return { id: held.id, messages: settle(held.messages) };
			}
		}
	} catch {
		// Unreadable or blocked. A fresh conversation is started.
	}
	return { id: newConversationId(), messages: [] };
}

function keepLocally(id: string, messages: Message[]) {
	try {
		window.localStorage.setItem(
			storageKey,
			JSON.stringify({ id, messages: messages.slice(-keptMessages) }),
		);
	} catch {
		// Storage full or blocked. The server copy still holds it.
	}
}

// What a conversation is called in the history: its first question.
function titleOf(messages: Message[]): string {
	const first = messages.find((m) => m.role === "user");
	const text = first?.role === "user" ? first.content : "";
	return text.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
}

async function saveRemotely(id: string, messages: Message[]) {
	if (messages.length === 0) return;
	try {
		await fetch(`/api/assist/conversations/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: titleOf(messages),
				messages: settle(messages).slice(-keptMessages),
			}),
		});
		void revalidate(conversationsKey);
	} catch {
		// Kept in the browser regardless. The next finished answer saves it.
	}
}

export function AssistantProvider({ children }: { children: ReactNode }) {
	const [conversationId, setConversationId] = useState("");
	const [messages, setMessages] = useState<Message[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [panelOpen, setPanelOpen] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [picking, setPicking] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	// Read after mount rather than during render, so the server render and
	// the first client render agree.
	useEffect(() => {
		const held = load();
		setConversationId(held.id);
		setMessages(held.messages);
		setLoaded(true);
	}, []);

	useEffect(() => {
		if (loaded && conversationId) keepLocally(conversationId, messages);
	}, [messages, loaded, conversationId]);

	const busy = messages.some(
		(m) => m.role === "assistant" && m.status === "streaming",
	);

	// Saved to the server each time an answer finishes, however it finished,
	// rather than on every streamed piece of text.
	const wasBusy = useRef(false);
	useEffect(() => {
		if (wasBusy.current && !busy && conversationId) {
			void saveRemotely(conversationId, messages);
		}
		wasBusy.current = busy;
	}, [busy, conversationId, messages]);

	const update = (
		id: string,
		change: (
			m: Extract<Message, { role: "assistant" }>,
		) => Extract<Message, { role: "assistant" }>,
	) =>
		setMessages((held) =>
			held.map((m) =>
				m.role === "assistant" && m.id === id ? change(m) : m,
			),
		);

	const run = useCallback(
		async (
			question: string,
			history: Message[],
			sourceKey: string | undefined,
			pointed: Attachment[],
		) => {
			const answerId = newId();
			const started: Message = {
				role: "assistant",
				id: answerId,
				question,
				activity: [],
				draft: "",
				answer: "",
				charts: [],
				status: "streaming",
				startedAt: Date.now(),
			};
			setMessages([
				...history,
				{
					role: "user",
					id: newId(),
					content: question,
					...(pointed.length
						? { attachments: pointed.map((a) => a.label) }
						: {}),
				},
				started,
			]);

			// What the model sees of the conversation so far: what was asked
			// and what was answered, not the working in between.
			const turns = history.flatMap((m) =>
				m.role === "user"
					? [{ role: "user", content: m.content }]
					: m.answer
						? [{ role: "assistant", content: m.answer }]
						: [],
			);

			const abort = new AbortController();
			abortRef.current = abort;

			try {
				const response = await fetch("/api/assist", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						question,
						history: turns,
						sourceKey: sourceKey || undefined,
						path: window.location.pathname,
						title: document.title,
						attachments: pointed.map((a) => ({
							label: a.label,
							visualId: a.visualId,
							text: a.text,
						})),
					}),
					signal: abort.signal,
				});

				if (!response.ok || !response.body) {
					const body = await response.json().catch(() => null);
					update(answerId, (m) =>
						apply(m, {
							type: "error",
							message:
								body?.error ??
								(response.status === 404
									? "The assistant is not configured"
									: "That could not be answered"),
						}),
					);
					return;
				}

				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffered = "";
				let finished = false;

				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffered += decoder.decode(value, { stream: true });
					let newline = buffered.indexOf("\n");
					while (newline >= 0) {
						const line = buffered.slice(0, newline).trim();
						buffered = buffered.slice(newline + 1);
						if (line) {
							try {
								const event = JSON.parse(
									line,
								) as AssistantEvent;
								if (
									event.type === "done" ||
									event.type === "error"
								) {
									finished = true;
								}
								update(answerId, (m) => apply(m, event));
							} catch {
								// A line that is not an event is skipped rather
								// than ending the answer.
							}
						}
						newline = buffered.indexOf("\n");
					}
				}

				// A stream that ended without saying it was done was cut off
				// somewhere between here and the model.
				if (!finished) {
					update(answerId, (m) =>
						apply(m, {
							type: "error",
							message:
								"The answer was cut off before it finished",
						}),
					);
				}
			} catch (error) {
				if (abort.signal.aborted) {
					update(
						answerId,
						(m) =>
							({
								...settle([m])[0],
								finishedAt: Date.now(),
							}) as Extract<Message, { role: "assistant" }>,
					);
				} else {
					update(answerId, (m) =>
						apply(m, {
							type: "error",
							message:
								error instanceof Error
									? error.message
									: "The assistant could not be reached",
						}),
					);
				}
			} finally {
				if (abortRef.current === abort) abortRef.current = null;
			}
		},
		[],
	);

	const send = useCallback(
		(question: string, sourceKey?: string) => {
			const asked = question.trim();
			if (!asked || busy) return;
			const pointed = attachments;
			setAttachments([]);
			void run(asked, messages, sourceKey, pointed);
		},
		[busy, messages, run, attachments],
	);

	const stop = useCallback(() => abortRef.current?.abort(), []);

	// Asks the same question again in place of the answer before.
	const retry = useCallback(
		(id: string) => {
			if (busy) return;
			const at = messages.findIndex((m) => m.id === id);
			if (at < 1) return;
			const answer = messages[at];
			if (answer.role !== "assistant") return;
			void run(answer.question, messages.slice(0, at - 1), undefined, []);
		},
		[busy, messages, run],
	);

	const newConversation = useCallback(() => {
		abortRef.current?.abort();
		setConversationId(newConversationId());
		setMessages([]);
		setAttachments([]);
	}, []);

	const openConversation = useCallback(async (id: string) => {
		abortRef.current?.abort();
		const response = await fetch(`/api/assist/conversations/${id}`);
		if (!response.ok) return;
		const body = (await response.json()) as { messages?: Message[] };
		setConversationId(id);
		setMessages(settle(Array.isArray(body.messages) ? body.messages : []));
		setAttachments([]);
	}, []);

	const deleteConversation = useCallback(
		async (id: string) => {
			await fetch(`/api/assist/conversations/${id}`, {
				method: "DELETE",
			});
			void revalidate(conversationsKey);
			if (id === conversationId) newConversation();
		},
		[conversationId, newConversation],
	);

	const attach = useCallback((attachment: Omit<Attachment, "id">) => {
		setAttachments((held) =>
			// The same visual twice adds nothing.
			attachment.visualId &&
			held.some((a) => a.visualId === attachment.visualId)
				? held
				: [...held, { ...attachment, id: newId() }],
		);
	}, []);

	const detach = useCallback(
		(id: string) =>
			setAttachments((held) => held.filter((a) => a.id !== id)),
		[],
	);

	const value = useMemo(
		() => ({
			conversationId,
			messages,
			busy,
			send,
			stop,
			retry,
			newConversation,
			openConversation,
			deleteConversation,
			attachments,
			attach,
			detach,
			picking,
			setPicking,
			panelOpen,
			setPanelOpen,
		}),
		[
			conversationId,
			messages,
			busy,
			send,
			stop,
			retry,
			newConversation,
			openConversation,
			deleteConversation,
			attachments,
			attach,
			detach,
			picking,
			panelOpen,
		],
	);

	return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAssistant(): AssistantState {
	const held = useContext(Context);
	if (!held) throw new Error("useAssistant needs an AssistantProvider");
	return held;
}
