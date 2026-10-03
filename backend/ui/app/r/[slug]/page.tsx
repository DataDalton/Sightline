import { headers } from "next/headers";
import { NextRequest } from "next/server";
import { GET as authoringGet } from "../../api/authoring/route";
import { GET as deliveriesGet } from "../../api/deliveries/route";
import { GET as notesGet } from "../../api/notes/route";
import { GET as pageAlertsGet } from "../../api/page-alerts/route";
import { GET as viewsGet } from "../../api/views/route";
import { settings } from "../../../lib/settings";
import ReportView from "../ReportView";
import { getIdentityFromHeaders } from "../../../lib/auth/identity";
import { resolvePolicyClass } from "../../../lib/auth/policy";
import {
	reportPayload,
	withinSeedBudget,
} from "../../../lib/platform/pageData";
import {
	seedPageQueries,
	warmReport,
	type WarmableReport,
} from "../../../lib/query/warm";

// The report definition, resolved while the document is being rendered.
//
// It is the same call the API route makes, from the same process, against the
// same caches. Doing it here removes a full round trip from the critical path:
// the reader used to wait for the document, then the bundle, then hydration,
// and only then did the browser start asking what was on the page.
//
// It also decides whether the page has anything to draw server-side at all.
// Without it the report renders as an empty div and every visual, placeholder
// included, waits for hydration.
//
// The visuals still fetch their own rows, because those depend on filters the
// client owns. What they no longer wait for is finding out that they exist.
// The opening page's other requests, answered here by the same handlers the
// browser would reach, under the same headers, so the answers carry the same
// access checks and the same shape. Keyed as the client asks for each. One
// that fails or refuses is left out and the client asks for it as before.
async function openingResponses(
	incoming: Headers,
	reportId: string,
	pageId: string | undefined,
): Promise<Record<string, unknown>> {
	const asks: [string, (request: NextRequest) => Promise<Response>][] = [
		["/api/authoring", authoringGet],
		["/api/deliveries", deliveriesGet],
	];
	if (pageId) {
		asks.push(
			[
				`/api/notes?reportId=${encodeURIComponent(reportId)}&pageId=${encodeURIComponent(pageId)}`,
				notesGet,
			],
			[`/api/views?pageId=${encodeURIComponent(pageId)}`, viewsGet],
		);
		if (settings().alertsEnabled)
			asks.push([
				`/api/page-alerts/?pageId=${encodeURIComponent(pageId)}`,
				pageAlertsGet,
			]);
	}
	const answered = await Promise.all(
		asks.map(async ([key, handle]) => {
			try {
				const response = await handle(
					new NextRequest(new URL(key, "http://localhost"), {
						headers: incoming,
					}),
				);
				if (!response.ok) return null;
				return [key, await response.json()] as const;
			} catch {
				return null;
			}
		}),
	);
	return Object.fromEntries(answered.filter((a) => a !== null));
}

async function definitionFor(slug: string) {
	const incoming = await headers();
	const identity = getIdentityFromHeaders(incoming);
	if (!identity) return undefined;

	return withinSeedBudget(async () => {
		const policy = await resolvePolicyClass(identity);
		const payload = await reportPayload(identity, policy, slug);
		// A report this reader cannot open is left to the client, which asks
		// and is refused. Seeding an absence would be indistinguishable from a
		// report that is still loading.
		if (!payload) return undefined;

		// Started here and not waited for. The result cache is keyed by policy
		// class, so this fills the partition rather than one reader's copy: the
		// pages of this report that nobody has opened yet become warm for
		// everybody who sees the same rows, and the first person to click the
		// second tab does not wait on the warehouse for it.
		warmReport(identity, payload.report as WarmableReport);

		// What the opening page already has an answer for.
		//
		// The definition above stops a reader waiting to find out what is on
		// the page. This stops them waiting to find out what it says: a visual
		// whose answer is already cached is handed it with the document rather
		// than issuing a request once the bundle has hydrated.
		//
		// Cached answers only, so this cannot make the document slower than the
		// budget it already runs under.
		const report = payload.report as WarmableReport;
		const [seeded, responses] = await Promise.all([
			seedPageQueries(identity, report, null),
			openingResponses(
				new Headers(incoming),
				report.reportId,
				report.pages[0]?.pageId,
			),
		]);

		return { ...payload, seeded, responses };
	}, undefined);
}

export default async function ReportPage({
	params,
}: {
	params: Promise<{ slug: string }>;
}) {
	const { slug } = await params;
	const initial = await definitionFor(slug);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return <ReportView slug={slug} initial={initial as any} />;
}
