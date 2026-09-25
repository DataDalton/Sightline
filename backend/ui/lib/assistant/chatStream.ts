// Reading a streamed chat completion.
//
// Every llm/v1/chat serving endpoint streams the same shape: server-sent
// events, each carrying a chunk whose delta holds a piece of text or a piece of
// a tool call. Text is handed on as it arrives so the reader watches the answer
// being written. Tool calls arrive split across chunks, the name in one and the
// arguments spread over many, and are only usable once reassembled.
//
// Kept free of network and settings imports so it can be tested on its own.

export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

// One tool call as it arrives in pieces: the id and name in the first chunk,
// the arguments spread across the rest.
interface PartialCall {
	id: string;
	name: string;
	arguments: string;
}

// Reads a server-sent event stream in the chat completion chunk shape, handing
// text to the caller as it arrives and assembling tool calls from their
// fragments.
export async function readChatStream(
	body: ReadableStream<Uint8Array>,
	onText?: (delta: string) => void,
): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let content = "";
	const calls = new Map<number, PartialCall>();

	const take = (payload: string) => {
		if (payload === "[DONE]") return;
		let chunk: {
			choices?: {
				delta?: {
					content?: unknown;
					tool_calls?: {
						index?: number;
						id?: string;
						function?: { name?: string; arguments?: string };
					}[];
				};
			}[];
		};
		try {
			chunk = JSON.parse(payload);
		} catch {
			return;
		}
		const delta = chunk.choices?.[0]?.delta;
		if (!delta) return;

		// Content arrives as a string from most endpoints and as a list of
		// typed parts from some, so both are read.
		const pieces: string[] = [];
		if (typeof delta.content === "string") pieces.push(delta.content);
		else if (Array.isArray(delta.content)) {
			for (const part of delta.content as {
				type?: string;
				text?: string;
			}[]) {
				if (part?.type === "text" && typeof part.text === "string") {
					pieces.push(part.text);
				}
			}
		}
		for (const piece of pieces) {
			if (!piece) continue;
			content += piece;
			onText?.(piece);
		}

		for (const fragment of delta.tool_calls ?? []) {
			const index = fragment.index ?? 0;
			const held = calls.get(index) ?? {
				id: "",
				name: "",
				arguments: "",
			};
			if (fragment.id) held.id = fragment.id;
			if (fragment.function?.name) held.name += fragment.function.name;
			if (fragment.function?.arguments) {
				held.arguments += fragment.function.arguments;
			}
			calls.set(index, held);
		}
	};

	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });

		// Events are separated by a blank line and each data line is one
		// payload. A partial event stays buffered until the rest arrives.
		let boundary = buffered.indexOf("\n");
		while (boundary >= 0) {
			const line = buffered.slice(0, boundary).replace(/\r$/, "");
			buffered = buffered.slice(boundary + 1);
			if (line.startsWith("data:")) take(line.slice(5).trim());
			boundary = buffered.indexOf("\n");
		}
	}
	if (buffered.trim().startsWith("data:")) {
		take(buffered.trim().slice(5).trim());
	}

	const toolCalls: ToolCall[] = [...calls.entries()]
		.sort(([a], [b]) => a - b)
		.map(([index, call]) => ({
			id: call.id || `call_${index}`,
			type: "function" as const,
			function: { name: call.name, arguments: call.arguments || "{}" },
		}))
		.filter((call) => call.function.name);

	return { content: content || null, toolCalls };
}
