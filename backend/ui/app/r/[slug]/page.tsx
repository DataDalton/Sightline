import { headers } from "next/headers";
import { answeredHere, type Ask } from "../../answeredHere";
import { GET as authoringGet } from "../../api/authoring/route";
import { GET as deliveriesGet } from "../../api/deliveries/route";
import { GET as notesGet } from "../../api/notes/route";
import { GET as pageAlertsGet } from "../../api/page-alerts/route";
import { GET as lateGet } from "../../api/query/late/route";
import { GET as viewsGet } from "../../api/views/route";
import { settings } from "../../../lib/settings";
import type { Identity } from "../../../lib/auth/identity";
import { liveTtlSeconds } from "../../../lib/query/cache";
import { heldFieldRange } from "../../../lib/query/range";
import { lateKey, postKey } from "../../../lib/query/requestKey";
import { getSource } from "../../../lib/semantic/registry";
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
// The opening page's other requests. See app/answeredHere.
async function openingResponses(
	incoming: Headers,
	reportId: string,
	pageId: string | undefined,
	sourceKeys: string[],
): Promise<Record<string, unknown>> {
	const asks: Ask[] = [
		{ key: "/api/authoring", handler: authoringGet },
		{ key: "/api/deliveries", handler: deliveriesGet },
	];
	const late = lateKey(sourceKeys);
	if (late) asks.push({ key: late, handler: lateGet });
	if (pageId) {
		asks.push(
			{
				key: `/api/notes?reportId=${encodeURIComponent(reportId)}&pageId=${encodeURIComponent(pageId)}`,
				handler: notesGet,
			},
			{
				key: `/api/views?pageId=${encodeURIComponent(pageId)}`,
				handler: viewsGet,
			},
		);
		if (settings().alertsEnabled)
			asks.push({
				key: `/api/page-alerts/?pageId=${encodeURIComponent(pageId)}`,
				handler: pageAlertsGet,
			});
	}
	return answeredHere(incoming, asks);
}

// The opening page's "data through" stamp, when the newest value it shows is
// already held. Never asked of the warehouse here, so it cannot hold the
// document up. Worked out from the page as ReportView works it out, and keyed
// as DataFreshness asks for it.
async function openingFreshness(
	identity: Identity,
	report: OpeningReport,
): Promise<Record<string, unknown>> {
	const page = report.pages[0];
	const sourceKey =
		page?.sourceKey ??
		report.sourceKey ??
		page?.visuals.find((v) => v.sourceKey)?.sourceKey ??
		null;
	if (!sourceKey) return {};
	const field =
		page?.config?.freshness?.field ??
		getSource(sourceKey)?.defaultTimeField ??
		null;
	if (!field) return {};
	try {
		const range = await heldFieldRange(identity, sourceKey, field, "max");
		if (!range) return {};
		const live = getSource(sourceKey)?.isLive === true;
		return {
			[postKey("/api/query/freshness", { sourceKey, field })]: {
				field,
				value: range.max,
				dataType: range.dataType,
				refreshAfterMs: live ? liveTtlSeconds() * 1000 : null,
			},
		};
	} catch {
		return {};
	}
}

// What the opening page is read from, as the late notice and the freshness
// stamp read it.
interface OpeningReport {
	reportId: string;
	sourceKey: string | null;
	pages: {
		pageId: string;
		sourceKey: string | null;
		config?: { freshness?: { field?: string | null } | null } | null;
		visuals: { sourceKey: string | null }[];
	}[];
}

function openingSources(report: OpeningReport): string[] {
	const page = report.pages[0];
	return [
		page?.sourceKey,
		report.sourceKey,
		...(page?.visuals ?? []).map((v) => v.sourceKey),
	].filter((key): key is string => Boolean(key));
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
		const opening = payload.report as unknown as OpeningReport;
		const [seeded, responses, freshness] = await Promise.all([
			seedPageQueries(identity, report, null),
			openingResponses(
				new Headers(incoming),
				report.reportId,
				report.pages[0]?.pageId,
				openingSources(opening),
			),
			openingFreshness(identity, opening),
		]);

		return {
			...payload,
			seeded,
			responses: { ...responses, ...freshness },
		};
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
