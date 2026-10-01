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
	| "list_sources"
	| "describe_source"
	| "run_query"
	// Filling in the screen the question was asked from.
	| "draft"
	// Making a new board and saving it.
	| "create_board"
	| "unknown";

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
	| { type: "done"; ranAs: "caller" | "app" }
	| { type: "error"; message: string };

// Rows shown under a step. Enough to see what came back, few enough that a
// run of ten queries does not bury the answer.
export const previewRows = 6;
