import {
	alertConditions,
	AlertDefinitionError,
	cleanDefinition,
	describeRule,
	type AlertCondition,
} from "../../alerts/rule";
import type { AnomalySettings } from "../../alerts/anomaly";
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
	anomaly: AnomalySettings | null;
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
				anomaly: {
					type: "object",
					description:
						"For unusual only: how usual is worked out from the measure's own history.",
					properties: {
						timeField: {
							type: "string",
							description:
								"A date dimension to read the history across. Defaults to the dataset's time field.",
						},
						compareTo: {
							type: "string",
							enum: ["same_weekday", "recent"],
							description:
								"same_weekday compares a day with the same weekday in recent weeks, which suits daily data with a weekly rhythm. recent compares with the periods just before.",
						},
						periods: {
							type: "integer",
							description:
								"How many earlier periods make up usual, 3 to 26.",
						},
						sensitivity: {
							type: "string",
							enum: ["low", "medium", "high", "percent"],
							description:
								"low reports only big swings, medium clear ones, high small ones too. percent uses the percent given.",
						},
						percent: {
							type: "number",
							description:
								"With sensitivity percent, how far from usual counts, such as 20.",
						},
						direction: {
							type: "string",
							enum: ["either", "up", "down"],
						},
						minimum: {
							type: "number",
							description:
								"Ignore groups whose usual figure is below this.",
						},
						earlySignals: {
							type: "boolean",
							description:
								"Also alert on an early signal, a figure far below where it usually is by now in a period whose data may still be loading. Off unless asked for.",
						},
					},
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
			"- unusual needs no threshold. Usual is worked out from the measure's own history across a date field, and each finished period is compared with it. Use it when they ask to hear about anything odd, unexpected, a spike or a drop, or give no number. For daily data compare the same weekday over the last 8 weeks unless they say otherwise.",
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

				// An unusual alert reads its history across a date field,
				// the dataset's own unless the model named another.
				let anomaly: Record<string, unknown> | undefined;
				if (args.condition === "unusual") {
					anomaly = {
						...asRecord(args.anomaly),
					};
					const named = text(anomaly.timeField, 200);
					anomaly.timeField = requireField(
						source,
						named || source.defaultTimeField || "",
						"dimension",
					);
				}

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
					anomaly,
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
					anomaly: definition.anomaly,
				};

				const rule = describeRule({
					measure: definition.measure,
					groupBy: definition.groupBy,
					condition: definition.condition,
					threshold: definition.threshold,
					format: (v) => (v === null ? "" : String(v)),
					anomaly: definition.anomaly,
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
