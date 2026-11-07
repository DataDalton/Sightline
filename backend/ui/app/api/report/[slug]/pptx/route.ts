import { NextRequest, NextResponse } from "next/server";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { readPageForExport, readsAs } from "@/lib/deliveries/pagePdf";
import { refusedUnless } from "@/lib/platform/capabilityGuard";
import { DeckError, getDeck, recordPrint } from "@/lib/platform/decks";
import { getReport } from "@/lib/platform/reports";
import { buildPresentation, type PptxSlide } from "@/lib/pptx/presentation";
import { slidesForPage } from "@/lib/pptx/reportSlides";
import { measureCanvas, rectToPixels } from "@/lib/visuals/layout";
import { placeSlide } from "@/lib/visuals/deck";
import { caller, privateJson, readJson } from "../../../notifications/guard";

// A report as a PowerPoint file, read as the person asking. Follows the rule every export does,
// with the right checked and the record written before anything is read.

// { scope: "page" | "report" | "deck", pageId, deckId, filters, record }
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const identity = await caller(request);
	if (identity instanceof NextResponse) return identity;
	const { slug } = await params;
	const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;

	try {
		const policy = await resolvePolicyClass(identity);
		const report = await getReport(policy, identity, slug);
		if (!report) return privateJson({ error: "Not found" }, 404);
		const refused = await refusedUnless(
			identity,
			"export.run",
			report.reportId,
		);
		if (refused) return refused;

		const scope = String(body.scope ?? "page");
		const pageId = body.pageId ? String(body.pageId) : null;
		await recordPrint(identity, report, {
			pageId,
			search: `powerpoint ${scope}`,
			kind: "pptx",
		});

		const filters = Array.isArray(body.filters)
			? (body.filters as { field: string; op: string }[])
			: null;
		const slides: PptxSlide[] = [];
		let colors: string[] = [];

		if (scope === "deck") {
			const deck = await getDeck(
				report.reportId,
				String(body.deckId ?? ""),
			);
			if (!deck) return privateJson({ error: "Not found" }, 404);
			const record =
				deck.recordField &&
				typeof body.record === "string" &&
				body.record
					? [
							{
								field: deck.recordField,
								op: "eq",
								value: body.record,
							},
						]
					: null;
			const canvas = measureCanvas(1180);
			for (const step of deck.steps) {
				const placed = placeSlide(step).map(({ visualId, rect }) => ({
					visualId,
					box: rectToPixels(rect, canvas),
				}));
				const home =
					report.pages.find((page) =>
						placed.some(({ visualId }) =>
							page.visuals.some(
								(visual) => visual.visualId === visualId,
							),
						),
					) ??
					report.pages.find((page) => page.pageId === step.pageId) ??
					report.pages[0];
				const everyPage = {
					...home,
					visuals: report.pages.flatMap((page) => page.visuals),
				};
				const read = await readPageForExport(
					readsAs(identity),
					report,
					everyPage,
					{
						placed,
						...(record ? { filters: record } : {}),
					},
				);
				colors = read.colors;
				slides.push(
					...slidesForPage(
						{
							title: step.title || deck.title,
							subtitle: record
								? `${deck.recordField}: ${body.record}`
								: null,
							text: step.text,
							titleOnly: step.layout === "title",
							designed: true,
							textBeside: step.layout === "textAndOne",
							visuals: read.visuals,
						},
						{ accent: read.accent, colors: read.colors },
					),
				);
			}
		} else {
			const pages =
				scope === "report"
					? report.pages
					: report.pages.filter((page) => page.pageId === pageId);
			if (pages.length === 0) {
				return privateJson({ error: "Not found" }, 404);
			}
			for (const page of pages) {
				const read = await readPageForExport(
					readsAs(identity),
					report,
					page,
					{
						// What is on screen belongs to the page on screen.
						filters: page.pageId === pageId ? filters : null,
					},
				);
				colors = read.colors;
				slides.push(
					...slidesForPage(
						{
							title:
								page.title === report.title
									? report.title
									: `${report.title}: ${page.title}`,
							subtitle:
								read.filterWords.length > 0
									? `Filtered to ${read.filterWords.join(", ")}`
									: null,
							visuals: read.visuals,
						},
						{ accent: read.accent, colors: read.colors },
					),
				);
			}
		}

		const bytes = buildPresentation({
			title: report.title,
			author: identity.email,
			slides,
			accents: colors.length > 0 ? colors : ["#2563eb"],
		});
		const name =
			report.title
				.replace(/[^\w\s-]+/g, "")
				.trim()
				.replace(/\s+/g, "-") || "report";
		return new NextResponse(new Uint8Array(bytes), {
			headers: {
				"Content-Type":
					"application/vnd.openxmlformats-officedocument.presentationml.presentation",
				"Content-Disposition": `attachment; filename="${name}.pptx"`,
				"Cache-Control": "private, no-store",
			},
		});
	} catch (error) {
		if (error instanceof DeckError) {
			return privateJson({ error: error.message }, error.status);
		}
		console.error("Could not build a PowerPoint file:", error);
		return privateJson(
			{ error: "This could not be exported to PowerPoint." },
			500,
		);
	}
}
