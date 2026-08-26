import {
	checkEncoding,
	isFilterVisual,
	visualByType,
	type VisualOption,
} from "./catalog";

// Checks a visual definition before it is stored.
//
// The catalogue has always described what each visual needs, and until now that
// description was only ever read in a browser: the properties panel drew the
// controls, checkEncoding warned about a missing field, and the renderer quietly
// dropped a name the source no longer defined. None of it ran on the way in.
// applyEdits took any visual_type string and any config object, and
// saveExploration took any source_key at all.
//
// That was survivable while the editor was the only thing that could write one.
// It stops being survivable as soon as a second surface can, and /explore
// already is one. So the same catalogue entry that draws the control now also
// decides whether what came back may be stored.
//
// Pure, so it can be tested directly and so the editor can call it too. The
// caller resolves the source and decides what to do with the answer.

export type Severity = "error" | "warning";

export interface ValidationProblem {
	severity: Severity;
	field: "visualType" | "sourceKey" | "dimensions" | "measures" | "options";
	message: string;
}

// The fields a source currently defines. Passed in rather than looked up, so
// this module has no registry behind it.
export interface SourceFields {
	dimensions: Set<string> | string[];
	measures: Set<string> | string[];
}

export interface VisualConfig {
	dimensions?: unknown;
	measures?: unknown;
	filters?: unknown;
	options?: unknown;
	[key: string]: unknown;
}

function asSet(fields: Set<string> | string[]): Set<string> {
	return fields instanceof Set ? fields : new Set(fields);
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

// Placeholders a page resolves from its own controls rather than from the
// source. Kept in step with lib/query/visualSpec, which drops the same two
// before building a query.
const placeholders = new Set(["<selected>", "<grain>"]);

function checkOption(
	option: VisualOption,
	value: unknown,
	source: SourceFields | null,
): ValidationProblem | null {
	const wrong = (expected: string): ValidationProblem => ({
		severity: "error",
		field: "options",
		message: `"${option.label}" expects ${expected}.`,
	});

	switch (option.kind) {
		case "select": {
			if (typeof value !== "string") return wrong("one of its choices");
			if (!option.choices.some((c) => c.value === value)) {
				return wrong(
					`one of: ${option.choices.map((c) => c.value).join(", ")}`,
				);
			}
			return null;
		}

		case "toggle":
			return typeof value === "boolean" ? null : wrong("true or false");

		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return wrong("a number");
			}
			if (option.min !== undefined && value < option.min) {
				return wrong(`at least ${option.min}`);
			}
			if (option.max !== undefined && value > option.max) {
				return wrong(`at most ${option.max}`);
			}
			return null;
		}

		case "text":
			return typeof value === "string" ? null : wrong("text");

		case "field": {
			if (typeof value !== "string") return wrong("a field name");
			// "none" is offered for every field option, because every one of
			// them names something an author may not want.
			if (value === "" || value === "none") return null;
			if (!source) return null;
			const known = asSet(
				option.scope === "measure"
					? source.measures
					: source.dimensions,
			);
			if (!known.has(value)) {
				return {
					severity: "warning",
					field: "options",
					message: `"${option.label}" names ${value}, which the source no longer defines.`,
				};
			}
			return null;
		}

		case "measureGroups": {
			if (!Array.isArray(value)) return wrong("a list of groups");
			return null;
		}
	}
}

// What is wrong with this definition, worst first.
//
// An error refuses the write. A warning is recorded and allowed: a field the
// semantic layer has since dropped is drift rather than a mistake, and blocking
// an unrelated edit until somebody fixes it would make the check the problem.
export function validateVisual(
	visualType: string,
	config: VisualConfig,
	source: SourceFields | null,
): ValidationProblem[] {
	const problems: ValidationProblem[] = [];

	const definition = visualByType[visualType];
	if (!definition) {
		// The one check with nothing after it. Everything below reads the
		// definition, and a type nobody renders is not worth describing further.
		return [
			{
				severity: "error",
				field: "visualType",
				message: `"${visualType}" is not a visual this build knows how to draw.`,
			},
		];
	}

	const dimensions = asStringArray(config.dimensions);
	const measures = asStringArray(config.measures);

	// A filter widget, a text panel or a notice reads nothing and encodes
	// nothing, so the field checks below would be asking about fields it never
	// had.
	const readsData = !isFilterVisual(visualType);

	if (readsData) {
		const encoding = checkEncoding(visualType, dimensions, measures);
		if (encoding) {
			problems.push({
				severity: "error",
				field: encoding.field,
				message: encoding.message,
			});
		}
	}

	if (source) {
		const knownDimensions = asSet(source.dimensions);
		const knownMeasures = asSet(source.measures);

		for (const name of dimensions) {
			if (placeholders.has(name)) continue;
			if (!knownDimensions.has(name)) {
				problems.push({
					severity: "warning",
					field: "dimensions",
					message: `The source does not define a dimension called ${name}.`,
				});
			}
		}
		for (const name of measures) {
			if (!knownMeasures.has(name)) {
				problems.push({
					severity: "warning",
					field: "measures",
					message: `The source does not define a measure called ${name}.`,
				});
			}
		}
	}

	const options =
		config.options && typeof config.options === "object"
			? (config.options as Record<string, unknown>)
			: {};
	const declared = new Map(
		(definition.options ?? []).map((o) => [o.key, o] as const),
	);

	for (const [key, value] of Object.entries(options)) {
		// Absent means "use the fallback", which is what optionValue does when
		// nothing is set. Storing null to mean the same thing is ordinary.
		if (value === null || value === undefined) continue;

		const option = declared.get(key);
		if (!option) {
			// Not an error. Options outlive the visual type an author switched
			// away from, and a setting nothing reads costs nothing. Reported so
			// a stale key is visible rather than mysterious.
			problems.push({
				severity: "warning",
				field: "options",
				message: `${definition.label} has no setting called ${key}.`,
			});
			continue;
		}

		const problem = checkOption(option, value, source);
		if (problem) problems.push(problem);
	}

	return problems.sort((a, b) =>
		a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
	);
}

export function hasError(problems: ValidationProblem[]): boolean {
	return problems.some((p) => p.severity === "error");
}

// One sentence naming what has to be fixed, for a refusal a person reads.
export function describeProblems(problems: ValidationProblem[]): string {
	const errors = problems.filter((p) => p.severity === "error");
	if (errors.length === 0) return "";
	if (errors.length === 1) return errors[0].message;
	return errors.map((p) => p.message).join(" ");
}
