import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { getAccessContext } from "@/lib/platform/access";
import { resolveReportAccess } from "@/lib/platform/accessRules";
import {
	addNote,
	listPageNotes,
	maxNoteLength,
	noteReport,
	removeNote,
} from "@/lib/platform/notes";
import { sql } from "@/lib/data/lakebase";

// Commentary on a visual.
//
// Read by anyone who can open the report, written by anyone who can open it,
// and removed by whoever wrote it or by somebody who can edit the report. That
// last part is deliberate: a note is context rather than a change to the
// report, so requiring edit rights to leave one would mean the people who know
// why a figure moved are the ones who cannot say so.

// Whether this caller may open the report at all, and whether they may edit it.
// Both come out of one resolution, since every route here needs the first and
// the delete needs the second.
async function reach(
	request: NextRequest,
	reportId: string,
): Promise<
	| { ok: true; email: string; canEdit: boolean }
	| { ok: false; response: NextResponse }
> {
	const identity = getIdentity(request);
	if (!identity) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "Not authenticated" },
				{ status: 401 },
			),
		};
	}

	const policy = await resolvePolicyClass(identity);
	const context = await getAccessContext(policy, identity);

	const rows = await sql<{
		category_id: string | null;
		is_personal: boolean;
		owner_email: string | null;
	}>(
		`SELECT category_id, is_personal, owner_email
		 FROM reports
		 WHERE report_id = $1 AND is_active = TRUE`,
		[reportId],
	);
	const report = rows[0];

	// The same answer for a report that is not there and one this caller may
	// not open, so asking is not a way to learn a report exists.
	const missing = NextResponse.json({ error: "Not found" }, { status: 404 });
	if (!report) return { ok: false, response: missing };

	const subject = {
		reportId,
		categoryId: report.category_id,
		isPersonal: report.is_personal,
		ownerEmail: report.owner_email,
	};

	const view = resolveReportAccess(
		context.grants,
		subject,
		context.email,
		"view",
		context.baseline,
	);
	if (!view.allowed) return { ok: false, response: missing };

	const edit = resolveReportAccess(
		context.grants,
		subject,
		context.email,
		"edit",
		context.baseline,
	);

	return { ok: true, email: context.email, canEdit: edit.allowed };
}

export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const pageId = request.nextUrl.searchParams.get("pageId");
	const reportId = request.nextUrl.searchParams.get("reportId");
	if (!pageId || !reportId) {
		return NextResponse.json(
			{ error: "A page and its report are required." },
			{ status: 400 },
		);
	}

	const allowed = await reach(request, reportId);
	if (!allowed.ok) return allowed.response;

	try {
		return NextResponse.json({ notes: await listPageNotes(pageId) });
	} catch (error) {
		console.error("Failed to read notes:", error);
		return NextResponse.json(
			{ error: "Notes could not be loaded." },
			{ status: 500 },
		);
	}
}

interface PostBody {
	reportId?: unknown;
	pageId?: unknown;
	visualId?: unknown;
	body?: unknown;
	anchoredOn?: unknown;
}

export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	let payload: PostBody;
	try {
		payload = (await request.json()) as PostBody;
	} catch {
		return NextResponse.json(
			{ error: "The request could not be read." },
			{ status: 400 },
		);
	}

	const reportId =
		typeof payload.reportId === "string" ? payload.reportId : null;
	const pageId = typeof payload.pageId === "string" ? payload.pageId : null;
	const visualId =
		typeof payload.visualId === "string" ? payload.visualId : null;
	const body = typeof payload.body === "string" ? payload.body.trim() : "";

	if (!reportId || !pageId || !visualId) {
		return NextResponse.json(
			{ error: "A report, a page and a visual are required." },
			{ status: 400 },
		);
	}
	if (body === "") {
		return NextResponse.json(
			{ error: "A note needs something in it." },
			{ status: 400 },
		);
	}
	if (body.length > maxNoteLength) {
		return NextResponse.json(
			{
				error: `A note can be up to ${maxNoteLength} characters. This one is ${body.length}.`,
			},
			{ status: 400 },
		);
	}

	// A date, or nothing. Anything else is dropped rather than refused: an
	// anchor is an optional convenience, and losing it is not worth losing the
	// note somebody typed.
	const anchoredOn =
		typeof payload.anchoredOn === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(payload.anchoredOn)
			? payload.anchoredOn
			: null;

	const allowed = await reach(request, reportId);
	if (!allowed.ok) return allowed.response;

	// The page has to belong to the report the access was checked against, or
	// a caller could read one report and write a note onto another.
	const pages = await sql<{ page_id: string }>(
		`SELECT page_id::text FROM report_pages
		 WHERE page_id = $1 AND report_id = $2`,
		[pageId, reportId],
	);
	if (pages.length === 0) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	try {
		const note = await addNote({
			reportId,
			pageId,
			visualId,
			authorEmail: allowed.email,
			body,
			anchoredOn,
		});
		if (!note) {
			return NextResponse.json(
				{ error: "The note could not be saved." },
				{ status: 400 },
			);
		}
		return NextResponse.json({ note });
	} catch (error) {
		console.error("Failed to add a note:", error);
		return NextResponse.json(
			{ error: "The note could not be saved." },
			{ status: 500 },
		);
	}
}

export async function DELETE(request: NextRequest) {
	await ensureReadyOrDegrade();

	const noteId = request.nextUrl.searchParams.get("noteId");
	if (!noteId) {
		return NextResponse.json(
			{ error: "A note is required." },
			{ status: 400 },
		);
	}

	try {
		const reportId = await noteReport(noteId);
		if (!reportId) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const allowed = await reach(request, reportId);
		if (!allowed.ok) return allowed.response;

		const removed = await removeNote(
			noteId,
			allowed.email,
			allowed.canEdit,
		);
		if (!removed) {
			// Either it is gone already or it belongs to somebody else and
			// this caller cannot edit the report. The same answer for both,
			// since the second is not something to spell out.
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
		return NextResponse.json({ removed: true });
	} catch (error) {
		console.error("Failed to remove a note:", error);
		return NextResponse.json(
			{ error: "The note could not be removed." },
			{ status: 500 },
		);
	}
}
