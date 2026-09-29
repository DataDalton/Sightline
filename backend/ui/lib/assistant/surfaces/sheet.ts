import {
	cleanDefinition,
	limits,
	type SheetDefinition,
} from "../../sheets/definition";
import type { SemanticSource } from "../../semantic/types";
import { checkFormula, formulaLanguage, readFormulaContext } from "./formula";
import {
	asRecord,
	conditionSchema,
	describeState,
	readConditions,
	refusal,
	requireField,
	sourceFor,
	stringList,
	SurfaceRefused,
	text,
	type Surface,
} from "./shared";

// Changing a sheet from a description: which fields it reads, the conditions
// on them, its formula columns, its sort, and whether it is a table or a
// pivot. Each part is checked the way the sheet's own save checks it, and
// formulas are tried on the rows the page sent.

// Only the parts named in the call, so the page applies a change rather than
// replacing whatever the person did in between.
export type SheetDraft = Partial<
	Pick<
		SheetDefinition,
		| "sourceKey"
		| "mode"
		| "columns"
		| "conditions"
		| "formulas"
		| "sort"
		| "pivot"
	>
>;

function newId(): string {
	return Math.random().toString(36).slice(2, 10);
}

const tool = {
	type: "function" as const,
	function: {
		name: "edit_sheet",
		description:
			"Change the sheet. Only the parts given are changed. Lists given replace the list that was there, so include what should stay.",
		parameters: {
			type: "object",
			properties: {
				sourceKey: {
					type: "string",
					description:
						"Switch dataset. Give columns and conditions for the new one as well.",
				},
				columns: {
					type: "array",
					items: { type: "string" },
					description: "Fields shown as columns, in order.",
				},
				conditions: { type: "array", items: conditionSchema },
				formulas: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							formula: { type: "string" },
						},
						required: ["name", "formula"],
					},
					description:
						"Every formula column the sheet should have, including the ones to keep.",
				},
				sort: {
					type: "object",
					properties: {
						column: {
							type: "string",
							description: "A field or a formula column's name.",
						},
						direction: { type: "string", enum: ["asc", "desc"] },
					},
					required: ["column", "direction"],
				},
				mode: { type: "string", enum: ["table", "pivot"] },
				pivot: {
					type: "object",
					properties: {
						rows: {
							type: "array",
							items: { type: "string" },
							description: `Dimensions down the side, at most ${limits.pivotRows}.`,
						},
						columns: {
							type: "string",
							description:
								"One dimension across the top, or leave out.",
						},
						values: {
							type: "array",
							items: { type: "string" },
							description: `Measures in the cells, at most ${limits.pivotValues}.`,
						},
					},
				},
			},
		},
	},
};

export function sheetSurface(
	state: unknown,
	available: SemanticSource[],
): Surface {
	const s = asRecord(state);
	const current = cleanDefinition(s.definition);
	const context = readFormulaContext({
		columns: current.columns,
		formulas: current.formulas,
		sampleRows: s.sampleRows,
	});

	return {
		kind: "sheet",
		preferredSourceKey: current.sourceKey || null,
		tools: [tool],
		instructions: [
			"The person is working on a sheet, a table read from one dataset with formula columns worked out on each row, which can also be shown as a pivot. They want you to change it.",
			`The sheet now: ${describeState({
				sourceKey: current.sourceKey,
				mode: current.mode,
				columns: current.columns,
				conditions: current.conditions,
				formulas: current.formulas.map((f) => ({
					name: f.name,
					formula: f.formula,
				})),
				sort: current.sort,
				pivot: current.pivot,
			})}`,
			context.sampleRows.length
				? `Its first rows: ${describeState(context.sampleRows.slice(0, 5), 4000)}`
				: "",
			"- Read the dataset with describe_source before adding fields, and use names exactly as listed.",
			"- A pivot groups by its row dimensions and optional column dimension and aggregates its value measures. Set mode to pivot to show it.",
			formulaLanguage,
			"- Call edit_sheet with the parts that change. If it is refused, read the reason, correct it and call again.",
			"- Then reply with one or two short sentences saying what changed. The sheet updates in front of them.",
		]
			.filter(Boolean)
			.join("\n"),
		label: () => "Changing the sheet",
		run: (_name, args) => {
			try {
				const source = sourceFor(
					available,
					args.sourceKey ?? current.sourceKey,
				);
				const switched = source.sourceKey !== current.sourceKey;
				const draft: SheetDraft = {};
				if (switched) draft.sourceKey = source.sourceKey;

				const columns =
					args.columns !== undefined
						? stringList(args.columns, limits.fields)
						: switched
							? []
							: current.columns;
				for (const c of columns) requireField(source, c);
				if (args.columns !== undefined || switched)
					draft.columns = columns;

				if (args.conditions !== undefined || switched) {
					draft.conditions = readConditions(
						args.conditions ?? [],
						source,
					);
				}

				if (args.formulas !== undefined) {
					// The rows the page sent only hold the fields it was
					// showing. A formula over a field just added has nothing
					// to be tried on until the sheet reads it.
					const sampled = new Set(
						Object.keys(context.sampleRows[0] ?? {}),
					);
					const canTry =
						!switched && columns.every((c) => sampled.has(c));
					const accepted: SheetDefinition["formulas"] = [];
					for (const raw of (Array.isArray(args.formulas)
						? args.formulas
						: []
					).slice(0, limits.formulas)) {
						const f = asRecord(raw);
						const name = text(f.name, 200);
						const formula = text(f.formula, 2000);
						checkFormula(
							{
								columns,
								formulas: accepted,
								sampleRows: canTry ? context.sampleRows : [],
								editingName: null,
							},
							name,
							formula,
						);
						const kept = current.formulas.find(
							(existing) =>
								existing.name.toLowerCase() ===
								name.toLowerCase(),
						);
						accepted.push({
							id: kept?.id ?? newId(),
							name,
							formula,
						});
					}
					draft.formulas = accepted;
				}

				if (args.sort !== undefined) {
					const sort = asRecord(args.sort);
					const column = text(sort.column, 200);
					if (column) {
						const formulas = draft.formulas ?? current.formulas;
						const known =
							columns.includes(column) ||
							formulas.some((f) => f.name === column);
						if (!known) {
							throw new SurfaceRefused(
								`The sheet has no column called "${column}" to sort by.`,
							);
						}
						draft.sort = {
							column,
							direction:
								sort.direction === "desc" ? "desc" : "asc",
						};
					} else {
						draft.sort = null;
					}
				}

				if (args.pivot !== undefined) {
					const p = asRecord(args.pivot);
					const rows = stringList(p.rows, limits.pivotRows);
					for (const r of rows) requireField(source, r, "dimension");
					const across = text(p.columns, 200) || null;
					if (across) requireField(source, across, "dimension");
					const values = stringList(p.values, limits.pivotValues);
					for (const v of values) requireField(source, v, "measure");
					draft.pivot = { rows, columns: across, values };
				}

				if (args.mode === "pivot" || args.mode === "table") {
					draft.mode = args.mode;
				}
				const pivot = draft.pivot ?? current.pivot;
				if (
					(draft.mode ?? current.mode) === "pivot" &&
					pivot.values.length === 0
				) {
					throw new SurfaceRefused(
						"A pivot needs at least one measure in values.",
					);
				}

				// The whole sheet as it would be saved, so a combination the
				// save would cut down is caught here rather than after.
				cleanDefinition({ ...current, ...draft });

				const changed = Object.keys(draft);
				if (changed.length === 0) {
					throw new SurfaceRefused(
						"Nothing in the call changes the sheet.",
					);
				}
				return {
					ok: true,
					summary: `Changed ${changed.join(", ")}`,
					result: `Applied. Changed ${changed.join(", ")}. The sheet is reading its data again.`,
					draft,
				};
			} catch (error) {
				return refusal(error);
			}
		},
	};
}
