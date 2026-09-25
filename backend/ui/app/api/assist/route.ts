import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { reachableSet } from "@/lib/platform/sources";
import { listSources } from "@/lib/semantic/registry";
import {
	assistantConfigured,
	AssistantFailed,
	AssistantOff,
} from "@/lib/assistant/endpoint";
import { runAgent, type HistoryTurn } from "@/lib/assistant/agent";
import { describePage } from "@/lib/assistant/pageContext";
import type { AssistantEvent } from "@/lib/assistant/events";
import { getProfile } from "@/lib/assistant/store";

// Something the person pointed at on the page with the picker.
interface Attachment {
	label: string;
	visualId: string | null;
	text: string;
}

// Parts of the page one question can carry, and how much of each. The text of a
// table visual can run long, and the first screenful is what somebody pointing
// at it is looking at.
const maxAttachments = 6;
const maxAttachmentText = 6000;

// Answering a question about the data, streamed as it happens.
//
// The response is one JSON event per line: each step the assistant takes as it
// starts and finishes, the first rows of every result, and the answer as it is
// written. Every query runs under the identity of the person asking, through
// the same executor a report uses, so it sees their rows and nobody else's.

const maxQuestion = 4000;
const maxHistory = 16;
const maxHistoryChars = 8000;

export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	// Unconfigured is indistinguishable from not built. An installation that
	// wants no assistant should not advertise one by answering differently.
	if (!assistantConfigured()) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	let question = "";
	let asked: string | null = null;
	let history: HistoryTurn[] = [];
	let path = "";
	let title = "";
	let attachments: Attachment[] = [];
	try {
		const body = await request.json();
		question = String(body?.question ?? "").trim();
		asked = body?.sourceKey ? String(body.sourceKey) : null;
		path = typeof body?.path === "string" ? body.path.slice(0, 500) : "";
		title = typeof body?.title === "string" ? body.title.slice(0, 300) : "";
		attachments = (Array.isArray(body?.attachments) ? body.attachments : [])
			.slice(0, maxAttachments)
			.map((a: Record<string, unknown>) => ({
				label: String(a?.label ?? "").slice(0, 200),
				visualId: typeof a?.visualId === "string" ? a.visualId : null,
				text: String(a?.text ?? "").slice(0, maxAttachmentText),
			}))
			.filter((a: Attachment) => a.label || a.text);
		// Earlier turns as plain text, so a follow up can say "and by region"
		// and mean the thing just discussed. Bounded, because the model reads
		// every word of it on every turn.
		history = (Array.isArray(body?.history) ? body.history : [])
			.filter(
				(t: unknown): t is HistoryTurn =>
					Boolean(t) &&
					typeof t === "object" &&
					((t as HistoryTurn).role === "user" ||
						(t as HistoryTurn).role === "assistant") &&
					typeof (t as HistoryTurn).content === "string",
			)
			.slice(-maxHistory)
			.map((t: HistoryTurn) => ({
				role: t.role,
				content: t.content.slice(0, maxHistoryChars),
			}));
	} catch {
		return NextResponse.json(
			{ error: "Malformed request" },
			{ status: 400 },
		);
	}

	if (!question) {
		return NextResponse.json(
			{ error: "Ask a question first" },
			{ status: 400 },
		);
	}
	if (question.length > maxQuestion) {
		return NextResponse.json(
			{ error: `Keep the question under ${maxQuestion} characters` },
			{ status: 400 },
		);
	}

	// Only datasets this person can already read. The model is never told
	// about one they could not query, so it cannot propose it and have the
	// refusal reveal that it exists.
	const reachable = await reachableSet(identity);
	const available = listSources().filter(
		(s) => !reachable || reachable.has(s.sourceKey),
	);
	if (available.length === 0) {
		return NextResponse.json(
			{ error: "You have no data to ask about" },
			{ status: 403 },
		);
	}

	const preferred = asked
		? (available.find((s) => s.sourceKey === asked) ?? null)
		: null;

	const policy = await resolvePolicyClass(identity);
	const context = path
		? await describePage(identity, policy, path, title, available).catch(
				() => null,
			)
		: null;

	// A visual pointed at is named by the query behind it, which says exactly
	// what it shows. Its text is added too, since that is what was on screen,
	// filters and all, at the moment they pointed.
	const pointedAt = attachments.length
		? attachments
				.map((a) => {
					const known = a.visualId
						? context?.visuals[a.visualId]
						: null;
					const head = known ?? a.label;
					return a.text
						? `- ${head}\n  What it showed:\n${a.text
								.split("\n")
								.map((line) => `    ${line}`)
								.join("\n")}`
						: `- ${head}`;
				})
				.join("\n")
		: null;

	// Their standing instructions and memories. A profile that cannot be read
	// is left out rather than failing the question.
	const profile = await getProfile(identity.email).catch(() => null);

	// Cancelled when the reader stops the answer or closes the page, which
	// stops the model call and any query still waiting to start.
	const abort = new AbortController();
	request.signal.addEventListener("abort", () => abort.abort());

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let open = true;
			const emit = (event: AssistantEvent) => {
				if (!open) return;
				try {
					controller.enqueue(
						encoder.encode(`${JSON.stringify(event)}\n`),
					);
				} catch {
					open = false;
				}
			};

			try {
				await runAgent(
					identity,
					{
						question,
						history,
						available,
						preferredSource: preferred,
						context,
						profile,
						pointedAt,
					},
					emit,
					abort.signal,
				);
			} catch (error) {
				if (!abort.signal.aborted) {
					const message =
						error instanceof AssistantOff
							? "The assistant is not configured"
							: error instanceof AssistantFailed
								? error.message
								: "The assistant could not answer that";
					if (
						!(error instanceof AssistantFailed) &&
						!(error instanceof AssistantOff)
					) {
						console.error("Assistant failed:", error);
					}
					emit({ type: "error", message });
				}
			} finally {
				open = false;
				try {
					controller.close();
				} catch {
					// Already closed by a reader that went away.
				}
			}
		},
		cancel() {
			abort.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			// Every event is flushed as it is written. A proxy that buffers
			// the response would deliver the whole answer at the end, which is
			// the thing streaming exists to avoid.
			"Cache-Control": "no-store, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
