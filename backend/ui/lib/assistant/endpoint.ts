import { isDatabricksApp, workspaceHost } from "../runtime";
import { settings } from "../settings";
import { readChatStream, type ToolCall } from "./chatStream";
import { refusalMessage } from "./refusal";

export type { ToolCall };

// Reaching whatever model answers, without depending on which one it is.
//
// The app knows an endpoint name and nothing else: not the vendor, not the
// model, not a prompt format beyond the chat shape every serving endpoint
// speaks. Naming a different endpoint changes the model with no redeploy, and
// naming none removes the feature.

export class AssistantOff extends Error {
	constructor() {
		super("No assistant endpoint is configured");
	}
}

export class AssistantFailed extends Error {}

// Configured means usable. Everything that offers the assistant asks this
// first, so one empty setting removes the route, the navigation entry and the
// page together.
export function assistantConfigured(): boolean {
	const { assistantEndpoint, assistantEndpointUrl } = settings();
	// An address takes precedence over a name, as in endpointUrl, so one that
	// is refused leaves the feature off rather than half on.
	const explicit = assistantEndpointUrl.trim();
	if (explicit) return secureAddress(explicit).length > 0;
	return assistantEndpoint.trim().length > 0;
}

// An address a bearer token may be sent to. Every call carries the caller's
// token, so plain http anywhere but this machine would put a
// workspace credential on the network in clear text. Anything else reads as
// no endpoint, which turns the assistant off rather than leaking a token.
export function secureAddress(address: string): string {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		return "";
	}
	if (url.protocol === "https:") return url.toString();
	const local =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]";
	return url.protocol === "http:" && local ? url.toString() : "";
}

// A serving endpoint on the workspace this app is already connected to needs
// only its name. Anything else needs its address.
export function endpointUrl(): string {
	const { assistantEndpoint, assistantEndpointUrl } = settings();

	const explicit = assistantEndpointUrl.trim();
	if (explicit) return secureAddress(explicit);

	const name = assistantEndpoint.trim();
	if (!name || !workspaceHost) return "";
	return `${workspaceHost}/serving-endpoints/${encodeURIComponent(name)}/invocations`;
}

// The chat shape every llm/v1/chat serving endpoint accepts, including the
// tool calling half of it. An AI Gateway accepts it too, at its
// /chat/completions address, with the model named in the request.

export type ChatMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

// One message with a picture in it, for a single question about that picture.
export interface PictureMessage {
	role: "user";
	content: (
		| { type: "text"; text: string }
		| { type: "image_url"; image_url: { url: string } }
	)[];
}

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface Turn {
	content: string | null;
	toolCalls: ToolCall[];
	// Which credential the call went out under. Always the caller's. The
	// "app" value is read from conversations saved before that was so.
	as: "caller" | "app";
}

// A model call is a network round trip to something that may be cold, and an
// analysis turn writes a good deal. The limit is on the whole turn rather than
// on silence, so a stream that keeps arriving is never cut off early and one
// that stalls is not waited on for ever.
const requestTimeoutMs = 180_000;

export interface StreamHandlers {
	// Each piece of written text as the model produces it.
	onText?: (delta: string) => void;
	// Set when the person asking gives up. The request to the model is
	// cancelled rather than left running for an answer nobody will read.
	signal?: AbortSignal;
}

async function post(
	url: string,
	authorization: string,
	messages: (ChatMessage | PictureMessage)[],
	tools: ToolDefinition[],
	maxTokens: number,
	handlers: StreamHandlers,
): Promise<Omit<Turn, "as">> {
	const timeout = AbortSignal.timeout(requestTimeoutMs);
	const model = settings().assistantModel.trim();
	const signal = handlers.signal
		? AbortSignal.any([timeout, handlers.signal])
		: timeout;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			...(authorization ? { Authorization: authorization } : {}),
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		// No sampling parameters. Current models decide those themselves and
		// the endpoints reject the old ones, so the request carries only what
		// the conversation is and how long an answer may run.
		body: JSON.stringify({
			// Named only where one is set, for a gateway that serves several
			// models from one address. A serving endpoint is one model.
			...(model ? { model } : {}),
			messages,
			...(tools.length > 0 ? { tools } : {}),
			max_tokens: maxTokens,
			stream: true,
		}),
		signal,
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		console.warn(
			`Assistant model answered ${response.status}: ${detail.slice(0, 300)}`,
		);
		throw new AssistantFailed(refusalMessage(response.status));
	}

	// An endpoint that ignores the stream flag answers with one JSON body,
	// which is read whole and handed over as a single piece of text.
	const type = response.headers.get("content-type") ?? "";
	if (!type.includes("text/event-stream") || !response.body) {
		const body = (await response.json()) as {
			choices?: {
				message?: { content?: unknown; tool_calls?: unknown };
			}[];
		};
		const message = body.choices?.[0]?.message;
		const content =
			typeof message?.content === "string" ? message.content : null;
		if (content) handlers.onText?.(content);
		const toolCalls = Array.isArray(message?.tool_calls)
			? (message.tool_calls as ToolCall[]).filter(
					(c) => c?.function?.name,
				)
			: [];
		if (!content?.trim() && toolCalls.length === 0) {
			throw new AssistantFailed("The model endpoint returned no answer");
		}
		return { content, toolCalls };
	}

	const turn = await readChatStream(response.body, handlers.onText);
	if (!turn.content?.trim() && turn.toolCalls.length === 0) {
		throw new AssistantFailed("The model endpoint returned no answer");
	}
	return turn;
}

// Sent under the caller's own token, and only that. A token that cannot
// reach the endpoint is a refusal to the person asking, never a reason to ask
// again as the app, which would reach an endpoint that person has no right to.
//
// A Databricks App forwards a token carrying only the scopes granted under user
// authorization, so model-serving has to be among them for the assistant to
// answer.
export async function converse(
	callerToken: string | null,
	messages: (ChatMessage | PictureMessage)[],
	tools: ToolDefinition[] = [],
	handlers: StreamHandlers = {},
	maxTokens = 8000,
): Promise<Turn> {
	const url = endpointUrl();
	if (!url) throw new AssistantOff();

	// Run locally there is no signed-in person's token to forward. A model on
	// this same machine is then called with no credential at all, which
	// grants it nothing, so local development and the demonstration can use
	// one. A deployed app always forwards the caller's own token.
	const onThisMachine =
		/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(url);
	if (!callerToken && !(onThisMachine && !isDatabricksApp)) {
		throw new AssistantFailed(
			"The assistant needs the signed-in person's own token and none was forwarded",
		);
	}
	return {
		...(await post(
			url,
			callerToken ? `Bearer ${callerToken}` : "",
			messages,
			tools,
			maxTokens,
			handlers,
		)),
		as: "caller",
	};
}
