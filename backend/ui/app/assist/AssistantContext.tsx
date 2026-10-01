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
import { refreshBoardList } from "../boards/boardList";
import {
	commitBatch,
	newTracker,
	planSave,
	trackStored,
	trackUnknown,
	type SaveTracker,
} from "../../lib/assistant/conversationSave";
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
// in it at once. A save sends only the messages that are new or changed since
// the last one. An answer still being written when the page reloads is shown
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

// A screen the assistant can fill in, registered while it is open: Explore's
// table, a sheet, the report editor. Its state goes with each question, and a
// draft that comes back is handed to it to apply as an unsaved change.
export interface SurfaceBinding {
	kind: "sheet" | "explore" | "editor" | "board";
	// Which screen of that kind it is, such as the sheet id or the report and
	// page. A draft is applied only to the screen it was asked on.
	id: string;
	// Read when a question is sent, so it is what the screen holds then.
	state: () => unknown;
	apply: (draft: unknown) => void;
	// What the composer suggests asking on this screen, and the questions
	// offered before anything has been asked.
	placeholder?: string;
	examples?: string[];
}

// What the assistant can be asked to do. Every function keeps one identity for
// the life of the provider, so a screen that only calls these is not drawn
// again while an answer streams.
export interface AssistantActions {
	send: (question: string, sourceKey?: string) => void;
	// A question asked from elsewhere on the page, such as the home page or
	// search. Starts a new conversation, opens the panel and asks, in one
	// step, so nothing of the conversation before goes with it.
	ask: (question: string, sourceKey?: string) => void;
	stop: () => void;
	retry: (id: string) => void;
	newConversation: () => void;
	openConversation: (id: string) => Promise<void>;
	deleteConversation: (id: string) => Promise<void>;
	attach: (attachment: Omit<Attachment, "id">) => void;
	detach: (id: string) => void;
	setPicking: (on: boolean) => void;
	// The floating panel, so the full page and a keyboard shortcut can open
	// and close the same one.
	setPanelOpen: (open: boolean) => void;
	registerSurface: (binding: SurfaceBinding) => () => void;
}

// The state around the conversation that changes only when somebody does
// something or an answer starts or ends, never with each streamed piece.
export interface AssistantStatus {
	conversationId: string;
	busy: boolean;
	// Parts of the page waiting to go with the next question.
	attachments: Attachment[];
	// Whether the picker is waiting for somebody to click a part of the page.
	picking: boolean;
	panelOpen: boolean;
	// The screen open now, if it is one the assistant can fill in.
	surface: SurfaceBinding | null;
}

interface AssistantState extends AssistantActions, AssistantStatus {
	messages: Message[];
}

// Held in three contexts so a change to one does not draw the readers of the
// others. The messages change with every streamed piece of text, the status
// when an answer starts or ends, and the actions never.
const ActionsContext = createContext<AssistantActions | null>(null);
const StatusContext = createContext<AssistantStatus | null>(null);
const MessagesContext = createContext<Message[] | null>(null);

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

function isBusy(messages: Message[]): boolean {
	return messages.some(
		(m) => m.role === "assistant" && m.status === "streaming",
	);
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

// Sends what changed since the conversation was last saved, in as many requests
// as the plan needs. Each request that lands is recorded on the tracker, so a
// request that fails is sent again with the next save.
async function saveRemotely(
	id: string,
	messages: Message[],
	tracker: SaveTracker,
) {
	if (messages.length === 0) return;
	const settled = settle(messages);
	const { batches, skipped } = planSave(tracker, titleOf(settled), settled);
	if (skipped.length > 0) {
		console.warn(
			"Messages too large to keep were left out of the saved conversation",
			skipped,
		);
	}
	if (batches.length === 0) return;
	try {
		for (const batch of batches) {
			const response = await fetch(`/api/assist/conversations/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: batch.title,
					messages: batch.messages,
					removed: batch.removed,
				}),
			});
			if (!response.ok) break;
			commitBatch(tracker, batch);
		}
	} catch {
		// Kept in the browser regardless. The next finished answer saves it.
	}
	void revalidate(conversationsKey);
}

export function AssistantProvider({ children }: { children: ReactNode }) {
	const [conversationId, setConversationId] = useState("");
	const [messages, setMessages] = useState<Message[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [panelOpen, setPanelOpen] = useState(false);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [picking, setPicking] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	// Held in a ref as well as state, so a draft is handed to the binding
	// registered when it arrives rather than the one registered when the
	// question was sent. That binding is used only when it is the same screen
	// the question was asked on, matched by kind and id, which covers a screen
	// that registered again while the answer was streaming. A draft for a
	// screen that is no longer open is kept on the answer instead.
	const [surface, setSurface] = useState<SurfaceBinding | null>(null);
	const surfaceRef = useRef<SurfaceBinding | null>(null);

	const registerSurface = useCallback((binding: SurfaceBinding) => {
		surfaceRef.current = binding;
		setSurface(binding);
		return () => {
			if (surfaceRef.current === binding) {
				surfaceRef.current = null;
				setSurface(null);
			}
		};
	}, []);

	// What the server holds of each conversation opened in this tab, so a save
	// sends only what changed. Saves run one at a time, in the order the
	// answers finished, so two never plan against the same tracker at once.
	const trackers = useRef(new Map<string, SaveTracker>());
	const saving = useRef<Promise<void>>(Promise.resolve());
	const saveInOrder = useCallback((id: string, messages: Message[]) => {
		let tracker = trackers.current.get(id);
		if (!tracker) {
			tracker = newTracker();
			trackers.current.set(id, tracker);
		}
		const held = tracker;
		saving.current = saving.current.then(() =>
			saveRemotely(id, messages, held),
		);
	}, []);

	// Read after mount rather than during render, so the server render and
	// the first client render agree. Whether the messages kept in the browser
	// reached the server is not known, so the next save sends them again.
	useEffect(() => {
		const held = load();
		trackers.current.set(held.id, trackUnknown(held.messages));
		setConversationId(held.id);
		setMessages(held.messages);
		setLoaded(true);
	}, []);

	const busy = isBusy(messages);

	// The latest of each, read by the actions so they keep one identity
	// rather than closing over the render they were made in.
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;
	const conversationIdRef = useRef(conversationId);
	conversationIdRef.current = conversationId;

	// Kept in the browser when an answer starts, when it ends and on any
	// change between answers, rather than on every streamed piece of text.
	// Leaving the page mid-answer keeps what has arrived so far.
	const storedBusy = useRef(false);
	const storedId = useRef("");
	useEffect(() => {
		if (!loaded || !conversationId) return;
		if (
			!busy ||
			!storedBusy.current ||
			storedId.current !== conversationId
		) {
			keepLocally(conversationId, messages);
		}
		storedBusy.current = busy;
		storedId.current = conversationId;
	}, [messages, loaded, conversationId, busy]);
	useEffect(() => {
		const keep = () => {
			if (conversationIdRef.current) {
				keepLocally(conversationIdRef.current, messagesRef.current);
			}
		};
		window.addEventListener("pagehide", keep);
		return () => window.removeEventListener("pagehide", keep);
	}, []);

	// Saved to the server each time an answer finishes, however it finished,
	// rather than on every streamed piece of text.
	const wasBusy = useRef(false);
	useEffect(() => {
		if (wasBusy.current && !busy && conversationId) {
			saveInOrder(conversationId, messages);
		}
		wasBusy.current = busy;
	}, [busy, conversationId, messages, saveInOrder]);

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

	// Raised by every open, every new conversation and every question asked,
	// so a conversation that finishes loading after any of those is not shown.
	const openRequest = useRef(0);

	const run = useCallback(
		async (
			question: string,
			history: Message[],
			sourceKey: string | undefined,
			pointed: Attachment[],
		) => {
			openRequest.current += 1;
			const answerId = newId();

			// Streamed text is gathered and applied once per frame, so a long
			// answer draws the thread once a frame rather than once a piece.
			// Every other change applies what is gathered first, so the order
			// of events is kept.
			let pendingText = "";
			let frame = 0;
			const flush = () => {
				if (frame) {
					cancelAnimationFrame(frame);
					frame = 0;
				}
				if (!pendingText) return;
				const delta = pendingText;
				pendingText = "";
				update(answerId, (m) => apply(m, { type: "text", delta }));
			};
			const edit: typeof update = (id, change) => {
				flush();
				update(id, change);
			};

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
			const asked: Message[] = [
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
			];
			// Set on the ref at once as well, so a second send before the next
			// render sees the answer already running.
			messagesRef.current = asked;
			setMessages(asked);

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
			const asking = surfaceRef.current;
			const askedOn = asking
				? { kind: asking.kind, id: asking.id }
				: null;

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
						...(asking
							? {
									surface: {
										kind: asking.kind,
										state: asking.state(),
									},
								}
							: {}),
					}),
					signal: abort.signal,
				});

				if (!response.ok || !response.body) {
					const body = await response.json().catch(() => null);
					edit(answerId, (m) =>
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
								// Only to the screen it was written for, and
								// only while that screen is still open.
								if (event.type === "draft") {
									const open = surfaceRef.current;
									if (
										askedOn &&
										open &&
										event.kind === askedOn.kind &&
										open.kind === askedOn.kind &&
										open.id === askedOn.id
									) {
										open.apply(event.draft);
									} else {
										const held = {
											kind: event.kind,
											draft: event.draft,
										};
										edit(answerId, (m) => ({
											...m,
											heldDrafts: [
												...(m.heldDrafts ?? []),
												held,
											],
										}));
									}
								}
								if (event.type === "text") {
									pendingText += event.delta;
									if (!frame) {
										frame = requestAnimationFrame(() => {
											frame = 0;
											flush();
										});
									}
								} else {
									edit(answerId, (m) => apply(m, event));
								}
								// A board the assistant made is in the list
								// straight away.
								if (
									event.type === "created" &&
									event.kind === "board"
								)
									refreshBoardList();
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
					edit(answerId, (m) =>
						apply(m, {
							type: "error",
							message:
								"The answer was cut off before it finished",
						}),
					);
				}
			} catch (error) {
				if (abort.signal.aborted) {
					edit(
						answerId,
						(m) =>
							({
								...settle([m])[0],
								finishedAt: Date.now(),
							}) as Extract<Message, { role: "assistant" }>,
					);
				} else {
					edit(answerId, (m) =>
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
				flush();
				if (abortRef.current === abort) abortRef.current = null;
			}
		},
		[],
	);

	const send = useCallback(
		(question: string, sourceKey?: string) => {
			const asked = question.trim();
			if (!asked || isBusy(messagesRef.current)) return;
			const pointed = attachmentsRef.current;
			attachmentsRef.current = [];
			setAttachments([]);
			void run(asked, messagesRef.current, sourceKey, pointed);
		},
		[run],
	);

	const stop = useCallback(() => abortRef.current?.abort(), []);

	// Asks the same question again in place of the answer before.
	const retry = useCallback(
		(id: string) => {
			const messages = messagesRef.current;
			if (isBusy(messages)) return;
			const at = messages.findIndex((m) => m.id === id);
			if (at < 1) return;
			const answer = messages[at];
			if (answer.role !== "assistant") return;
			void run(answer.question, messages.slice(0, at - 1), undefined, []);
		},
		[run],
	);

	const newConversation = useCallback(() => {
		abortRef.current?.abort();
		openRequest.current += 1;
		setConversationId(newConversationId());
		setMessages([]);
		setAttachments([]);
	}, []);

	const ask = useCallback(
		(question: string, sourceKey?: string) => {
			const asked = question.trim();
			if (!asked) return;
			abortRef.current?.abort();
			setConversationId(newConversationId());
			setAttachments([]);
			setPanelOpen(true);
			void run(asked, [], sourceKey, []);
		},
		[run],
	);

	const openConversation = useCallback(async (id: string) => {
		abortRef.current?.abort();
		const request = ++openRequest.current;
		try {
			const response = await fetch(`/api/assist/conversations/${id}`);
			if (!response.ok || request !== openRequest.current) return;
			const body = (await response.json()) as { messages?: Message[] };
			if (request !== openRequest.current) return;
			const opened = settle(
				Array.isArray(body.messages) ? body.messages : [],
			);
			trackers.current.set(id, trackStored(titleOf(opened), opened));
			setConversationId(id);
			setMessages(opened);
			setAttachments([]);
		} catch {
			// Offline or an unreadable reply. The conversation on screen stays.
		}
	}, []);

	const deleteConversation = useCallback(
		async (id: string) => {
			await fetch(`/api/assist/conversations/${id}`, {
				method: "DELETE",
			});
			void revalidate(conversationsKey);
			if (id === conversationIdRef.current) newConversation();
		},
		[newConversation],
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

	const actions = useMemo<AssistantActions>(
		() => ({
			send,
			ask,
			stop,
			retry,
			newConversation,
			openConversation,
			deleteConversation,
			attach,
			detach,
			setPicking,
			setPanelOpen,
			registerSurface,
		}),
		[
			send,
			ask,
			stop,
			retry,
			newConversation,
			openConversation,
			deleteConversation,
			attach,
			detach,
			registerSurface,
		],
	);

	const status = useMemo<AssistantStatus>(
		() => ({
			conversationId,
			busy,
			attachments,
			picking,
			panelOpen,
			surface,
		}),
		[conversationId, busy, attachments, picking, panelOpen, surface],
	);

	return (
		<ActionsContext.Provider value={actions}>
			<StatusContext.Provider value={status}>
				<MessagesContext.Provider value={messages}>
					{children}
				</MessagesContext.Provider>
			</StatusContext.Provider>
		</ActionsContext.Provider>
	);
}

function required<T>(held: T | null, hook: string): T {
	if (!held) throw new Error(`${hook} needs an AssistantProvider`);
	return held;
}

// The functions alone. A screen that only asks or opens the panel reads this,
// so it is never drawn again by the assistant.
export function useAssistantActions(): AssistantActions {
	return required(useContext(ActionsContext), "useAssistantActions");
}

// The status and the actions, without the messages, so the reader is drawn
// when an answer starts or ends but not while it streams.
export function useAssistantStatus(): AssistantStatus & AssistantActions {
	const actions = useAssistantActions();
	const status = required(useContext(StatusContext), "useAssistantStatus");
	return useMemo(() => ({ ...actions, ...status }), [actions, status]);
}

// Whether the floating panel is open, and the way to open or close it.
export function useAssistantPanel(): {
	panelOpen: boolean;
	setPanelOpen: (open: boolean) => void;
} {
	const { panelOpen, setPanelOpen } = useAssistantStatus();
	return { panelOpen, setPanelOpen };
}

// The conversation itself, which changes with every streamed piece of text.
export function useAssistantMessages(): Message[] {
	return required(useContext(MessagesContext), "useAssistantMessages");
}

// Everything at once, for a screen that needs the messages along with the
// rest. It is drawn again with every streamed piece of text.
export function useAssistant(): AssistantState {
	const rest = useAssistantStatus();
	const messages = useAssistantMessages();
	return { ...rest, messages };
}
