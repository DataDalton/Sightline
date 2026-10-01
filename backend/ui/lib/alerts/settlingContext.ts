import { figureDigest } from "../briefing/keys";
import { readFigureObservations } from "../briefing/observations";
import { loadEvidence } from "../freshness/loads";
import { isAdditiveMeasure } from "../semantic/aggregation";
import type { SemanticSource } from "../semantic/types";
import { learnSettling } from "./completeness";
import type { AlertDefinition } from "./rule";
import type { UnusualContext } from "./runner";

// What an unusual alert needs besides its own rows to tell data still loading
// from a figure that is really off, read from the platform store only.
//
// How complete a young period usually is comes from what the home page cards
// learned about the same figure. Only for a dataset that shows everybody the
// same rows, whose readings are held for everyone, and only for an alert on
// the whole figure, since a part of it or a filtered slice may fill in on a
// schedule of its own. Anything else goes without, and the other signals
// decide.
export async function unusualContext(
	source: SemanticSource,
	definition: AlertDefinition,
): Promise<UnusualContext> {
	const timeField = definition.anomaly?.timeField ?? null;
	const whole =
		!source.hasRowFilter &&
		!definition.groupBy &&
		definition.conditions.length === 0 &&
		timeField !== null;
	const [loads, observations] = await Promise.all([
		loadEvidence([source.sourceKey]),
		whole
			? readFigureObservations(
					"unfiltered",
					figureDigest(
						source.sourceKey,
						definition.measure,
						timeField as string,
					),
					source.sourceKey,
				)
			: Promise.resolve([]),
	]);
	return {
		load: loads.get(source.sourceKey) ?? null,
		learned: learnSettling(observations),
		additive: isAdditiveMeasure(
			source.measures.find((m) => m.name === definition.measure),
		),
	};
}
