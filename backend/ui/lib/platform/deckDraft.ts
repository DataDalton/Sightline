import { converse } from "../assistant/endpoint";
import { isPageControl } from "../visuals/catalog";
import { parseDraft, type DeckStep, type DraftReport } from "../visuals/deck";

// A first draft of a walkthrough, written by the assistant from what the report holds.
//
// It is told the pages, the visuals and what each measures, and never any data, so it
// explains what the report is for rather than what today's numbers say. It answers as
// the person asking, and what comes back is checked against the visuals that exist.

export async function draftWalkthrough(
	userToken: string | null,
	report: DraftReport,
): Promise<DeckStep[]> {
	const outline = report.pages.map((page) => ({
		page: page.title,
		visuals: page.visuals
			.filter((visual) => !isPageControl(visual.visualType))
			.map((visual) => {
				const config = visual.config as {
					dimensions?: unknown;
					measures?: unknown;
				};
				return {
					visualId: visual.visualId,
					title: visual.title,
					type: visual.visualType,
					dimensions: config?.dimensions,
					measures: config?.measures,
				};
			}),
	}));

	const turn = await converse(
		userToken,
		[
			{
				role: "system",
				content:
					"You write short guided tours of a report for people opening it for the first time. Explain what each visual is for and how to read it. You are not given any data, so never state a figure or a trend. Answer with only a JSON array of steps, in the order a new reader should see them, at most eight. Each step is an object with visualId, copied exactly, title of a few words, and text of one or two plain sentences.",
			},
			{
				role: "user",
				content: JSON.stringify({
					report: report.title,
					description: report.description,
					pages: outline,
				}),
			},
		],
		[],
		{},
		2000,
	);
	return parseDraft(turn.content ?? "", report, () => crypto.randomUUID());
}
