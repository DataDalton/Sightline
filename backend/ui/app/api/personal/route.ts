import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { canDo } from "@/lib/platform/access";
import { AuthoringError } from "@/lib/platform/authoring";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	allPersonalPages,
	copyAsPersonalPage,
	createPersonalPage,
	deletePersonalPage,
	listPersonalPages,
	listShares,
	publishPage,
	sharePage,
	unsharePage,
} from "@/lib/platform/personal";
import { readableSourceList } from "@/lib/platform/sources";
import { getReport, listReports } from "@/lib/platform/reports";
import { sql } from "@/lib/data/lakebase";
import { checkWriteRateLimit } from "@/lib/rateLimit";

// Pages somebody built for themselves, and the people they named on them.
//
// Read on its own rather than folded into the shell payload. Most readers have
// none, and putting two per-user queries in front of every page render would
// spend everybody's first paint on a section that is usually empty.

export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	try {
		const policy = await resolvePolicyClass(identity);

		// An administrator asking what exists is asking about the installation
		// rather than about themselves. They can reach any of these anyway, and
		// being able to open a page you cannot list is not the same as being
		// able to answer for what the platform holds.
		if (request.nextUrl.searchParams.get("scope") === "all") {
			if (!(await canDo(policy, identity, "access.grant"))) {
				return NextResponse.json(
					{ error: "Not found" },
					{ status: 404 },
				);
			}
			const response = NextResponse.json({
				pages: await allPersonalPages(),
			});
			response.headers.set("Cache-Control", "private, no-store");
			return response;
		}

		// Reports this caller could copy into a page of their own.
		if (request.nextUrl.searchParams.get("scope") === "copyable") {
			const reports = await listReports(policy, identity);
			const categories = await sql<{
				category_id: string;
				name: string;
			}>(
				`SELECT category_id, name FROM categories WHERE is_active = TRUE`,
			);
			const named = new Map(
				categories.map((c) => [c.category_id, c.name]),
			);

			const response = NextResponse.json({
				reports: reports.map((r) => ({
					slug: r.slug,
					title: r.title,
					categoryName: r.categoryId
						? (named.get(r.categoryId) ?? null)
						: null,
				})),
			});
			response.headers.set("Cache-Control", "private, no-store");
			return response;
		}

		const listing = await listPersonalPages(identity, policy);

		const response = NextResponse.json(listing);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	} catch (error) {
		console.error("Personal page listing failed:", error);
		// Empty rather than an error: a sidebar section that cannot load should
		// be absent, not a red box above the reports somebody came for.
		return NextResponse.json({ mine: [], sharedWithMe: [] });
	}
}

export async function POST(request: NextRequest) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
	}

	const action = String(body.action ?? "");
	const reportId = String(body.reportId ?? "").trim();

	// Resolved once. An administrator can act on any personal page, having been
	// able to open and edit one since the ownership rule made room for them; a
	// set of actions that stopped short of removing one would leave them able
	// to read somebody's page but not to act on what they found.
	const policy = await resolvePolicyClass(identity);
	const asAdministrator = await canDo(policy, identity, "access.grant");

	try {
		if (action === "create") {
			const sourceKey = body.sourceKey ? String(body.sourceKey) : null;

			// A page of your own needs no capability, only the right to read
			// what it is built on. That is the bar the explore page already
			// sets: somebody who can ask a question of a dataset can keep the
			// answer.
			if (sourceKey) {
				const allowed = await readableSourceList(identity);
				if (!allowed.some((s) => s.sourceKey === sourceKey)) {
					return NextResponse.json(
						{ error: "Not found" },
						{ status: 404 },
					);
				}
			}

			return NextResponse.json(
				await createPersonalPage(identity, {
					title: String(body.title ?? ""),
					sourceKey,
					template: body.template ? String(body.template) : null,
					slots:
						body.slots && typeof body.slots === "object"
							? (body.slots as Record<string, string>)
							: {},
					visuals: Array.isArray(body.visuals)
						? (body.visuals as never[])
						: undefined,
				}),
			);
		}

		if (action === "copy") {
			// Resolved through the ordinary read path, so a report the caller
			// cannot open cannot be copied out of.
			const original = await getReport(
				policy,
				identity,
				String(body.slug ?? ""),
			);
			if (!original) {
				return NextResponse.json(
					{ error: "Not found" },
					{ status: 404 },
				);
			}

			return NextResponse.json(
				await copyAsPersonalPage(
					identity,
					original.reportId,
					String(body.title ?? `${original.title} (mine)`),
				),
			);
		}

		if (action === "shares") {
			return NextResponse.json({
				shares: await listShares(identity, reportId, asAdministrator),
			});
		}

		if (action === "share") {
			await sharePage(
				identity,
				reportId,
				String(body.email ?? ""),
				asAdministrator,
			);
			return NextResponse.json({
				shares: await listShares(identity, reportId, asAdministrator),
			});
		}

		if (action === "unshare") {
			await unsharePage(
				identity,
				reportId,
				String(body.email ?? ""),
				asAdministrator,
			);
			return NextResponse.json({
				shares: await listShares(identity, reportId, asAdministrator),
			});
		}

		if (action === "remove") {
			await deletePersonalPage(identity, reportId, asAdministrator);
			return NextResponse.json({ ok: true });
		}

		if (action === "publish") {
			const categoryId = String(body.categoryId ?? "").trim();

			// Scoped, so publishing into a subject area is held per area rather
			// than everywhere at once.
			if (
				!(await canDo(policy, identity, "report.publish", categoryId))
			) {
				return NextResponse.json(
					{ error: "Not found" },
					{ status: 404 },
				);
			}

			return NextResponse.json(
				await publishPage(identity, reportId, categoryId),
			);
		}

		return NextResponse.json(
			{ error: "Unrecognised action." },
			{ status: 400 },
		);
	} catch (error) {
		if (error instanceof AuthoringError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Personal page action failed:", error);
		return NextResponse.json(
			{ error: "Could not apply that change." },
			{ status: 500 },
		);
	}
}
