import { cleanState, type ExploreState } from "../../explore/state";
import type { SemanticSource } from "../../semantic/types";
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
	type Surface,
} from "./shared";

// Setting up Explore's table from a description: the dataset, its columns and
// the conditions on them, exactly what the bar at the top of Explore holds.
// Follow-up questions change the table that is there rather than starting
// again, because the model is told what the bar holds each time.

const maxColumns = 60;

export function exploreSurface(
	state: unknown,
	available: SemanticSource[],
): Surface {
	const current = cleanState(asRecord(state)) ?? {
		sourceKey: "",
		columns: [],
		conditions: [],
	};

	return {
		kind: "explore",
		preferredSourceKey: current.sourceKey || null,
		tools: [
			{
				type: "function",
				function: {
					name: "set_exploration",
					description:
						"Set the table on the Explore screen: the dataset, the columns in order, and the row conditions. Replaces what is there, so include what should stay.",
					parameters: {
						type: "object",
						properties: {
							sourceKey: { type: "string" },
							columns: {
								type: "array",
								items: { type: "string" },
								description:
									"Dimensions group the rows and measures are aggregated for each group, in the order shown.",
							},
							conditions: {
								type: "array",
								items: conditionSchema,
							},
						},
						required: ["sourceKey", "columns"],
					},
				},
			},
		],
		instructions: [
			"The person is on Explore, which shows one table from one dataset: dimensions group the rows, measures are aggregated for each group, and conditions narrow the rows.",
			`What Explore shows now: ${describeState(current)}`,
			"- When they ask for a table or a change to it, read the dataset with describe_source, then call set_exploration with the whole table. For a follow-up such as adding a split or a condition, keep what is there and change only what they asked for.",
			"- A condition on a measure applies after the rows are grouped.",
			"- Explore sorts by clicking a column, which you cannot do. If they ask for an order, say which column to click.",
			"- After setting the table, reply with one short sentence saying what it shows. If they also asked a question about the numbers, answer it from a query.",
		].join("\n"),
		label: () => "Setting up the table",
		run: (_name, args) => {
			try {
				const source = sourceFor(available, args.sourceKey);
				const columns = stringList(args.columns, maxColumns);
				if (columns.length === 0) {
					throw new SurfaceRefused("Choose at least one column.");
				}
				for (const c of columns) requireField(source, c);
				const conditions = readConditions(args.conditions, source);
				const draft: ExploreState = {
					sourceKey: source.sourceKey,
					columns,
					conditions,
				};
				return {
					ok: true,
					summary: `${columns.join(", ")}${conditions.length ? ` with ${conditions.length} condition${conditions.length === 1 ? "" : "s"}` : ""}`,
					result: "Applied. Explore is showing the table.",
					draft,
				};
			} catch (error) {
				return refusal(error);
			}
		},
	};
}
