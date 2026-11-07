import type { Identity } from "../auth/identity";
import { getSource } from "../semantic/registry";
import { requiredFields, waitingFor } from "../visuals/filterGate";
import { openingBreakdown, openingFilters } from "../visuals/pageDefaults";
import { timeQueryCold } from "./execute";
import { parseQuerySpec } from "./spec";
import { initialQueryForVisual } from "./visualSpec";

// Times each visual on a page going to the warehouse, as the person asking, so a
// slow one is found before anyone waits on it. A cached answer takes no time and so
// says nothing about what the first reader of the day will sit through.
//
// Works from the definitions the editor holds, so a change not yet saved is timed
// as it stands. Asked for explicitly, since it spends real warehouse time. Each
// answer goes in the cache as an ordinary query's does, so the work is not wasted.

export interface TimedVisualInput {
	visualId: string;
	visualType: string;
	sourceKey?: string | null;
	config: Record<string, unknown> & { options?: Record<string, unknown> };
}

export interface VisualTiming {
	visualId: string;
	// Null with a reason where it was not timed.
	warehouseMs: number | null;
	rowCount: number | null;
	note: string | null;
}

// About what a page opening starts at once, so the timings reflect the pressure a
// real open puts on the warehouse.
const concurrentTimings = 4;

export async function timeVisualsCold(
	identity: Identity,
	input: {
		visuals: TimedVisualInput[];
		pageSourceKey: string | null;
		pageConfig?: { requireFilter?: unknown } | null;
		today: Date;
	},
): Promise<VisualTiming[]> {
	const asInputs = input.visuals.map((visual) => ({
		visualId: visual.visualId,
		visualType: visual.visualType,
		config: visual.config as never,
	}));
	const opening = openingFilters(asInputs, input.today);
	const pageFilters = Object.values(opening).flat();
	const breakdown = openingBreakdown(asInputs);

	const results: VisualTiming[] = [];
	const pending = [...input.visuals];

	const worker = async (): Promise<void> => {
		for (;;) {
			const visual = pending.shift();
			if (!visual) return;
			const done = (fields: Omit<VisualTiming, "visualId">) =>
				results.push({ visualId: visual.visualId, ...fields });

			const sourceKey = visual.sourceKey ?? input.pageSourceKey;
			const source = sourceKey ? getSource(sourceKey) : null;
			if (!sourceKey || !source) continue;

			const required = requiredFields(
				visual.visualType,
				visual.config.options,
				(input.pageConfig ?? undefined) as never,
			);
			if (waitingFor(required, pageFilters).length > 0) {
				done({
					warehouseMs: null,
					rowCount: null,
					note: "Waits for a filter, so it asks nothing as the page opens",
				});
				continue;
			}

			const shape = initialQueryForVisual(
				visual as never,
				sourceKey,
				source,
				pageFilters,
				breakdown,
			);
			// Nothing to ask of the warehouse, as with a filter or a text panel.
			if (!shape) continue;

			try {
				const timing = await timeQueryCold(
					identity,
					parseQuerySpec(shape),
				);
				done({
					warehouseMs: timing.warehouseMs,
					rowCount: timing.rowCount,
					note: null,
				});
			} catch (error) {
				done({
					warehouseMs: null,
					rowCount: null,
					note:
						error instanceof Error
							? error.message
							: "This query failed",
				});
			}
		}
	};

	await Promise.all(
		Array.from({ length: concurrentTimings }, () => worker()),
	);
	return results;
}
