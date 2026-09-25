import { workspaceHost } from "../runtime";
import { settings } from "../settings";
import { readChatStream, type ToolCall } from "./chatStream";

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
	return (
		assistantEndpoint.trim().length > 0 ||
		assistantEndpointUrl.trim().length > 0
	);
}

// A serving endpoint on the workspace this app is already connected to needs
// only its name. Anything else needs its address.
export function endpointUrl(): string {
	const { assistantEndpoint, assistantEndpointUrl } = settings();

	const explicit = assistantEndpointUrl.trim();
	if (explicit) return explicit;

	const name = assistantEndpoint.trim();
	if (!name || !workspaceHost) return "";
	return `${workspaceHost}/serving-endpoints/${encodeURIComponent(name)}/invocations`;
}

// The app's own credential, for the case where the caller's token cannot be
// used. The SDK writes the header rather than handing back a token, so the
// header it produces is what travels rather than a scheme this code assumed.
async function appHeader(): Promise<string | null> {
	try {
		const { WorkspaceClient } =
			await import("@databricks/sdk-experimental");
		const workspace = new WorkspaceClient({});
		const headers = new Headers();
		await workspace.config.authenticate(headers);
		return headers.get("Authorization");
	} catch (error) {
		console.warn(
			"Could not authenticate the app for the assistant:",
			error,
		);
		return null;
	}
}

// The chat shape every llm/v1/chat serving endpoint accepts, including the
// tool calling half of it.

export type ChatMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

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
	// Which credential the call went out under, so a deployment can see
	// whether it is running on behalf of its callers yet.
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
	messages: ChatMessage[],
	tools: ToolDefinition[],
	maxTokens: number,
	handlers: StreamHandlers,
): Promise<Omit<Turn, "as">> {
	const timeout = AbortSignal.timeout(requestTimeoutMs);
	const signal = handlers.signal
		? AbortSignal.any([timeout, handlers.signal])
		: timeout;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: authorization,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		// No sampling parameters. Current models decide those themselves and
		// the endpoints reject the old ones, so the request carries only what
		// the conversation is and how long an answer may run.
		body: JSON.stringify({
			messages,
			...(tools.length > 0 ? { tools } : {}),
			max_tokens: maxTokens,
			stream: true,
		}),
		signal,
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new AssistantFailed(
			`The model endpoint answered ${response.status}. ${detail.slice(0, 300)}`,
		);
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

// Sent under the caller's own token where that token can reach a serving
// endpoint, and under the app's where it cannot.
//
// A Databricks App forwards a token carrying only the scopes granted under user
// authorization. With model-serving granted, every call below goes
// out as the person asking. Without it the app's service principal carries the
// call, and the data inside it is still only what that person's own queries
// returned.
export async function converse(
	callerToken: string | null,
	messages: ChatMessage[],
	tools: ToolDefinition[] = [],
	handlers: StreamHandlers = {},
	maxTokens = 8000,
): Promise<Turn> {
	const url = endpointUrl();
	if (!url) throw new AssistantOff();

	if (callerToken) {
		try {
			return {
				...(await post(
					url,
					`Bearer ${callerToken}`,
					messages,
					tools,
					maxTokens,
					handlers,
				)),
				as: "caller",
			};
		} catch (error) {
			// Only a refusal falls through, and a refusal arrives before any
			// text, so nothing has been streamed that would be streamed twice.
			const refused =
				error instanceof AssistantFailed &&
				/answered 40[13]/.test(error.message);
			if (!refused) throw error;
		}
	}

	const authorization = await appHeader();
	if (!authorization) {
		throw new AssistantFailed(
			"The assistant could not authenticate against the model endpoint",
		);
	}
	return {
		...(await post(
			url,
			authorization,
			messages,
			tools,
			maxTokens,
			handlers,
		)),
		as: "app",
	};
}
