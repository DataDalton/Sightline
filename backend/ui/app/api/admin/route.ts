import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { isAdmin } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	getDailyActivity,
	getExportAudit,
	getReportUsage,
	getReportViewers,
	getSlowSources,
	getUsageSummary,
	getUserActivity,
	getUserUsage,
} from "@/lib/platform/adminStats";
import { getTrackedGroupDetail, policyCacheStats } from "@/lib/auth/policy";
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
import { isDatabricksApp, lakebase } from "@/lib/runtime";

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
	if (!isAdmin(policy)) {
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

		if (section === "security") {
			const current = settings();
			return NextResponse.json({
				editorGroups: current.editorGroups,
				adminGroups: effectiveAdminGroups(),
				exports: await getExportAudit(100),
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
					policyCache: policyCacheStats(),
					resultCache: cacheStats(),
					telemetry: telemetryStats(),
					warehouseSessions: userSessionStats(),
					settingsLoadedAt: settingsLoadedAt() || null,
					registryLoadedAt: registryLoadedAt() || null,
				},
				settings: current,
				sources: listSources().map((s) => ({
					sourceKey: s.sourceKey,
					title: s.title,
					kind: s.kind,
					object: `${s.catalog}.${s.schema}.${s.object}`,
					hasRowFilter: s.hasRowFilter,
					dimensions: s.dimensions.length,
					measures: s.measures.length,
				})),
			});
		}

		const [summary, reports, users, slow, daily] = await Promise.all([
			getUsageSummary(days),
			getReportUsage(days),
			getUserUsage(days),
			getSlowSources(days),
			getDailyActivity(Math.max(days, 30)),
		]);

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
