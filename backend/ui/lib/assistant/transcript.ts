import type {
	AssistantEvent,
	ChartOut,
	Preview,
	QueryOut,
	StepKind,
} from "./events";

// A conversation as the reader sees it, built up one streamed event at a time.
//
// Kept free of browser imports so the one subtle rule in it can be tested: text
// written before a step is the assistant saying what it is about to do, and
// becomes narration in the working; text written after the last step is the
// answer. Nothing says which is which until the next step arrives or the
// answer ends, so text is held as a draft until one of them does.

export interface Step {
	id: string;
	kind: StepKind;
	label: string;
	status: "running" | "ok" | "failed";
	summary?: string;
	preview?: Preview;
	query?: QueryOut;
	startedAt: number;
	finishedAt?: number;
}

// What happened while an answer was being worked out, in order: what it said
// it was about to do, and each thing it did.
export type Activity =
	| { type: "narration"; text: string }
	| { type: "step"; step: Step };

export type Message =
	| {
			role: "user";
			id: string;
			content: string;
			// Names of the parts of the page pointed at with the question.
			attachments?: string[];
	  }
	| {
			role: "assistant";
			id: string;
			question: string;
			activity: Activity[];
			// Text written since the last step. Becomes narration if another
			// step follows it, and is the answer if none does.
			draft: string;
			answer: string;
			charts: ChartOut[];
			status: "streaming" | "done" | "stopped" | "error";
			error?: string;
			ranAs?: "caller" | "app";
			// Drafts written for a screen that was no longer open when they
			// arrived. Kept with the answer rather than applied elsewhere.
			heldDrafts?: { kind: string; draft: unknown }[];
			// What the answer made and saved, with where to open it.
			created?: { kind: "board"; title: string; href: string }[];
			startedAt: number;
			finishedAt?: number;
	  };

// Applies one streamed event to the answer it belongs to.
export function applyEvent(
	message: Extract<Message, { role: "assistant" }>,
	event: AssistantEvent,
	now = Date.now(),
): Extract<Message, { role: "assistant" }> {
	switch (event.type) {
		case "text":
			return { ...message, draft: message.draft + event.delta };
		case "step": {
			const activity = [...message.activity];
			if (message.draft.trim()) {
				activity.push({
					type: "narration",
					text: message.draft.trim(),
				});
			}
			activity.push({
				type: "step",
				step: {
					id: event.id,
					kind: event.kind,
					label: event.label,
					status: "running",
					startedAt: now,
				},
			});
			return { ...message, activity, draft: "" };
		}
		case "stepDone":
			return {
				...message,
				activity: message.activity.map((a) =>
					a.type === "step" && a.step.id === event.id
						? {
								...a,
								step: {
									...a.step,
									status: event.ok ? "ok" : "failed",
									summary: event.summary,
									preview: event.preview,
									query: event.query,
									finishedAt: now,
								},
							}
						: a,
				),
			};
		case "chart":
			return { ...message, charts: [...message.charts, event.chart] };
		// Handed to the screen that asked. The step that made it already
		// says what it was.
		case "draft":
			return message;
		case "created":
			return {
				...message,
				created: [
					...(message.created ?? []),
					{ kind: event.kind, title: event.title, href: event.href },
				],
			};
		case "done":
			return {
				...message,
				status: "done",
				answer: message.draft.trim(),
				draft: "",
				ranAs: event.ranAs,
				finishedAt: now,
			};
		case "error":
			return {
				...message,
				status: "error",
				error: event.message,
				answer: message.draft.trim(),
				draft: "",
				finishedAt: now,
			};
	}
}
