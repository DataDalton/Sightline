import { headers } from "next/headers";
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
async function definitionFor(slug: string) {
	const identity = getIdentityFromHeaders(await headers());
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
		const seeded = await seedPageQueries(
			identity,
			payload.report as WarmableReport,
			null,
		);

		return { ...payload, seeded };
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
