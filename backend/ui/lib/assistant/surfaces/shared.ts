import { bracketProblem, type Condition } from "../../explore/conditions";
import { cleanState } from "../../explore/state";
import type { SemanticSource } from "../../semantic/types";

// What every screen the assistant can fill in has in common.
//
// A screen sends what it holds when the question is asked, and is offered one
// or two tools that write a draft back to it: an alert, a formula, a table in
// Explore, edits to a report page. The draft is checked here with the same
// rules the screen and its save already apply, so the model cannot hand the
// page anything the page's own controls would not have accepted. Nothing is
// saved by the assistant. The person sees the draft on the screen and saves it
// themselves, or does not.
//
// Kept free of network and registry imports, so each screen's checks can be
// tested with a source written out by hand.

export type SurfaceKind =
	| "alert"
	| "formula"
	| "sheet"
	| "explore"
	| "editor"
	| "board";

export const surfaceKinds: SurfaceKind[] = [
	"alert",
	"formula",
	"sheet",
	"explore",
	"editor",
	"board",
];

// The tool shape every chat endpoint takes. Written out here rather than
// imported from the endpoint module, which reads settings and so cannot be
// loaded by a test.
export interface SurfaceTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface SurfaceOutcome {
	ok: boolean;
	// Shown to the person under the step that made the call.
	summary: string;
	// What the model reads back, including why a draft was refused.
	result: string;
	// Sent to the screen when the call was accepted.
	draft?: unknown;
}

export interface Surface {
	kind: SurfaceKind;
	// Added to the assistant's instructions for this question.
	instructions: string;
	tools: SurfaceTool[];
	// The dataset the screen is already on, which questions start from.
	preferredSourceKey: string | null;
	// What the step says while the call runs.
	label: (name: string, args: Record<string, unknown>) => string;
	run: (name: string, args: Record<string, unknown>) => SurfaceOutcome;
}

// A draft that breaks a rule, with the rule in words the model can act on.
export class SurfaceRefused extends Error {}

export function refusal(error: unknown): SurfaceOutcome {
	const message =
		error instanceof Error ? error.message : "The draft was refused.";
	return {
		ok: false,
		summary: message,
		result: `Refused: ${message} Correct it and call the tool again.`,
	};
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function text(value: unknown, max = 500): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function stringList(value: unknown, max = 60): string[] {
	return (Array.isArray(value) ? value : [])
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim())
		.filter(Boolean)
		.slice(0, max);
}

// A dataset the person can read, found by key, or a refusal that says how to
// find one.
export function sourceFor(
	available: SemanticSource[],
	sourceKey: unknown,
): SemanticSource {
	const key = text(sourceKey, 200);
	const source = available.find((s) => s.sourceKey === key);
	if (!source) {
		throw new SurfaceRefused(
			key
				? `There is no dataset called "${key}" that this person can read. Use list_sources.`
				: "Name the dataset with sourceKey.",
		);
	}
	return source;
}

export function fieldKinds(
	source: SemanticSource,
): Map<string, "dimension" | "measure"> {
	return new Map(
		[...source.dimensions, ...source.measures].map((f) => [
			f.name,
			f.kind === "measure" ? "measure" : "dimension",
		]),
	);
}

// A field name as the dataset spells it, checked for the kind the draft
// needs it to be. A measure asked for as a dimension is a different question,
// not a typo.
export function requireField(
	source: SemanticSource,
	name: string,
	kind?: "dimension" | "measure",
): string {
	const found = fieldKinds(source).get(name);
	if (!found) {
		throw new SurfaceRefused(
			`${source.title} has no field called "${name}". Read it with describe_source and use a name exactly as listed.`,
		);
	}
	if (kind && found !== kind) {
		throw new SurfaceRefused(
			`"${name}" is a ${found} on ${source.title}, and a ${kind} is needed here.`,
		);
	}
	return name;
}

// Row conditions in Explore's shape, checked the way a saved exploration is
// and then field by field against the dataset.
export function readConditions(
	raw: unknown,
	source: SemanticSource,
): Condition[] {
	const state = cleanState({
		sourceKey: source.sourceKey,
		columns: [],
		conditions: Array.isArray(raw) ? raw : [],
	});
	const conditions = state?.conditions ?? [];
	for (const condition of conditions) requireField(source, condition.field);
	const brackets = bracketProblem(conditions);
	if (brackets) throw new SurfaceRefused(brackets);
	return conditions;
}

// The comparisons a condition or a filter can make.
export const operators = [
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"contains",
	"starts_with",
	"ends_with",
	"is_empty",
	"is_not_empty",
];

// A condition as Explore, sheets and alerts hold it.
export const conditionSchema = {
	type: "object",
	properties: {
		field: { type: "string" },
		op: { type: "string", enum: operators },
		value: { type: "string" },
		values: {
			type: "array",
			items: { type: "string" },
			description: "Several accepted values, with op eq or neq.",
		},
		negate: {
			type: "boolean",
			description: "Keep the rows this condition does not match.",
		},
		join: {
			type: "string",
			enum: ["and", "or"],
			description: "How it joins the condition before it. Default and.",
		},
		open: {
			type: "integer",
			description: "Brackets opened just before this condition.",
		},
		close: {
			type: "integer",
			description: "Brackets closed just after this condition.",
		},
	},
	required: ["field", "op"],
};

// A filter as a visual stores it, which is the query's own shape.
export const filterSchema = {
	type: "object",
	properties: {
		field: { type: "string" },
		op: { type: "string", enum: operators },
		value: { type: "string" },
		values: { type: "array", items: { type: "string" } },
		negate: { type: "boolean" },
	},
	required: ["field", "op"],
};

// The screen's state as the model reads it. Cut to a size that leaves room
// for the question, because a page of forty visuals written out whole is
// longer than most of what the model needs to know about it.
export function describeState(state: unknown, max = 12_000): string {
	const json = JSON.stringify(state ?? null);
	return json.length > max ? `${json.slice(0, max)}...(cut)` : json;
}
