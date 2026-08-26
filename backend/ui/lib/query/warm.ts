import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { getSource } from "../semantic/registry";
import { isDatabricksApp } from "../runtime";
import { buildCacheKey, cacheGet, isShareable } from "./cache";
import { executeQuery } from "./execute";
import { parseQuerySpec } from "./spec";
import { initialQueryForVisual } from "./visualSpec";
import { openingFilters } from "../visuals/pageDefaults";

// Filling a cache partition before somebody waits on it.
//
// The result cache is keyed by policy class, so an answer computed for one
// reader is the answer for everyone who sees the same rows. That makes warming
// worth more than it first looks: the cost is one query and the benefit is
// every subsequent reader in that class, not just the one who triggered it.
//
// It has to run under a real reader's token. Unity Catalog filters rows for
// whoever asks, and the whole point of the partition is that the answer is the
// one that reader is entitled to. There is no token when nobody is asking, so
// this cannot run on a timer: it runs during a request, using the identity that
// made it, and fills the class that identity belongs to.
//
// What that buys, in order of what a reader notices:
//
//   - The pages of a report they have not opened yet. Reading page one and
//     clicking to page two is the common move, and page two was a cold
//     warehouse query every time.
//   - The visuals of the page they are opening, started while the document is
//     still rendering rather than after the bundle has downloaded and hydrated.

// At most this many warehouse queries in flight from warming, per request.
//
// Warming is speculative and reader-facing traffic is not, so this is set well
// below what the warehouse could take. A report with thirty visuals warms in
// batches rather than opening thirty statements against one session, which is
// also the shape that failed when the reachability probe tried it.
const maxConcurrent = 4;

// The most queries one request will warm. A report with many pages is exactly
// the case worth warming and also the case where warming everything would cost
// more than the reader saves.
const maxQueries = 24;

interface WarmableVisual {
	visualId?: string;
	visualType: string;
	sourceKey: string | null;
	config: {
		dimensions?: string[];
		measures?: string[];
		filters?: unknown[];
		options?: Record<string, unknown>;
	};
}

interface WarmablePage {
	pageId: string;
	sourceKey: string | null;
	visuals: WarmableVisual[];
}

export interface WarmableReport {
	reportId: string;
	sourceKey: string | null;
	pages: WarmablePage[];
}

// The queries a report makes when each of its pages is opened and nothing has
// been touched. Page state is empty on arrival, so a visual's filters are its
// own and nothing else.
function queriesFor(
	report: WarmableReport,
	today: Date,
	// How many pages of the report to walk. Every page for one the reader is
	// opening; the landing page only for one they have not asked for, where
	// warming the whole thing would spend the budget on pages nobody wants.
	pageLimit = Number.MAX_SAFE_INTEGER,
): unknown[] {
	const specs: unknown[] = [];

	for (const page of report.pages.slice(0, pageLimit)) {
		// The same opening state the reader's page will carry, from the same
		// function, so the key this warms is the key they ask for.
		const opening = openingFilters(
			page.visuals.map((v, i) => ({
				visualId: v.visualId ?? `w${i}`,
				visualType: v.visualType,
				config: v.config,
			})),
			today,
		);
		const pageFilters = Object.values(opening).flat();

		for (const visual of page.visuals) {
			const sourceKey =
				visual.sourceKey ?? page.sourceKey ?? report.sourceKey;
			if (!sourceKey) continue;

			const source = getSource(sourceKey);
			if (!source) continue;

			// Only a source whose answers can be shared. For an unshareable one
			// the entry would serve the reader who triggered this and nobody
			// else, and they are about to ask for it themselves anyway.
			if (!isShareable(source)) continue;

			const shape = initialQueryForVisual(
				visual,
				sourceKey,
				source,
				pageFilters,
			);
			if (shape) specs.push(shape);
		}
	}

	return specs;
}

async function runBatch(identity: Identity, specs: unknown[]): Promise<void> {
	let next = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next++;
			if (index >= specs.length) return;
			try {
				await executeQuery(identity, parseQuerySpec(specs[index]));
			} catch {
				// Speculative work. A spec the reader will never ask for, a
				// source they cannot read, a warehouse that is busy: none of
				// them are this request's problem, and the request that does
				// need the answer is the one that should report a failure.
			}
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(maxConcurrent, specs.length) }, worker),
	);
}

// The specs that are not already answered.
//
// Already answered is the common case on a warm replica, and asking the cache
// is far cheaper than asking the warehouse, so the concurrency budget is spent
// on the ones that are actually cold.
async function onlyCold(
	specs: unknown[],
	policy: Awaited<ReturnType<typeof resolvePolicyClass>>,
): Promise<unknown[]> {
	const cold: unknown[] = [];
	for (const spec of specs) {
		if (cold.length >= maxQueries) break;
		try {
			const parsed = parseQuerySpec(spec);
			const source = getSource(parsed.sourceKey);
			if (!source) continue;
			const found = await cacheGet(buildCacheKey(source, parsed, policy));
			if (!found.entry || found.stale) cold.push(spec);
		} catch {
			// A spec that will not parse is one the renderer would not send
			// either. Dropped rather than warmed.
		}
	}
	return cold;
}

// Fills the cache for this reader's partition with what the report will ask
// for. Never awaited by a caller, never throws.
export function warmReport(identity: Identity, report: WarmableReport): void {
	// The same condition executeQuery runs under: a forwarded token in a
	// deployment, or the local credentials in development. Requiring the token
	// unconditionally meant this did nothing outside a deployment, which is
	// also the one place it could not be watched while it was being written.
	if (!identity.userToken && isDatabricksApp) return;

	void (async () => {
		try {
			const policy = await resolvePolicyClass(identity);
			if (policy.degraded) return;

			// Stamped once for the whole walk, so two visuals on one page cannot
			// resolve "the last ninety days" to different days.
			const specs = queriesFor(report, new Date());
			if (specs.length === 0) return;

			const cold = await onlyCold(specs, policy);
			if (cold.length === 0) return;
			await runBatch(identity, cold);
		} catch (error) {
			console.warn("Cache warming failed:", error);
		}
	})();
}

// --- Warming what has not been opened ---------------------------------------

// Warming stopped at the report somebody was already looking at, so the second
// report of the morning was as cold as the first. Everything reachable is too
// much to warm on a whim, so this warms what the reader has actually said they
// want: the reports they marked, then the ones they opened most recently.
//
// Once per policy class rather than once per request. The cache is keyed by
// class, so the first reader in a class pays for everybody in it, and repeating
// the walk for the second reader would spend warehouse time filling entries
// that are already there.
const warmedClasses = new Map<string, number>();

// Long enough that browsing does not retrigger it, short enough that a session
// spanning a morning is warmed more than once. Deliberately longer than the
// result TTL: this decides how often the walk runs, not how long an answer
// lives, and running it more often than the answers expire would mean warming
// the same entries repeatedly for a reader who never opened them.
const classWarmIntervalMs = 10 * 60 * 1000;

// How many unopened reports one walk will touch, and how much of each.
const maxReports = 5;

export interface WarmCandidate {
	reportId: string;
	slug: string;
}

// Fills the partition with the landing page of the reports this reader is most
// likely to open next. Never awaited, never throws.
export function warmForReader(
	identity: Identity,
	candidates: WarmCandidate[],
): void {
	if (!identity.userToken && isDatabricksApp) return;
	if (candidates.length === 0) return;

	void (async () => {
		try {
			const policy = await resolvePolicyClass(identity);
			if (policy.degraded) return;

			const now = Date.now();
			const last = warmedClasses.get(policy.id) ?? 0;
			if (now - last < classWarmIntervalMs) return;
			// Stamped before the work rather than after, so two requests
			// arriving together do not both start the same walk.
			warmedClasses.set(policy.id, now);

			// Imported here rather than at the top: reports.ts reaches the
			// access layer, and warming is called from the shell, which is
			// already inside it.
			const { getReport } = await import("../platform/reports");

			// Appended after the guard, so this query runs at most once per
			// class per interval rather than on every page load.
			const { recentReportTargets } = await import("../platform/search");
			const recent = await recentReportTargets(identity.email).catch(
				() => [],
			);

			// Marked first, then recently opened. A mark is a statement of
			// intent and a visit is only evidence, so the two are not ranked
			// together. Deduplicated, because the report somebody marked is
			// usually also the one they opened last.
			const seen = new Set<string>();
			const ordered = [...candidates, ...recent].filter((c) => {
				if (seen.has(c.reportId)) return false;
				seen.add(c.reportId);
				return true;
			});

			const specs: unknown[] = [];
			const today = new Date();

			for (const candidate of ordered.slice(0, maxReports)) {
				if (specs.length >= maxQueries) break;
				try {
					// Access-checked, so a candidate this reader cannot open
					// contributes nothing rather than warming somebody else's
					// partition by mistake.
					const report = await getReport(
						policy,
						identity,
						candidate.slug,
					);
					if (!report) continue;
					specs.push(
						...queriesFor(report as WarmableReport, today, 1),
					);
				} catch {
					// One unreadable report is not a reason to warm none of
					// the others.
				}
			}

			const cold = await onlyCold(specs.slice(0, maxQueries), policy);
			if (cold.length === 0) return;
			await runBatch(identity, cold);
		} catch (error) {
			console.warn("Reader warming failed:", error);
		}
	})();
}
