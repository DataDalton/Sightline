// An assistant conversation as somebody other than its owner may see it.
//
// A saved conversation keeps the first rows each query returned, read under the
// owner's own access. Anybody else reading it, a maintainer it was shared with
// or a reviewer granted access, could lack that access, so the rows never leave
// with it. What stays is what was asked, the answers, each step the assistant
// took and what each query asked for. Drafts written for a screen are dropped
// too, since they can hold a copy of what that screen showed.
//
// Kept free of database and network imports so it can be tested on its own.

export interface SharedStep {
	label: string;
	summary: string | null;
	ok: boolean;
	// What a query asked for, never what it returned.
	query: {
		sourceKey?: string;
		dimensions?: string[];
		measures?: string[];
		filters?: unknown[];
		rowCount?: number;
		error?: string;
	} | null;
}

export type SharedTurn =
	| { role: "user"; content: string; pointedAt: string[] }
	| {
			role: "assistant";
			answer: string;
			narration: string[];
			steps: SharedStep[];
			status: string;
	  };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function sharedQuery(raw: unknown): SharedStep["query"] {
	if (!isObject(raw)) return null;
	return {
		sourceKey: text(raw.sourceKey) || undefined,
		dimensions: strings(raw.dimensions),
		measures: strings(raw.measures),
		filters: Array.isArray(raw.filters) ? raw.filters : [],
		rowCount: typeof raw.rowCount === "number" ? raw.rowCount : undefined,
		error: text(raw.error) || undefined,
	};
}

export function shareableTranscript(messages: unknown[]): SharedTurn[] {
	const turns: SharedTurn[] = [];
	for (const raw of messages) {
		if (!isObject(raw)) continue;
		if (raw.role === "user") {
			turns.push({
				role: "user",
				content: text(raw.content),
				pointedAt: strings(raw.attachments),
			});
			continue;
		}
		if (raw.role !== "assistant") continue;
		const narration: string[] = [];
		const steps: SharedStep[] = [];
		for (const item of Array.isArray(raw.activity) ? raw.activity : []) {
			if (!isObject(item)) continue;
			if (item.type === "narration") {
				narration.push(text(item.text));
			} else if (item.type === "step" && isObject(item.step)) {
				// The step's preview holds the rows, so only its words and
				// the query it ran are kept.
				steps.push({
					label: text(item.step.label),
					summary: text(item.step.summary) || null,
					ok: item.step.status !== "failed",
					query: sharedQuery(item.step.query),
				});
			}
		}
		turns.push({
			role: "assistant",
			answer: text(raw.answer) || text(raw.draft),
			narration,
			steps,
			status: text(raw.status),
		});
	}
	return turns;
}

// The transcript as plain text, for the assistant to read in a conversation.
export function transcriptText(turns: SharedTurn[], limit = 12_000): string {
	const lines: string[] = [];
	for (const turn of turns) {
		if (turn.role === "user") {
			lines.push(
				`Person: ${turn.content}${
					turn.pointedAt.length
						? ` (pointing at ${turn.pointedAt.join(", ")})`
						: ""
				}`,
			);
		} else {
			for (const step of turn.steps) {
				lines.push(
					`  Assistant ${step.ok ? "did" : "tried"}: ${step.label}${step.summary ? `, ${step.summary}` : ""}`,
				);
			}
			if (turn.answer) lines.push(`Assistant: ${turn.answer}`);
		}
	}
	const joined = lines.join("\n");
	return joined.length > limit
		? `${joined.slice(0, limit)}\n(cut short)`
		: joined;
}
