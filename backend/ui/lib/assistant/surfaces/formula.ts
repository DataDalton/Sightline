import {
	computeColumns,
	functionNames,
	isError,
	parse,
	references,
	type FormulaColumn,
	type Value,
} from "../../sheets/formula";
import { limits } from "../../sheets/definition";
import {
	asRecord,
	describeState,
	refusal,
	stringList,
	SurfaceRefused,
	text,
	type Surface,
} from "./shared";

// Writing a sheet's formula column from a description.
//
// The formula is parsed with the sheet's own parser, every column it reads is
// checked against the columns the sheet has, and it is computed over the rows
// the page sent, so a formula that parses but fails on every row goes back to
// the model with the error rather than into the dialog.

// The formula language, as the model is told it. The sheet's help lists the
// same functions for a person.
export const formulaLanguage = [
	"Formula language:",
	"- Columns are referenced by name in square brackets, such as [Revenue]. Names are matched without regard to case.",
	"- Numbers, text in double quotes, TRUE and FALSE. 15% means 0.15.",
	"- Arithmetic + - * / ^, comparison = <> < > <= >=, and & joins text.",
	`- Functions: ${functionNames.join(", ")}.`,
	"- IF(test, then, else) evaluates only the branch taken. IFERROR(value, fallback). COALESCE returns the first value that is not blank.",
	"- Looking down the whole column: TOTAL([A]) is the column total, SHARE([A]) is this row's fraction of the total, RANK([A]) is 1 for the largest, PREVIOUS([A]) is the row above, RUNNING([A]) is the running total. Their argument must be a column reference.",
	"- Dates: TODAY(), YEAR, MONTH, DAY, and DAYS(start, end) for whole days between two dates.",
	'- Examples: [Revenue] - [Cost]. IF([Units] > 0, [Revenue] / [Units], 0). ROUND(SHARE([Revenue]) * 100, 1). [Region] & " / " & [Category].',
].join("\n");

export interface FormulaDraft {
	name: string;
	formula: string;
}

// How many of the rows the page sent are used to try a formula out.
const sampleSize = 200;

function show(value: Value): string {
	if (isError(value)) {
		return value.detail ? `${value.code} (${value.detail})` : value.code;
	}
	if (value === null) return "(blank)";
	if (typeof value === "number") return String(Math.round(value * 1e6) / 1e6);
	return String(value);
}

export interface FormulaContext {
	columns: string[];
	formulas: FormulaColumn[];
	sampleRows: Record<string, unknown>[];
	// The formula column being edited, which its own name may be kept for.
	editingName: string | null;
}

export function readFormulaContext(state: unknown): FormulaContext {
	const s = asRecord(state);
	const formulas = (Array.isArray(s.formulas) ? s.formulas : [])
		.map(asRecord)
		.map((f, i) => ({
			id: text(f.id, 40) || `f${i}`,
			name: text(f.name, limits.nameLength),
			formula: text(f.formula, limits.formulaLength),
		}))
		.filter((f) => f.name && f.formula)
		.slice(0, limits.formulas);
	const sampleRows = (Array.isArray(s.sampleRows) ? s.sampleRows : [])
		.map(asRecord)
		.slice(0, sampleSize);
	return {
		columns: stringList(s.columns, 200),
		formulas,
		sampleRows,
		editingName: text(asRecord(s.editing).name, limits.nameLength) || null,
	};
}

// Checks one formula column against the sheet and tries it on the sample.
// Throws with the reason when it cannot be used.
export function checkFormula(
	context: FormulaContext,
	name: string,
	formula: string,
): { preview: Value[] } {
	if (!name) throw new SurfaceRefused("Give the column a name.");
	if (name.length > limits.nameLength) {
		throw new SurfaceRefused(
			`Keep the name under ${limits.nameLength} characters.`,
		);
	}
	const others = context.formulas.filter(
		(f) =>
			f.name.toLowerCase() !== (context.editingName ?? "").toLowerCase(),
	);
	const taken = new Set(
		[...context.columns, ...others.map((f) => f.name)].map((n) =>
			n.toLowerCase(),
		),
	);
	if (taken.has(name.toLowerCase())) {
		throw new SurfaceRefused(
			`Another column is already called "${name}". Choose a different name.`,
		);
	}
	if (!formula) throw new SurfaceRefused("Write the formula.");
	if (formula.length > limits.formulaLength) {
		throw new SurfaceRefused("The formula is too long.");
	}

	let node;
	try {
		node = parse(formula);
	} catch (error) {
		throw new SurfaceRefused(
			`The formula cannot be read: ${error instanceof Error ? error.message : "syntax error"}.`,
		);
	}

	const known = new Set(taken);
	for (const ref of references(node)) {
		if (!known.has(ref.toLowerCase())) {
			throw new SurfaceRefused(
				`There is no column called [${ref}]. The columns are: ${[
					...context.columns,
					...others.map((f) => f.name),
				].join(", ")}.`,
			);
		}
	}

	if (context.sampleRows.length === 0) return { preview: [] };
	const computed = computeColumns(context.sampleRows, context.columns, [
		...others,
		{ id: "__draft", name, formula },
	]);
	if (computed.problems[name]) {
		throw new SurfaceRefused(computed.problems[name]);
	}
	const values = computed.values.map((row) => row[name] ?? null);
	if (values.length > 0 && values.every(isError)) {
		throw new SurfaceRefused(
			`It gives an error on every row, for example ${show(values[0])}. Change it so it works on these rows.`,
		);
	}
	return { preview: values.slice(0, 5) };
}

export function formulaSurface(state: unknown): Surface {
	const context = readFormulaContext(state);

	return {
		kind: "formula",
		preferredSourceKey: null,
		tools: [
			{
				type: "function",
				function: {
					name: "set_formula",
					description:
						"Fill in the formula column dialog with a name and a formula. It is tried on the sheet's rows and the first results come back.",
					parameters: {
						type: "object",
						properties: {
							name: { type: "string" },
							formula: { type: "string" },
						},
						required: ["name", "formula"],
					},
				},
			},
		],
		instructions: [
			"The person is writing a formula column on a sheet and wants you to write it from what they describe.",
			`The sheet's columns: ${context.columns.join(", ") || "none yet"}.`,
			context.formulas.length
				? `Formula columns already on it: ${describeState(
						context.formulas.map((f) => ({
							name: f.name,
							formula: f.formula,
						})),
						4000,
					)}.`
				: "",
			context.sampleRows.length
				? `Its first rows: ${describeState(context.sampleRows.slice(0, 5), 4000)}`
				: "",
			formulaLanguage,
			"- Call set_formula with a short column name and the formula. Read the results that come back. If they are not what was asked for, or it was refused, correct it and call again.",
			"- Then reply with one short sentence saying what the column works out. There is no need to query any dataset for this.",
		]
			.filter(Boolean)
			.join("\n"),
		label: (_name, args) => `Writing ${text(args.name, 80) || "a formula"}`,
		run: (_name, args) => {
			try {
				const name = text(args.name, 200);
				const formula = text(args.formula, 2000);
				const { preview } = checkFormula(context, name, formula);
				const shown = preview.map(show);
				const draft: FormulaDraft = { name, formula };
				return {
					ok: true,
					summary: shown.length
						? `${name}: ${shown.join(", ")}`
						: `${name} = ${formula}`,
					result: shown.length
						? `Accepted. First rows give: ${shown.join(", ")}.`
						: "Accepted. The sheet has no rows to try it on yet.",
					draft,
				};
			} catch (error) {
				return refusal(error);
			}
		},
	};
}
