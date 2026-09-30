// Keeps the conversation sent back to the model within what the endpoint
// accepts, applied between the model's turns.
//
// Kept free of network and settings imports so it can be tested on its own.
// The message shape is the chat one the endpoint sends, written out loosely
// so this module does not import it.

interface ToolMessage {
	role: "tool";
	tool_call_id: string;
	content: string;
}

type AnyMessage = { role: string; content?: string | null } | ToolMessage;

// The most text the conversation may carry into the next turn, in characters.
// Each query result can be long, and an answer that runs many rounds of many
// queries would otherwise outgrow what the endpoint accepts and fail after
// every query had already been paid for.
export const maxConversationChars = 400_000;

const elided =
	"(This earlier result was removed to keep the conversation within its size limit. Run the query again if it is still needed.)";

function size(message: AnyMessage): number {
	return typeof message.content === "string" ? message.content.length : 0;
}

// Replaces the oldest tool results with a short note until the whole
// conversation fits the budget. The instructions, the question and the
// model's own words are kept, and the newest results are kept longest, since
// those are what the next turn is most likely to be about.
export function trimToolResults<M extends AnyMessage>(
	messages: M[],
	budget = maxConversationChars,
): M[] {
	let total = messages.reduce((sum, m) => sum + size(m), 0);
	if (total <= budget) return messages;
	const out = [...messages];
	for (let i = 0; i < out.length && total > budget; i++) {
		const message = out[i];
		if (message.role !== "tool" || size(message) <= elided.length) continue;
		total -= size(message) - elided.length;
		out[i] = { ...message, content: elided };
	}
	return out;
}
