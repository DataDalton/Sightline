import { visualByType } from "../visuals/catalog";
import type { SemanticSource } from "../semantic/types";

// Turning a model's reply into something the platform will run, or refusing it.
//
// The model writes a question, never an answer and never SQL. What comes back
// is the same small object every visual already builds, so it cannot express
// anything the semantic layer does not: no join it was not given, no table the
// source does not expose, no statement that is not a read.
//
// Nothing below trusts the reply. A name that is not in the registry, a visual
// type that is not in the catalogue, or an encoding the chosen chart cannot
// take is a refusal rather than a query, because a plausible wrong field is the
// failure that produces a confident wrong number.

export interface ProposalFilter {
	field: string;
	op: string;
	value?: string;
	values?: string[];
	negate?: boolean;
}

export interface Proposal {
	sourceKey: string;
	dimensions: string[];
	measures: string[];
	filters: ProposalFilter[];
	// Alternatives: each group is a set of conditions that all hold, and a row
	// passes when any group does.
	anyOf?: ProposalFilter[][];
	sort: { field: string; direction: "asc" | "desc" }[];
	limit: number;
	visualType: string;
	// One line saying what was built, shown above the result. Not an
	// interpretation of the numbers: the model has not seen them.
	note: string;
}

export class ProposalRejected extends Error {}

// A model asked for JSON tends to wrap it in prose or a fence whatever it is
// told. Both are stripped rather than refused, because the content is right and
// the packaging is not what this is checking.
function extractJson(reply: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
	const body = (fenced ? fenced[1] : reply).trim();

	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new ProposalRejected("The model did not return a query");
	}

	try {
		return JSON.parse(body.slice(start, end + 1));
	} catch {
		throw new ProposalRejected(
			"The model returned a query that is not valid JSON",
		);
	}
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

// Upper bound on what one answer may ask for. Not a cost control, which the
// query layer already applies: a backstop against a reply asking for a hundred
// thousand rows because it repeated a number out of the question.
const maxRows = 1000;

export function parseProposal(reply: string, source: SemanticSource): Proposal {
	return validateProposal(extractJson(reply), source);
}

// The same checks for a query that arrives as tool arguments rather than as
// text, which is how the assistant asks for data while it works.
export function validateProposal(
	value: unknown,
	source: SemanticSource,
): Proposal {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ProposalRejected("The model did not return a query");
	}
	const raw = value as Record<string, unknown>;

	if (
		typeof raw.sourceKey === "string" &&
		raw.sourceKey !== source.sourceKey
	) {
		throw new ProposalRejected(
			`The model answered about ${raw.sourceKey}, which is not the source in question`,
		);
	}

	const dimensions = stringList(raw.dimensions);
	const measures = stringList(raw.measures);

	if (dimensions.length === 0 && measures.length === 0) {
		throw new ProposalRejected("The model returned a query with no fields");
	}

	// Every name checked against the registry, by the list it belongs in. A
	// measure asked for as a dimension is a different query, not a typo.
	const known = new Map(
		[...source.dimensions, ...source.measures].map((f) => [f.name, f.kind]),
	);

	for (const [names, expected] of [
		[dimensions, "dimension"],
		[measures, "measure"],
	] as const) {
		for (const name of names) {
			const kind = known.get(name);
			if (!kind) {
				throw new ProposalRejected(
					`${source.title} has no field called "${name}"`,
				);
			}
			if (kind !== expected) {
				throw new ProposalRejected(
					`"${name}" is a ${kind} on ${source.title} and was asked for as a ${expected}`,
				);
			}
		}
	}

	const readFilters = (value: unknown): ProposalFilter[] =>
		(Array.isArray(value) ? value : [])
			.filter(
				(f): f is Record<string, unknown> =>
					Boolean(f) && typeof f === "object" && !Array.isArray(f),
			)
			.map((f) => {
				const values = stringList(f.values);
				return {
					field: String(f.field ?? ""),
					op: String(f.op ?? "eq"),
					...(values.length > 0
						? { values }
						: typeof f.value === "string"
							? { value: f.value }
							: {}),
					...(f.negate === true ? { negate: true } : {}),
				};
			})
			.filter((f) => f.field.length > 0);

	const filters = readFilters(raw.filters);
	const groups = (Array.isArray(raw.anyOf) ? raw.anyOf : [])
		.map(readFilters)
		.filter((group) => group.length > 0);

	for (const filter of [...filters, ...groups.flat()]) {
		if (!known.has(filter.field)) {
			throw new ProposalRejected(
				`${source.title} has no field called "${filter.field}" to filter by`,
			);
		}
	}

	const sort = (Array.isArray(raw.sort) ? raw.sort : [])
		.filter(
			(s): s is Record<string, unknown> =>
				Boolean(s) && typeof s === "object" && !Array.isArray(s),
		)
		.map((s) => ({
			field: String(s.field ?? ""),
			direction:
				s.direction === "asc" ? ("asc" as const) : ("desc" as const),
		}))
		.filter((s) => s.field.length > 0);

	for (const entry of sort) {
		if (!known.has(entry.field)) {
			throw new ProposalRejected(
				`${source.title} has no field called "${entry.field}" to sort by`,
			);
		}
	}

	// The catalogue decides whether the chart can take what was asked for, so
	// the rule lives in one place and the reason can be quoted back.
	const visualType =
		typeof raw.visualType === "string" ? raw.visualType : "table";
	const definition = visualByType[visualType];
	if (!definition) {
		throw new ProposalRejected(`There is no visual called "${visualType}"`);
	}

	const { encoding } = definition;
	if (
		dimensions.length < encoding.dimensions.min ||
		dimensions.length > encoding.dimensions.max ||
		measures.length < encoding.measures.min ||
		measures.length > encoding.measures.max
	) {
		throw new ProposalRejected(
			`A ${definition.label} takes ${encoding.dimensions.min} to ${encoding.dimensions.max} dimensions and ${encoding.measures.min} to ${encoding.measures.max} measures, and the model asked for ${dimensions.length} and ${measures.length}`,
		);
	}

	const asked = Number(raw.limit);
	const limit = Number.isFinite(asked)
		? Math.max(1, Math.min(Math.floor(asked), maxRows))
		: 200;

	return {
		sourceKey: source.sourceKey,
		dimensions,
		measures,
		filters,
		...(groups.length > 0 ? { anyOf: groups } : {}),
		sort,
		limit,
		visualType,
		note: typeof raw.note === "string" ? raw.note.slice(0, 400) : "",
	};
}
