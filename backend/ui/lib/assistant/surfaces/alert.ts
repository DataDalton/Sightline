import {
	alertConditions,
	AlertDefinitionError,
	cleanDefinition,
	describeRule,
	type AlertCondition,
} from "../../alerts/rule";
import { frequencies } from "../../alerts/schedule";
import type { SemanticSource } from "../../semantic/types";
import {
	asRecord,
	conditionSchema,
	describeState,
	readConditions,
	refusal,
	requireField,
	sourceFor,
	text,
	type Surface,
} from "./shared";

// Filling in the alert dialog from a sentence.
//
// The model writes the whole alert in one call. It is checked with the rule
// the save uses, and every field it names is checked against the dataset, so
// what lands in the dialog is an alert the dialog could have been filled in
// with by hand. The dialog's own preview then reads the current value, and the
// person saves it or changes it.

export interface AlertDraft {
	name: string;
	sourceKey: string;
	measure: string;
	groupBy: string | null;
	conditions: ReturnType<typeof readConditions>;
	condition: AlertCondition;
	threshold: number | null;
	schedule: { frequency: string; hour: number; weekday: number };
	notifyRecover: boolean;
}

const tool = {
	type: "function" as const,
	function: {
		name: "set_alert",
		description:
			"Fill in the alert dialog. Replaces everything in it. The person reviews it and saves it themselves.",
		parameters: {
			type: "object",
			properties: {
				sourceKey: { type: "string" },
				measure: {
					type: "string",
					description: "The measure to watch, exactly as listed.",
				},
				groupBy: {
					type: "string",
					description:
						"A dimension to check each value of on its own. Leave out to watch the one total.",
				},
				conditions: {
					type: "array",
					items: conditionSchema,
					description: "Row conditions narrowing what is measured.",
				},
				condition: { type: "string", enum: alertConditions },
				threshold: {
					type: "number",
					description:
						"For above and below, a value in the measure's own units. For rises_by, falls_by and changes_by, a percentage of the previous check, so 10 means 10%. Leave out for changes.",
				},
				frequency: { type: "string", enum: frequencies },
				hour: {
					type: "integer",
					description:
						"Hour of the day from 0 to 23, in the person's time zone. Ignored when hourly.",
				},
				weekday: {
					type: "integer",
					description:
						"0 for Sunday to 6 for Saturday. Only used when weekly.",
				},
				notifyRecover: {
					type: "boolean",
					description:
						"For above and below, also tell them when it is back.",
				},
				name: {
					type: "string",
					description:
						"A short name. Leave out to name it after the rule.",
				},
			},
			required: ["sourceKey", "measure", "condition"],
		},
	},
};

export function alertSurface(
	state: unknown,
	available: SemanticSource[],
): Surface {
	const current = asRecord(asRecord(state).definition);
	const preferred = text(current.sourceKey, 200) || null;

	return {
		kind: "alert",
		preferredSourceKey: preferred,
		tools: [tool],
		instructions: [
			"The person is setting up an alert in a dialog and wants you to fill it in from what they describe.",
			`What the dialog holds now: ${describeState(current)}`,
			"- Read the dataset with describe_source before choosing fields. Keep the dataset already chosen unless they name another.",
			"- An alert watches one measure, as one total or for each value of one dimension given as groupBy. Conditions narrow the rows first.",
			"- above and below compare with a value in the measure's own units. rises_by, falls_by and changes_by compare with the previous check as a percentage. changes fires on any change.",
			"- A percentage measure holds percentage points from 0 to 100, so five percent is 5, never 0.05.",
			"- If they want above or below and gave no value, run one query for the current value, choose a round threshold near it, and say which you chose.",
			"- Unless they say otherwise, check daily at 8.",
			"- Call set_alert once with the whole alert. If it is refused, read the reason, correct it and call it again.",
			"- Then reply with one short sentence saying what the alert watches and when it is checked. The dialog shows the rest, and they save it themselves.",
		].join("\n"),
		label: () => "Filling in the alert",
		run: (_name, args) => {
			try {
				const source = sourceFor(available, args.sourceKey);
				const measure = requireField(
					source,
					text(args.measure, 200),
					"measure",
				);
				const groupByName = text(args.groupBy, 200);
				const groupBy = groupByName
					? requireField(source, groupByName, "dimension")
					: null;
				const conditions = readConditions(args.conditions, source);

				const definition = cleanDefinition({
					name: text(args.name, 120),
					sourceKey: source.sourceKey,
					measure,
					groupBy,
					conditions,
					condition: args.condition,
					threshold: args.threshold ?? null,
					schedule: {
						frequency: args.frequency,
						hour: args.hour,
						weekday: args.weekday,
					},
					notifyRecover: args.notifyRecover === true,
				});

				const draft: AlertDraft = {
					// Left blank when the model gave none, so the dialog names
					// it after the rule and keeps doing so as it is changed.
					name: text(args.name, 120),
					sourceKey: definition.sourceKey,
					measure: definition.measure,
					groupBy: definition.groupBy,
					conditions: definition.conditions,
					condition: definition.condition,
					threshold: definition.threshold,
					schedule: {
						frequency: definition.schedule.frequency,
						hour: definition.schedule.hour,
						weekday: definition.schedule.weekday,
					},
					notifyRecover:
						(definition.condition === "above" ||
							definition.condition === "below") &&
						definition.notifyRecover,
				};

				const rule = describeRule({
					measure: definition.measure,
					groupBy: definition.groupBy,
					condition: definition.condition,
					threshold: definition.threshold,
					format: (v) => (v === null ? "" : String(v)),
				});
				return {
					ok: true,
					summary: rule,
					result: `The dialog now holds: ${rule}, checked ${definition.schedule.frequency}. It shows the current value to the person.`,
					draft,
				};
			} catch (error) {
				return refusal(
					error instanceof AlertDefinitionError
						? new Error(error.message)
						: error,
				);
			}
		},
	};
}
