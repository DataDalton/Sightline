import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { executeQuery, QueryAccessError } from "../query/execute";
import {
	canonicalizeSpec,
	parseQuerySpec,
	QuerySpecError,
} from "../query/spec";
import { record } from "../telemetry/usage";
import type { SemanticSource } from "../semantic/types";
import { sourceContext, visualMenu } from "./context";
import {
	converse,
	type ChatMessage,
	type ToolCall,
	type ToolDefinition,
} from "./endpoint";
import {
	previewRows,
	type AssistantEvent,
	type ChartOut,
	type Preview,
	type QueryOut,
	type StepKind,
} from "./events";
import { addMemory, type Profile } from "./store";
import {
	ProposalRejected,
	validateProposal,
	type Proposal,
	type ProposalFilter,
} from "./spec";

// A data assistant that works the way an analyst does: find the dataset, read
// what its fields mean, ask it questions, read the answers, ask again, and then
// say what was found.
//
// Every query it runs goes through executeQuery under the identity of the
// person asking, so it reads exactly the rows that person could read and no
// others. Row filters, column masks and source access apply to it as they
// apply to a report. The model never holds a warehouse credential of its own.
//
// Everything it does is reported as it happens through emit: each step as it
// starts and finishes, the first rows of every result, and the answer as it is
// written.

// Rounds of tool use before it must answer. Enough to find a source, read it,
// and try a good number of cuts; a question that needs more is one to narrow.
const maxRounds = 14;

// What one query result may put in front of the model. Past this the rows are
// cut and it is told so, because a summary drawn from a silently truncated
// list reads as a summary of everything.
const maxRowsShown = 200;
const maxResultChars = 40_000;

// Charts an answer may carry back to the reader.
const maxCharts = 4;

export interface HistoryTurn {
	role: "user" | "assistant";
	content: string;
}

// What the person is looking at when they ask, so "this" and "here" mean the
// report on their screen.
export interface PageContext {
	description: string;
	preferredSources: string[];
	// Every visual on the report by id, described with the fields and
	// conditions it queries, so one the person points at can be named exactly.
	visuals: Record<string, string>;
}

const filterSchema = {
	type: "object",
	properties: {
		field: { type: "string" },
		op: {
			type: "string",
			enum: [
				"eq",
				"neq",
				"contains",
				"starts_with",
				"ends_with",
				"gt",
				"gte",
				"lt",
				"lte",
				"is_empty",
				"is_not_empty",
			],
		},
		value: { type: "string" },
		values: {
			type: "array",
			items: { type: "string" },
			description: "Several accepted values, with op eq or neq.",
		},
		negate: {
			type: "boolean",
			description:
				"Keep the rows this condition does not match. Rows with a blank value are kept.",
		},
	},
	required: ["field", "op"],
};

const rememberTool: ToolDefinition = {
	type: "function",
	function: {
		name: "remember",
		description:
			"Save something about how this person wants you to work, kept across all their future conversations. Use it only when they ask you to remember something, or state a lasting preference about how you answer. Never use it for figures from the data.",
		parameters: {
			type: "object",
			properties: {
				note: {
					type: "string",
					description:
						"One short sentence, written as an instruction to yourself.",
				},
			},
			required: ["note"],
		},
	},
};

const tools: ToolDefinition[] = [
	{
		type: "function",
		function: {
			name: "list_sources",
			description:
				"List the datasets the person asking can read, with what each one is about. Call this when it is not obvious which dataset answers the question.",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "describe_source",
			description:
				"Every dimension and measure on one dataset, with its type and the definition written on the dataset itself. Always read this before querying a dataset: several measures often look alike and only the definition says which one answers the question and which ones do not add up across rows.",
			parameters: {
				type: "object",
				properties: { sourceKey: { type: "string" } },
				required: ["sourceKey"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "run_query",
			description:
				"Run an aggregate query against one dataset and get the rows back. Results are filtered to what the person asking may see. Group by dimensions, aggregate measures. Filters on a measure apply after aggregation. Several run_query calls in one turn run at the same time, so batch independent cuts together. Set show to true for a result worth showing the person as a chart.",
			parameters: {
				type: "object",
				properties: {
					sourceKey: { type: "string" },
					dimensions: {
						type: "array",
						items: { type: "string" },
						description: "Dimension names exactly as listed.",
					},
					measures: {
						type: "array",
						items: { type: "string" },
						description: "Measure names exactly as listed.",
					},
					filters: {
						type: "array",
						items: filterSchema,
						description: "Conditions that must all hold.",
					},
					anyOf: {
						type: "array",
						items: { type: "array", items: filterSchema },
						description:
							"Alternatives: each inner list is a set of conditions that all hold, and a row passes when any list does. Applied on top of filters. Every condition in anyOf must be on dimensions, or every one on measures.",
					},
					sort: {
						type: "array",
						items: {
							type: "object",
							properties: {
								field: { type: "string" },
								direction: {
									type: "string",
									enum: ["asc", "desc"],
								},
							},
							required: ["field", "direction"],
						},
					},
					limit: { type: "integer", description: "At most 1000." },
					show: {
						type: "boolean",
						description:
							"Show this result to the person as a chart.",
					},
					visualType: {
						type: "string",
						description:
							"Chart to show it as, when show is true. One of the visuals listed in the instructions.",
					},
					title: {
						type: "string",
						description: "Chart title, when show is true.",
					},
				},
				required: ["sourceKey"],
			},
		},
	},
];

function instructions(
	context: PageContext | null,
	profile: Profile | null,
): string {
	const today = new Date().toISOString().slice(0, 10);
	// Their own words, and what they asked to be remembered. Placed after the
	// working rules so a preference about tone cannot override the rule that
	// every figure comes from a query.
	const personal = [
		...(profile?.instructions.trim()
			? [
					"",
					"How this person has asked you to work with them:",
					profile.instructions.trim(),
				]
			: []),
		...(profile?.memories.length
			? [
					"",
					"Things this person asked you to remember:",
					...profile.memories.map((m) => `- ${m.text}`),
				]
			: []),
	];
	return [
		"You are a data analyst working inside a reporting platform. You answer questions by querying governed datasets with the tools provided, reading the results, and explaining what you found.",
		`Today is ${today}.`,
		...(context ? ["", `Where the person is: ${context.description}`] : []),
		"",
		"How to work:",
		"- Before each step, say in one short sentence what you are about to check and why. The person sees this as you work.",
		"- Find the right dataset with list_sources, then read it with describe_source before querying it.",
		"- Read the field definitions. Pick the measure whose definition answers the question. Where a definition says a measure adds up per record but not across records, do not sum it across records.",
		"- Query as many times as the question needs, and run independent queries together in one turn. For discrepancies, outliers or changes, compare cuts: by period, by segment, against a total, against a peer group.",
		"- Never state a number you did not get from a query in this conversation. If something cannot be answered from the data, say so and say what is missing.",
		"- Results are filtered to what the person asking may see. Do not speculate about data outside that.",
		"- You can see the rows each query returns. Report figures exactly as they came back: do not round, adjust or estimate them without saying so, and do not describe a result as better or worse than it is.",
		"- A chart shares one axis, so only put measures on the same chart when they are in the same unit and of similar size. A percentage beside billions reads as a flat line at zero. Chart one measure, or query again for the other.",
		"- If a query fails, read the reason given. Never run the same query again: change it, for example fewer measures, a narrower period or a filter, or say what could not be answered.",
		`- Mark at most ${maxCharts} queries with show: true, and only for a result the person cannot already see. Never reproduce a chart that is on the page they are viewing. A summary of what is on screen usually needs no chart at all.`,
		"",
		"How to answer, once you have what you need:",
		"- Lead with the direct answer in one or two sentences.",
		"- Then the supporting findings as short bullets, each with the figures that back it. A small markdown table is fine where it is clearer.",
		"- End with one line suggesting the most useful follow-up question, starting with 'Next:'. Phrase it neutrally, as a way to see more of the data, never as though something is wrong with it.",
		"- Describe what the data shows in neutral terms. Report differences and changes as facts with their figures; do not call them problems, failures or concerns unless the person asked about problems.",
		"- Plain markdown. No preamble, no restating the question.",
		"",
		"Visuals available for show:",
		visualMenu(),
		...personal,
	].join("\n");
}

// Rows as the model reads them: columns once, then values, which is a fraction
// of the size of one object per row and says the same thing.
function tabulate(
	columns: string[],
	rows: Record<string, unknown>[],
): { text: string; shown: number } {
	const header = columns.join("\t");
	const lines: string[] = [header];
	let size = header.length;
	let shown = 0;
	for (const row of rows.slice(0, maxRowsShown)) {
		const line = columns
			.map((c) => {
				const v = row[c];
				return v === null || v === undefined ? "" : String(v);
			})
			.join("\t");
		if (size + line.length > maxResultChars) break;
		lines.push(line);
		size += line.length + 1;
		shown++;
	}
	return { text: lines.join("\n"), shown };
}

function describeFilter(f: ProposalFilter): string {
	const value = f.values?.length ? f.values.join(" or ") : (f.value ?? "");
	const ops: Record<string, string> = {
		eq: "is",
		neq: "is not",
		gt: ">",
		gte: ">=",
		lt: "<",
		lte: "<=",
		contains: "contains",
		starts_with: "starts with",
		ends_with: "ends with",
		is_empty: "is empty",
		is_not_empty: "is not empty",
	};
	const body = `${f.field} ${ops[f.op] ?? f.op}${value ? ` ${value}` : ""}`;
	return f.negate ? `not ${body}` : body;
}

// Why a query failed, in the warehouse's own words where it gave any. A reason
// is what lets both the reader and the model decide what to try instead; a
// flat "could not run" led the model to send the same query three times.
function reasonFor(error: unknown): string {
	if (error instanceof QuerySpecError || error instanceof QueryAccessError) {
		return error.message;
	}
	const raw = error instanceof Error ? error.message : String(error ?? "");
	const text = raw.replace(/\s+/g, " ").trim();
	if (/timed? ?out|timeout|deadline|cancel/i.test(text)) {
		return "the warehouse took too long and the query was stopped";
	}
	return text
		? `the warehouse refused it: ${text.slice(0, 240)}`
		: "the warehouse could not run that query";
}

// What a query asks, in words, for the step that runs it.
function describeQuery(p: Proposal, title: string): string {
	const what = p.measures.join(", ") || "rows";
	const by = p.dimensions.length ? ` by ${p.dimensions.join(", ")}` : "";
	const conditions = [
		...p.filters.map(describeFilter),
		...(p.anyOf?.length
			? [
					`(${p.anyOf
						.map((group) => group.map(describeFilter).join(" and "))
						.join(" or ")})`,
				]
			: []),
	];
	const where = conditions.length ? ` where ${conditions.join(" and ")}` : "";
	return `Querying ${title}: ${what}${by}${where}`;
}

export interface AgentRequest {
	question: string;
	history: HistoryTurn[];
	available: SemanticSource[];
	preferredSource: SemanticSource | null;
	context: PageContext | null;
	profile: Profile | null;
	// What the person pointed at on the page, already described in words.
	pointedAt: string | null;
}

export async function runAgent(
	identity: Identity,
	request: AgentRequest,
	emit: (event: AssistantEvent) => void,
	signal?: AbortSignal,
): Promise<void> {
	const {
		question,
		history,
		available,
		preferredSource,
		context,
		profile,
		pointedAt,
	} = request;
	const bySource = new Map(available.map((s) => [s.sourceKey, s]));
	const policy = await resolvePolicyClass(identity);
	let charts = 0;
	// Queries that already failed in this answer, by their cache key, with the
	// reason. Asking the same thing again costs the same wait for the same
	// failure, so the reason is handed straight back instead.
	const failed = new Map<string, string>();

	const messages: ChatMessage[] = [
		{ role: "system", content: instructions(context, profile) },
		...history.map(
			(turn): ChatMessage =>
				turn.role === "user"
					? { role: "user", content: turn.content }
					: { role: "assistant", content: turn.content },
		),
		{
			role: "user",
			content: [
				question,
				pointedAt
					? `\n\nThey pointed at these parts of the page while asking:\n${pointedAt}`
					: "",
				preferredSource
					? `\n\n(Answer from the dataset ${preferredSource.sourceKey}.)`
					: "",
			].join(""),
		},
	];

	const stepKind = (name: string): StepKind =>
		name === "remember" ||
		name === "list_sources" ||
		name === "describe_source" ||
		name === "run_query"
			? name
			: "unknown";

	const runTool = async (call: ToolCall): Promise<string> => {
		const id = call.id;
		const done = (
			ok: boolean,
			summary: string,
			extra: { preview?: Preview; query?: QueryOut } = {},
		) => emit({ type: "stepDone", id, ok, summary, ...extra });

		let args: Record<string, unknown> = {};
		try {
			args = call.function.arguments
				? JSON.parse(call.function.arguments)
				: {};
		} catch {
			emit({
				type: "step",
				id,
				kind: "unknown",
				label: "Reading a request",
			});
			done(false, "The request was not valid JSON");
			return "Error: the arguments were not valid JSON.";
		}

		const kind = stepKind(call.function.name);

		if (kind === "remember") {
			const note = String(args.note ?? "").trim();
			emit({
				type: "step",
				id,
				kind,
				label: note ? `Remembering: ${note}` : "Remembering",
			});
			if (!note) {
				done(false, "Nothing to remember");
				return "Error: the note was empty.";
			}
			try {
				await addMemory(identity.email, note);
				done(true, "Saved for your future conversations");
				return "Saved.";
			} catch {
				done(false, "Could not be saved");
				return "Error: it could not be saved.";
			}
		}

		if (kind === "list_sources") {
			emit({
				type: "step",
				id,
				kind,
				label: "Looking through the datasets you can read",
			});
			done(true, `${available.length} datasets`);
			return available
				.map(
					(s) =>
						`${s.sourceKey}: ${s.title}${s.description ? `. ${s.description}` : ""}`,
				)
				.join("\n");
		}

		const source = bySource.get(String(args.sourceKey ?? ""));

		if (kind === "describe_source") {
			emit({
				type: "step",
				id,
				kind,
				label: `Reading the definitions on ${source?.title ?? String(args.sourceKey ?? "a dataset")}`,
			});
			if (!source) {
				done(false, "Not a dataset you can read");
				return `Error: there is no dataset called "${String(args.sourceKey ?? "")}" that this person can read. Use list_sources.`;
			}
			done(
				true,
				`${source.dimensions.length} dimensions, ${source.measures.length} measures`,
			);
			return sourceContext(source);
		}

		if (kind !== "run_query") {
			emit({ type: "step", id, kind, label: call.function.name });
			done(false, "Not a tool the assistant has");
			return `Error: there is no tool called ${call.function.name}.`;
		}

		if (!source) {
			emit({ type: "step", id, kind, label: "Running a query" });
			done(false, "Not a dataset you can read");
			return `Error: there is no dataset called "${String(args.sourceKey ?? "")}" that this person can read. Use list_sources.`;
		}

		let proposal: Proposal;
		try {
			proposal = validateProposal(
				{ ...args, visualType: args.visualType ?? "table" },
				source,
			);
		} catch (error) {
			// A chart that cannot hold the fields should not stop the query:
			// the data is what the analysis needs, the chart is decoration.
			try {
				if (
					error instanceof ProposalRejected &&
					/takes \d+ to \d+ dimensions/.test(error.message)
				) {
					proposal = validateProposal(
						{ ...args, visualType: "table" },
						source,
					);
				} else {
					throw error;
				}
			} catch (refused) {
				const message =
					refused instanceof Error
						? refused.message
						: "the query was refused";
				emit({
					type: "step",
					id,
					kind,
					label: `Querying ${source.title}`,
				});
				done(false, message);
				return `Error: ${message}`;
			}
		}

		emit({
			type: "step",
			id,
			kind,
			label: describeQuery(proposal, source.title),
		});

		const out: QueryOut = {
			sourceKey: proposal.sourceKey,
			sourceTitle: source.title,
			dimensions: proposal.dimensions,
			measures: proposal.measures,
			filters: proposal.filters,
			sort: proposal.sort,
			rowCount: 0,
		};

		try {
			const spec = parseQuerySpec({
				sourceKey: proposal.sourceKey,
				dimensions: proposal.dimensions,
				measures: proposal.measures,
				filters: proposal.filters,
				...(proposal.anyOf ? { anyOf: proposal.anyOf } : {}),
				sort: proposal.sort,
				limit: proposal.limit,
				offset: 0,
				transforms: [],
			});

			const key = canonicalizeSpec(spec);
			const before = failed.get(key);
			if (before) {
				out.error = before;
				done(false, `Already failed: ${before}`, { query: out });
				return `Error: this exact query already failed in this answer (${before}). Change it rather than running it again.`;
			}

			// Under the asking person's identity, exactly as a report runs.
			const result = await executeQuery(identity, spec).catch((error) => {
				failed.set(key, reasonFor(error));
				throw error;
			});
			out.rowCount = result.rowCount;

			record({
				occurredOn: new Date().toISOString(),
				userEmail: identity.email,
				policyClass: policy.id,
				eventType: "query",
				sourceKey: spec.sourceKey,
				durationMs: result.durationMs,
				queryMs: result.queryMs,
				rowCount: result.rowCount,
				cacheHit: result.source !== "warehouse",
				sessionId: null,
			});

			done(
				true,
				`${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? "row" : "rows"}${
					result.queryMs !== null
						? ` in ${(result.queryMs / 1000).toFixed(1)}s`
						: ", from cache"
				}`,
				{
					query: out,
					preview: {
						columns: result.columns,
						rows: result.rows
							.slice(0, previewRows)
							.map((row) =>
								result.columns.map((c) =>
									row[c] === null || row[c] === undefined
										? null
										: String(row[c]),
								),
							),
						total: result.rowCount,
					},
				},
			);

			if (args.show === true && charts < maxCharts) {
				charts++;
				const chart: ChartOut = {
					sourceKey: proposal.sourceKey,
					dimensions: proposal.dimensions,
					measures: proposal.measures,
					filters: proposal.filters,
					sort: proposal.sort,
					limit: proposal.limit,
					visualType: proposal.visualType,
					title:
						typeof args.title === "string" && args.title.trim()
							? args.title.trim().slice(0, 120)
							: `${proposal.measures.join(", ")}${
									proposal.dimensions.length
										? ` by ${proposal.dimensions.join(", ")}`
										: ""
								}`,
				};
				// OR groups are not something a chart on the page can carry,
				// so a chart is only offered for a query without them.
				if (!proposal.anyOf) emit({ type: "chart", chart });
			}

			const { text, shown } = tabulate(result.columns, result.rows);
			const cut =
				shown < result.rowCount
					? `\n(${shown} of ${result.rowCount} rows shown. Narrow the query or aggregate further to see the rest.)`
					: "";
			return `${result.rowCount} rows.\n${text}${cut}`;
		} catch (error) {
			const message = reasonFor(error);
			out.error = message;
			done(false, message, { query: out });
			return `Error: ${message}`;
		}
	};

	let ranAs: "caller" | "app" = "app";

	for (let round = 0; round < maxRounds; round++) {
		if (signal?.aborted) return;

		// The last round offers no tools, so the model has to answer with what
		// it has rather than asking for one more query for ever.
		const last = round === maxRounds - 1;
		const turn = await converse(
			identity.userToken,
			messages,
			last ? [] : [...tools, rememberTool],
			{ onText: (delta) => emit({ type: "text", delta }), signal },
		);
		ranAs = turn.as;

		if (turn.toolCalls.length === 0 || last) {
			emit({ type: "done", ranAs });
			return;
		}

		messages.push({
			role: "assistant",
			content: turn.content,
			tool_calls: turn.toolCalls,
		});

		// Independent steps run at the same time. The results go back in the
		// order the model asked for them, which is the order it expects.
		const results = await Promise.all(turn.toolCalls.map(runTool));
		turn.toolCalls.forEach((call, i) => {
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: results[i],
			});
		});
	}

	emit({ type: "done", ranAs });
}
