// What the assistant reports while it works, as it happens.
//
// Sent one per line down a streamed response, so the reader sees each step the
// moment it starts: which dataset it is reading, which query it is running and
// under what conditions, how many rows came back and what the first of them
// look like, then the answer as it is written. A spinner that says "thinking"
// for forty seconds tells somebody nothing about whether to wait or to ask
// differently. This does.
//
// Shared by the server that writes these and the page that reads them, so the
// two cannot disagree about the shape.

export interface QueryFilterOut {
	field: string;
	op: string;
	value?: string;
	values?: string[];
	negate?: boolean;
}

export interface ChartOut {
	sourceKey: string;
	dimensions: string[];
	measures: string[];
	filters: QueryFilterOut[];
	sort: { field: string; direction: "asc" | "desc" }[];
	limit: number;
	visualType: string;
	title: string;
}

export interface QueryOut {
	sourceKey: string;
	sourceTitle: string;
	dimensions: string[];
	measures: string[];
	filters: QueryFilterOut[];
	sort: { field: string; direction: "asc" | "desc" }[];
	rowCount: number;
	error?: string;
}

// The first rows of a result, shown under the step that fetched them.
export interface Preview {
	columns: string[];
	rows: (string | null)[][];
	total: number;
}

export type StepKind =
	| "remember"
	| "list_updates"
	| "list_sources"
	| "describe_source"
	| "run_query"
	// Filling in the screen the question was asked from.
	| "draft"
	// Making a new board and saving it.
	| "create_board"
	// Noting what somebody said about a visual for its maintainers.
	| "record_feedback"
	// Offering to put somebody in touch with a report's maintainers.
	| "offer_maintainers"
	// Offering to ask the data engineers for work.
	| "offer_work_request"
	| "unknown";

// An offer to start a conversation with a report's maintainers, shown as a card
// the person has to accept. Nothing is sent, and no conversation is shared,
// without that.
export interface MaintainerOffer {
	reportSlug: string;
	reportTitle: string;
	visualId: string | null;
	visualTitle: string | null;
	// What the conversation would be about, and the first message, in the
	// person's own voice.
	subject: string;
	message: string;
	// What the assistant already checked, which it posts in the conversation
	// so the maintainers do not start from nothing.
	checked: string;
}

// An offer to send the data engineers a request, shown as a card the person can
// change and has to send themselves.
export interface WorkOffer {
	title: string;
	description: string;
	sourceKey: string | null;
	sourceTitle: string | null;
}

export type AssistantEvent =
	// A piece of text the model is writing. Text written before a step is its
	// reasoning about what to do next; text after the last step is the answer.
	| { type: "text"; delta: string }
	| { type: "step"; id: string; kind: StepKind; label: string }
	| {
			type: "stepDone";
			id: string;
			ok: boolean;
			summary: string;
			preview?: Preview;
			query?: QueryOut;
	  }
	| { type: "chart"; chart: ChartOut }
	// Something to put on the screen the question was asked from: an alert,
	// a formula, a table, edits to a page. Checked before it is sent, and
	// applied by the screen as an unsaved change.
	| { type: "draft"; kind: string; draft: unknown }
	// Something the assistant made and saved, such as a new board, with where
	// to open it.
	| { type: "created"; kind: "board"; title: string; href: string }
	| { type: "offer"; offer: MaintainerOffer }
	| { type: "workOffer"; offer: WorkOffer }
	| { type: "done"; ranAs: "caller" | "app" }
	| { type: "error"; message: string };

// Rows shown under a step. Enough to see what came back, few enough that a
// run of ten queries does not bury the answer.
export const previewRows = 6;
