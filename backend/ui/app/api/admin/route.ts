import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { canAdminister } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	activityRecordTypes,
	getActivityLog,
	getDailyActivity,
	getExportAudit,
	getReportUsage,
	getReportViewers,
	getSlowSources,
	getUsageSummary,
	getUserActivity,
	getUserUsage,
} from "@/lib/platform/adminStats";
import { cachedDefinition } from "@/lib/platform/definitionCache";
import {
	getGroupProbes,
	getTrackedGroupDetail,
	policyCacheStats,
} from "@/lib/auth/policy";
import {
	explainReportAccess,
	explainSubjectAccess,
} from "@/lib/platform/accessReview";
import { cacheStats } from "@/lib/query/cache";
import { telemetryStats } from "@/lib/telemetry/usage";
import { userSessionStats } from "@/lib/data/userSession";
import { listSources, registryLoadedAt } from "@/lib/semantic/registry";
import { lastDiscovery } from "@/lib/semantic/filterDiscovery";
import {
	effectiveAdminGroups,
	settings,
	settingsLoadedAt,
} from "@/lib/settings";
import {
	instanceId,
	instanceStartedAt,
	isDatabricksApp,
	lakebase,
} from "@/lib/runtime";
import { latestSyncRun } from "@/lib/semantic/syncRun";

// Admin data, gated on group membership rather than on a per-resource grant.
// Everything here describes other people's activity, so it is not something a
// per-report permission should ever unlock.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const policy = await resolvePolicyClass(identity);
	if (!(await canAdminister(policy, identity))) {
		// Reported as missing rather than forbidden, so the response does not
		// advertise an admin surface to someone without it.
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	const days = Math.min(
		Math.max(Number(request.nextUrl.searchParams.get("days") ?? 7), 1),
		90,
	);
	const section = request.nextUrl.searchParams.get("section") ?? "overview";

	try {
		// Drill-ins. Both take the subject from the query string, so a row in
		// the overview can be opened without another page.
		if (section === "report") {
			const reportId = request.nextUrl.searchParams.get("reportId") ?? "";
			if (!/^[0-9a-f-]{36}$/i.test(reportId)) {
				return NextResponse.json(
					{ error: "Unknown report" },
					{ status: 400 },
				);
			}
			return NextResponse.json({
				viewers: await getReportViewers(reportId, days),
			});
		}

		if (section === "user") {
			const userEmail = (
				request.nextUrl.searchParams.get("userEmail") ?? ""
			).trim();
			if (!userEmail) {
				return NextResponse.json(
					{ error: "Unknown user" },
					{ status: 400 },
				);
			}
			return NextResponse.json({
				activity: await getUserActivity(userEmail, days),
			});
		}

		if (section === "activity") {
			const params = request.nextUrl.searchParams;
			const [log, types] = await Promise.all([
				getActivityLog({
					recordType: params.get("recordType"),
					actor: params.get("actor"),
					days,
					limit: Number(params.get("limit")) || 100,
					offset: Number(params.get("offset")) || 0,
				}),
				activityRecordTypes(days),
			]);
			// Never cached. This is the record somebody consults to find out
			// what just happened, and an answer a minute old is the wrong one.
			const response = NextResponse.json({ ...log, types, days });
			response.headers.set("Cache-Control", "private, no-store");
			return response;
		}

		if (section === "source") {
			const sourceKey = request.nextUrl.searchParams.get("sourceKey");
			const source = listSources().find((s) => s.sourceKey === sourceKey);
			if (!source) {
				return NextResponse.json(
					{ error: "That source is not registered." },
					{ status: 404 },
				);
			}
			const field = (f: {
				name: string;
				displayName?: string | null;
				dataType?: string | null;
				description?: string | null;
				formatHint?: string | null;
			}) => ({
				name: f.name,
				displayName: f.displayName ?? null,
				dataType: f.dataType ?? null,
				description: f.description ?? null,
				formatHint: f.formatHint ?? null,
			});
			return NextResponse.json({
				source: {
					sourceKey: source.sourceKey,
					title: source.title,
					description: source.description ?? null,
					kind: source.kind,
					defaultTimeField: source.defaultTimeField ?? null,
					cacheTtlSeconds: source.cacheTtlSeconds ?? 0,
					dimensions: source.dimensions.map(field),
					measures: source.measures.map(field),
				},
			});
		}

		if (section === "probes") {
			// Just the probe record. Reading this off the subject lookup meant
			// running two access queries to answer a question about neither.
			return NextResponse.json({ probes: getGroupProbes() });
		}

		if (section === "reportAccess") {
			const reportId = request.nextUrl.searchParams.get("reportId");
			if (!reportId) {
				return NextResponse.json(
					{ error: "A report is required." },
					{ status: 400 },
				);
			}
			return NextResponse.json({
				report: await explainReportAccess(reportId),
			});
		}

		if (section === "subjectAccess") {
			const subject = request.nextUrl.searchParams.get("subject");
			if (!subject) {
				return NextResponse.json(
					{ error: "An email is required." },
					{ status: 400 },
				);
			}
			return NextResponse.json({
				subject: await explainSubjectAccess(subject),
				probes: getGroupProbes(),
			});
		}

		if (section === "security") {
			const current = settings();
			return NextResponse.json({
				editorGroups: current.editorGroups,
				adminGroups: effectiveAdminGroups(),
				exports: await cachedDefinition("admin-exports", () =>
					getExportAudit(100),
				),
				// What is actually being probed, which is not the same as the
				// stored setting: most of these are discovered from the row
				// filters on each source rather than configured, so showing the
				// setting alone would show an empty list while ten groups were
				// in use. The origin says which, so a group the platform found
				// is distinguishable from one somebody named.
				policyGroups: getTrackedGroupDetail(),
				filterDiscovery: (() => {
					const { groups, at } = lastDiscovery();
					return {
						at: at || null,
						unreadableSources: groups?.unreadableSources ?? [],
						failureReason: groups?.failureReason ?? null,
					};
				})(),
				// Only the count is needed here: the verdict is about how many
				// sources carry a filter, and the sources themselves are listed
				// under Platform.
				filteredSources: listSources().filter((s) => s.hasRowFilter)
					.length,
			});
		}

		if (section === "platform") {
			const current = settings();
			return NextResponse.json({
				runtime: {
					hosted: isDatabricksApp,
					// Connection targets only. No credential is ever returned.
					lakebaseHost: lakebase.host,
					lakebaseDatabase: lakebase.database,
					lakebaseSchema: lakebase.schema,
					lakebaseInstance: lakebase.instanceName,
				},
				replica: {
					// Names the process that answered, so two refreshes
					// reporting two ids explains why the counters moved.
					instanceId,
					startedAt: instanceStartedAt,
					policyCache: policyCacheStats(),
					resultCache: cacheStats(),
					telemetry: telemetryStats(),
					warehouseSessions: userSessionStats(),
					settingsLoadedAt: settingsLoadedAt() || null,
					registryLoadedAt: registryLoadedAt() || null,
				},
				settings: current,
				// The last catalogue walk, so a source list nobody has synced
				// since March does not read as current.
				lastSync: await latestSyncRun().catch(() => null),
				sources: listSources().map((s) => ({
					sourceKey: s.sourceKey,
					title: s.title,
					kind: s.kind,
					object: `${s.catalog}.${s.schema}.${s.object}`,
					hasRowFilter: s.hasRowFilter,
					cacheTtlSeconds: s.cacheTtlSeconds ?? 0,
					dimensions: s.dimensions.length,
					measures: s.measures.length,
				})),
			});
		}

		// Five aggregates over the whole usage log, and the same numbers for
		// every administrator looking at the same window. Shared briefly rather
		// than recomputed per load: these describe a rolling period, so an
		// answer a few seconds old is the same answer.
		const [summary, reports, users, slow, daily] = await cachedDefinition(
			`admin-usage:${days}`,
			async () =>
				await Promise.all([
					getUsageSummary(days),
					getReportUsage(days),
					getUserUsage(days),
					getSlowSources(days),
					getDailyActivity(Math.max(days, 30)),
				]),
		);

		const response = NextResponse.json({
			days,
			summary,
			reports,
			users,
			slow,
			daily,
		});
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Admin data failed:", error);
		return NextResponse.json({ error: "Internal error" }, { status: 500 });
	}
}
