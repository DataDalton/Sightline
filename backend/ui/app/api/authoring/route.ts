import { NextRequest, NextResponse } from "next/server";
import { getIdentity, type Identity } from "@/lib/auth/identity";
import { resolvePolicyClass, type PolicyClass } from "@/lib/auth/policy";
import { canDo, getExplicitContext } from "@/lib/platform/access";
import { can } from "@/lib/platform/accessRules";
import {
	addTemplatePage,
	AuthoringError,
	createCategory,
	createReport,
	deactivateCategory,
	removeReport,
	reorderCategories,
	reorderReports,
	updateCategory,
	updateReportPlacement,
	setPageProtection,
	setReportProtection,
} from "@/lib/platform/authoring";
import { assertCanEdit } from "@/lib/platform/editing";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { readableSourceList } from "@/lib/platform/sources";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { sql } from "@/lib/data/lakebase";
import type { BuiltVisual } from "@/lib/visuals/templates";
import { warmReport } from "@/lib/query/warm";

// Making a category, a report or a page.
//
// One route rather than three, because they are one flow: an author picks where
// it goes, what it reads and what shape it starts in. Splitting that across
// endpoints would mean the client asking three times to render one dialog.
//
// Nothing here decides what the caller may read. Sources come back filtered by
// the catalogue exactly as they do for the explore page, so a report cannot be
// created against data its author could not open.

interface CategoryRow {
	category_id: string;
	name: string;
}

async function guard(
	request: NextRequest,
): Promise<
	| { error: NextResponse }
	| { identity: Identity; policy: PolicyClass; error?: undefined }
> {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return {
			error: NextResponse.json(
				{ error: "Not authenticated" },
				{ status: 401 },
			),
		};
	}

	const policy = await resolvePolicyClass(identity);
	if (policy.degraded) {
		// Membership could not be resolved, so what this caller may create is
		// unknown. Refused rather than guessed wide.
		return {
			error: NextResponse.json(
				{
					error: "Your group membership could not be resolved, so this is unavailable.",
				},
				{ status: 403 },
			),
		};
	}

	return { identity, policy };
}

// Fills the cache with what the new page will ask for.
//
// A template's visuals are known the moment it is built, so the queries the
// page makes on arrival are computable now rather than discovered the first
// time somebody opens it. Never awaited: the author is about to be redirected,
// and holding the response for a warehouse round trip would make creating a
// report feel slower than it is.
function warmNewPage(
	identity: Identity,
	reportId: string,
	pageId: string,
	sourceKey: string | null,
	visuals: BuiltVisual[],
): void {
	if (visuals.length === 0) return;

	warmReport(identity, {
		reportId,
		sourceKey,
		pages: [
			{
				pageId,
				sourceKey,
				visuals: visuals.map((v, i) => ({
					visualId: `new-${i}`,
					visualType: v.visualType,
					sourceKey,
					config: {
						dimensions: v.dimensions,
						measures: v.measures,
						options: v.options,
					},
				})),
			},
		],
	});
}

// The sources this caller may build on, and the categories they may build in.
//
// Whether they may create anything at all is answered by the shell, which
// carries the capability names already. This answers where.
export async function GET(request: NextRequest) {
	const checked = await guard(request);
	if (checked.error) return checked.error;
	const { identity, policy } = checked;

	const context = await getExplicitContext(policy, identity.email);

	const rows = await sql<CategoryRow>(
		`SELECT category_id, name FROM categories
		 WHERE is_active = TRUE ORDER BY sort_order, name`,
	);

	// A category is offered only where the caller holds report.create in it.
	// Somebody scoped to one subject area sees that one, not a list they will
	// be refused from.
	const categories = rows
		.filter((row) =>
			can(context.capabilities, "report.create", row.category_id),
		)
		.map((row) => ({ id: row.category_id, name: row.name }));

	const response = NextResponse.json({
		sources: await readableSourceList(identity),
		categories,
	});
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export async function POST(request: NextRequest) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const checked = await guard(request);
	if (checked.error) return checked.error;
	const { identity, policy } = checked;

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
	}

	const action = String(body.action ?? "");
	const refused = NextResponse.json({ error: "Not found" }, { status: 404 });

	const slots =
		body.slots && typeof body.slots === "object"
			? (body.slots as Record<string, string>)
			: {};

	try {
		if (action === "createReport") {
			const categoryId = body.categoryId
				? String(body.categoryId).trim()
				: null;

			// Scoped, so an editor given one subject area cannot create in
			// another. A report with no category is a personal page, which is
			// a different capability and not this one.
			if (!categoryId) {
				return NextResponse.json(
					{ error: "A category is required." },
					{ status: 400 },
				);
			}
			if (!(await canDo(policy, identity, "report.create", categoryId))) {
				return refused;
			}

			const sourceKey = body.sourceKey ? String(body.sourceKey) : null;

			const created = await createReport(identity, {
				title: String(body.title ?? ""),
				categoryId,
				description: body.description
					? String(body.description).slice(0, 500)
					: null,
				sourceKey,
				template: body.template ? String(body.template) : null,
				slots,
				pageTitle: body.pageTitle ? String(body.pageTitle) : undefined,
			});

			warmNewPage(
				identity,
				created.reportId,
				created.pageId,
				sourceKey,
				created.visuals,
			);

			return NextResponse.json({
				reportId: created.reportId,
				slug: created.slug,
				pageId: created.pageId,
			});
		}

		if (action === "addPage") {
			const reportId = String(body.reportId ?? "").trim();
			if (!reportId) {
				return NextResponse.json(
					{ error: "A report is required." },
					{ status: 400 },
				);
			}

			// Scoped to the report's own category, so page.create held in one
			// subject area does not reach a report in another.
			const owning = await sql<{ category_id: string | null }>(
				`SELECT category_id FROM reports
				 WHERE report_id = $1 AND is_active = TRUE`,
				[reportId],
			);
			if (owning.length === 0) return refused;
			if (
				!(await canDo(
					policy,
					identity,
					"page.create",
					owning[0].category_id,
				))
			) {
				return refused;
			}

			const pageSource = body.sourceKey ? String(body.sourceKey) : null;

			const page = await addTemplatePage(identity, {
				reportId,
				title: String(body.title ?? ""),
				sourceKey: pageSource,
				template: body.template ? String(body.template) : null,
				slots,
			});

			warmNewPage(
				identity,
				reportId,
				page.pageId,
				pageSource,
				page.visuals,
			);

			return NextResponse.json({ pageId: page.pageId });
		}

		if (action === "removeReport") {
			const reportId = String(body.reportId ?? "").trim();

			// The same check the edit path makes, so removing a report needs
			// exactly what changing one needs. A personal page's owner holds
			// admin on it through the ownership rule, so this covers both.
			try {
				await assertCanEdit(policy, identity.email, reportId);
			} catch {
				return refused;
			}

			await removeReport(identity, reportId);
			return NextResponse.json({ ok: true });
		}

		if (action === "moveReport") {
			const reportId = String(body.reportId ?? "").trim();

			// Editing the report is the bar for changing its address: the slug
			// is part of the report, and an editor who can rewrite every visual
			// on it can reasonably fix what it is called in a URL.
			try {
				await assertCanEdit(policy, identity.email, reportId);
			} catch {
				return refused;
			}

			// Which category it sits in is a decision about navigation rather
			// than about the report, so that half needs the capability that
			// governs navigation. Checked only when the category is actually
			// changing, so fixing an address does not require it.
			if (body.categoryId !== undefined) {
				const current = await sql<{ category_id: string | null }>(
					`SELECT category_id FROM reports WHERE report_id = $1`,
					[reportId],
				);
				const moving =
					(current[0]?.category_id ?? null) !==
					(String(body.categoryId ?? "") || null);
				if (
					moving &&
					!(await canDo(policy, identity, "category.manage"))
				) {
					return refused;
				}
			}

			const placed = await updateReportPlacement(identity, reportId, {
				categoryId:
					body.categoryId === undefined
						? undefined
						: String(body.categoryId ?? "") || null,
				slug:
					body.slug === undefined
						? undefined
						: String(body.slug ?? ""),
			});
			return NextResponse.json(placed);
		}

		if (action === "protectReport") {
			if (!(await canDo(policy, identity, "page.protect"))) {
				return refused;
			}

			const reportId = String(body.reportId ?? "").trim();
			if (!reportId) {
				return NextResponse.json(
					{ error: "A report is required." },
					{ status: 400 },
				);
			}

			const locked = await setReportProtection(identity.email, reportId, {
				protectDelete: body.protectDelete === true,
				protectEdit: body.protectEdit === true,
				protectAddPage: body.protectAddPage === true,
			});
			return NextResponse.json(locked);
		}

		if (action === "protectPage") {
			// Its own capability, so an editor cannot lift a lock on a page
			// they are otherwise free to rewrite.
			if (!(await canDo(policy, identity, "page.protect"))) {
				return refused;
			}

			const pageId = String(body.pageId ?? "").trim();
			if (!pageId) {
				return NextResponse.json(
					{ error: "A page is required." },
					{ status: 400 },
				);
			}

			const locked = await setPageProtection(identity.email, pageId, {
				protectDelete: body.protectDelete === true,
				protectEdit: body.protectEdit === true,
			});
			return NextResponse.json(locked);
		}

		if (action === "reorderReports") {
			if (!(await canDo(policy, identity, "category.manage"))) {
				return refused;
			}
			const reportIds = Array.isArray(body.reportIds)
				? body.reportIds.map((id) => String(id))
				: [];
			await reorderReports(
				identity,
				String(body.categoryId ?? ""),
				reportIds,
			);
			return NextResponse.json({ ok: true });
		}

		if (action === "createCategory") {
			if (!(await canDo(policy, identity, "category.create"))) {
				return refused;
			}
			const categoryId = await createCategory(identity, {
				categoryId: String(body.categoryId ?? ""),
				name: String(body.name ?? ""),
				description: body.description
					? String(body.description).slice(0, 500)
					: null,
				icon: body.icon ? String(body.icon).slice(0, 40) : null,
			});
			return NextResponse.json({ categoryId });
		}

		if (action === "updateCategory") {
			if (!(await canDo(policy, identity, "category.manage"))) {
				return refused;
			}
			await updateCategory(identity, String(body.categoryId ?? ""), {
				name: body.name === undefined ? undefined : String(body.name),
				description:
					body.description === undefined
						? undefined
						: String(body.description).slice(0, 500),
				icon:
					body.icon === undefined
						? undefined
						: String(body.icon).slice(0, 40),
			});
			return NextResponse.json({ ok: true });
		}

		if (action === "removeCategory") {
			if (!(await canDo(policy, identity, "category.manage"))) {
				return refused;
			}
			await deactivateCategory(identity, String(body.categoryId ?? ""));
			return NextResponse.json({ ok: true });
		}

		if (action === "reorderCategories") {
			if (!(await canDo(policy, identity, "category.manage"))) {
				return refused;
			}
			const ids = Array.isArray(body.categoryIds)
				? (body.categoryIds as unknown[]).map((id) => String(id))
				: [];
			await reorderCategories(identity, ids);
			return NextResponse.json({ ok: true });
		}

		return NextResponse.json(
			{ error: "Unrecognised action." },
			{ status: 400 },
		);
	} catch (error) {
		if (error instanceof AuthoringError) {
			// The message names what to fix: a template whose slots the source
			// cannot fill, a category that still holds reports, a title that is
			// empty.
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Authoring failed:", error);
		return NextResponse.json(
			{ error: "Could not create that." },
			{ status: 500 },
		);
	}
}
