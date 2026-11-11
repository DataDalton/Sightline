import { diffVersions, type VersionDiff } from "./versionDetail";
import type { Snapshot, SnapshotPage, SnapshotVisual } from "./versionDiff";
import { applyToSnapshot } from "./suggestionPreview";
import { sql } from "../data/lakebase";
import { cachedDefinition, invalidateDefinitions } from "./definitionCache";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { insertLog } from "../activityLog";
import { notify } from "../notify/store";
import { settings } from "../settings";
import {
	canOnReport,
	can,
	editingFacts,
	editModeOn,
	pageDenied,
	pageEditMode,
	getExplicitContext,
	invalidateAccessCache,
	type Capability,
	type AccessContext,
} from "./access";
import { reportSubject } from "./curated";
import { describeOperations } from "./describeOperations";
import {
	applyEdits,
	checkOperations,
	EditConflictError,
	EditForbiddenError,
	EditRejectedError,
	type EditOperation,
	pagesTouched,
} from "./editing";
import { publishPage } from "./personal";
import { maintainersOf } from "./permissionStore";

// Things waiting on somebody else's decision: a change suggested to a report, and
// a personal page somebody has asked to have made official.

export class RequestError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export type Decision = "approve" | "decline" | "withdraw";

const noteLimit = 2000;

function cleanNote(note: unknown): string | null {
	const text = typeof note === "string" ? note.trim() : "";
	return text ? text.slice(0, noteLimit) : null;
}

// Whoever holds this capability by name. A group cannot be told, because the app
// has no way to list a group's members, so those people find it under Waiting for
// you instead.
async function usersHolding(capability: Capability): Promise<string[]> {
	const rows = await sql<{ subject_id: string }>(
		`SELECT DISTINCT ra.subject_id
		 FROM role_assignments ra
		 JOIN role_capabilities rc ON rc.role_id = ra.role_id
		 JOIN roles r ON r.role_id = ra.role_id AND r.is_active = TRUE
		 WHERE ra.is_active = TRUE AND ra.subject_type = 'user'
		   AND rc.capability = $1
		   AND (ra.expires_on IS NULL OR ra.expires_on > now())`,
		[capability],
	);
	return rows.map((row) => row.subject_id);
}

function tell(
	people: string[],
	except: string,
	message: { title: string; body?: string; link: string },
): void {
	const everyone = new Set(people.map((person) => person.toLowerCase()));
	everyone.delete(except.toLowerCase());
	for (const person of everyone) {
		void notify(person, { kind: "system", ...message }).catch((error) => {
			console.warn("A request notification was not delivered:", error);
		});
	}
}

// Whether the setting says the person who asked cannot be the one to approve.
function refuseOwnApproval(author: string, approver: string): void {
	if (
		settings().requireSecondApprover &&
		author.toLowerCase() === approver.toLowerCase()
	) {
		throw new RequestError(
			"Somebody other than you has to approve this.",
			403,
		);
	}
}

// --- Suggested changes --------------------------------------------------------

export interface Suggestion {
	suggestionId: string;
	reportId: string;
	reportTitle: string;
	reportSlug: string;
	authorEmail: string;
	note: string | null;
	summary: string[];
	createdOn: string;
	// The report has changed since this was drafted, so approving it may overwrite
	// what happened in between.
	movedOn: boolean;
}

interface SuggestionRow {
	suggestion_id: string;
	report_id: string;
	title: string;
	slug: string;
	category_id: string | null;
	tags: string[] | null;
	version: string;
	author_email: string;
	note: string | null;
	summary: string[];
	base_version: string;
	created_on: string;
}

const suggestionColumns = `s.suggestion_id::text AS suggestion_id,
	s.report_id::text AS report_id, r.title, r.slug, r.category_id, r.tags,
	r.version, s.author_email, s.note, s.summary, s.base_version, s.created_on`;

function toSuggestion(row: SuggestionRow): Suggestion {
	return {
		suggestionId: row.suggestion_id,
		reportId: row.report_id,
		reportTitle: row.title,
		reportSlug: row.slug,
		authorEmail: row.author_email,
		note: row.note,
		summary: row.summary,
		createdOn: row.created_on,
		movedOn: Number(row.version) !== Number(row.base_version),
	};
}

export async function createSuggestion(
	policy: PolicyClass,
	identity: Identity,
	reportId: string,
	input: { baseVersion: number; operations: EditOperation[]; note?: unknown },
): Promise<string> {
	const subject = await reportSubject(reportId);
	if (!subject) throw new RequestError("Not found", 404);
	if (input.operations.length === 0) {
		throw new RequestError("There is nothing to suggest yet.");
	}

	const ref = {
		reportId,
		categoryId: subject.category_id,
		isPersonal: subject.is_personal,
		ownerEmail: subject.owner_email,
		tags: subject.tags,
		editPolicy: subject.edit_policy,
	};
	const [context, facts] = await Promise.all([
		getExplicitContext(policy, identity.email),
		editingFacts(),
	]);
	const touched = await pagesTouched(input.operations);
	const onEachPage =
		!touched.touchesReport &&
		touched.pageIds.length > 0 &&
		touched.pageIds.every((pageId) =>
			pageEditMode(context, ref, pageId, facts),
		);
	const refusedOnAPage = touched.pageIds.some(
		(pageId) =>
			pageDenied(context, "report.edit", pageId) &&
			pageDenied(context, "report.suggest", pageId),
	);
	if ((!editModeOn(context, ref, facts) && !onEachPage) || refusedOnAPage) {
		throw new RequestError(
			"You do not have permission to suggest changes to this report.",
			403,
		);
	}

	// Refused now, not when a Maintainer goes to approve it.
	await checkOperations(reportId, input.operations);

	const report = await sql<{
		title: string;
		slug: string;
		description: string | null;
		theme: string | null;
	}>(
		`SELECT title, slug, description, theme FROM reports WHERE report_id = $1`,
		[reportId],
	);
	const titles = await sql<{ visual_id: string; title: string | null }>(
		`SELECT v.visual_id::text AS visual_id, v.title
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 WHERE p.report_id = $1`,
		[reportId],
	);
	const titleOf = new Map(titles.map((t) => [t.visual_id, t.title]));
	const summary = describeOperations(
		input.operations,
		(visualId) => titleOf.get(visualId) ?? null,
		report[0],
	);

	const rows = await sql<{ suggestion_id: string }>(
		`INSERT INTO report_suggestions
		   (report_id, author_email, note, base_version, operations, summary)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
		 RETURNING suggestion_id::text AS suggestion_id`,
		[
			reportId,
			identity.email,
			cleanNote(input.note),
			input.baseVersion,
			JSON.stringify(input.operations),
			JSON.stringify(summary),
		],
	);
	dropOpenSuggestions(reportId);
	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "suggest_change",
		changedBy: identity.email,
		newValue: JSON.stringify(summary),
	});

	const maintainers = maintainersOf(facts, ref)
		.filter((holder) => holder.subjectType === "user")
		.map((holder) => holder.subjectId);
	tell(
		maintainers.length > 0
			? maintainers
			: await usersHolding("report.review"),
		identity.email,
		{
			title: `${identity.email} suggested a change to ${report[0]?.title ?? "a report"}`,
			body: summary.slice(0, 3).join(". "),
			link: `/r/${report[0]?.slug}?suggestions=1`,
		},
	);
	return rows[0].suggestion_id;
}

// The report now, set against the report with this suggestion applied. Nothing is written.
export async function suggestionComparison(
	reportId: string,
	suggestionId: string,
): Promise<VersionDiff | null> {
	const [held] = await sql<{ operations: EditOperation[] }>(
		`SELECT operations FROM report_suggestions
		 WHERE suggestion_id::text = $1 AND report_id = $2`,
		[suggestionId, reportId],
	);
	if (!held) return null;
	const [visuals, pages, report, version] = await Promise.all([
		sql<SnapshotVisual>(
			`SELECT v.visual_id::text AS visual_id, v.page_id::text AS page_id,
			        v.visual_type, v.title, v.source_key, v.config, v.layout_x,
			        v.layout_y, v.layout_w, v.layout_h, v.sort_order, v.is_active
			 FROM report_visuals v
			 JOIN report_pages p ON p.page_id = v.page_id
			 WHERE p.report_id = $1`,
			[reportId],
		),
		sql<SnapshotPage>(
			`SELECT page_id::text AS page_id, slug, title, source_key, config,
			        sort_order, is_active
			 FROM report_pages WHERE report_id = $1`,
			[reportId],
		),
		sql<{
			title: string;
			description: string | null;
			theme: string | null;
		}>(
			`SELECT title, description, theme FROM reports WHERE report_id = $1`,
			[reportId],
		),
		sql<{ version: string }>(
			`SELECT version FROM reports WHERE report_id = $1`,
			[reportId],
		),
	]);
	const now: Snapshot = { visuals, pages, report: report[0] ?? null };
	const number = Number(version[0]?.version ?? 0);
	return diffVersions(
		now,
		applyToSnapshot(now, held.operations),
		number,
		number,
	);
}

// Whether someone looks after every page a suggestion changes, which lets them decide it. A
// suggestion reaching the report as a whole, or a page they do not look after, is the
// report's Maintainers' to decide.
async function decidesThroughPages(
	context: AccessContext,
	reportId: string,
	operations: EditOperation[],
): Promise<boolean> {
	const held = context.pagesByReport?.get(reportId);
	if (!held) return false;
	const { pageIds, touchesReport } = await pagesTouched(operations);
	return (
		!touchesReport &&
		pageIds.length > 0 &&
		pageIds.every(
			(pageId) =>
				held.has(pageId) &&
				context.capabilities.get("report.review")?.has(pageId) &&
				!pageDenied(context, "report.review", pageId),
		)
	);
}

// The open suggestions this person can decide on one report.
// A report's open suggestions. Every visit to the report asks, and they change only when one
// is made or decided, or the report itself changes, so they are held until then.
const openKey = (reportId: string) => `report-suggestions:${reportId}`;

export function dropOpenSuggestions(reportId: string): void {
	invalidateDefinitions(openKey(reportId));
}

function openSuggestions(
	reportId: string,
): Promise<(SuggestionRow & { operations: EditOperation[] })[]> {
	return cachedDefinition(openKey(reportId), () =>
		sql<SuggestionRow & { operations: EditOperation[] }>(
			`SELECT ${suggestionColumns}, s.operations
			 FROM report_suggestions s
			 JOIN reports r ON r.report_id = s.report_id
			 WHERE s.report_id = $1 AND s.status = 'open'
			 ORDER BY s.created_on`,
			[reportId],
		),
	);
}

export async function suggestionsToDecide(
	policy: PolicyClass,
	identity: Identity,
	report: { reportId: string; canReview: boolean },
): Promise<Suggestion[]> {
	const rows = await openSuggestions(report.reportId);
	if (report.canReview) return rows.map(toSuggestion);
	const context = await getExplicitContext(policy, identity.email);
	const out: Suggestion[] = [];
	for (const row of rows) {
		if (
			await decidesThroughPages(context, report.reportId, row.operations)
		) {
			out.push(toSuggestion(row));
		}
	}
	return out;
}

export async function decideSuggestion(
	policy: PolicyClass,
	identity: Identity,
	suggestionId: string,
	decision: Decision,
	note?: unknown,
): Promise<void> {
	const rows = await sql<{
		report_id: string;
		author_email: string;
		operations: EditOperation[];
		status: string;
	}>(
		`SELECT report_id::text AS report_id, author_email, operations, status
		 FROM report_suggestions WHERE suggestion_id = $1`,
		[suggestionId],
	);
	const row = rows[0];
	if (!row) throw new RequestError("Not found", 404);
	if (row.status !== "open") {
		throw new RequestError("Somebody has already dealt with this.", 409);
	}
	const subject = await reportSubject(row.report_id);
	if (!subject) throw new RequestError("Not found", 404);

	const mine =
		row.author_email.toLowerCase() === identity.email.toLowerCase();
	if (decision === "withdraw") {
		if (!mine) throw new RequestError("Not found", 404);
	} else {
		const context = await getExplicitContext(policy, identity.email);
		const reviews = canOnReport(
			context.capabilities,
			"report.review",
			{
				reportId: row.report_id,
				categoryId: subject.category_id,
				tags: subject.tags,
			},
			context.denied,
		);
		if (
			!reviews &&
			!(await decidesThroughPages(context, row.report_id, row.operations))
		) {
			throw new RequestError(
				"Only this report's Maintainers can decide on suggestions.",
				403,
			);
		}
		if (decision === "approve")
			refuseOwnApproval(row.author_email, identity.email);
	}

	const status =
		decision === "approve"
			? "approved"
			: decision === "decline"
				? "declined"
				: "withdrawn";

	// Claimed first, so two people approving at once apply it once.
	const claimed = await sql<{ suggestion_id: string }>(
		`UPDATE report_suggestions
		 SET status = $2, decided_by = $3, decided_on = now(), decision_note = $4
		 WHERE suggestion_id = $1 AND status = 'open'
		 RETURNING suggestion_id::text AS suggestion_id`,
		[suggestionId, status, identity.email, cleanNote(note)],
	);
	if (claimed.length === 0) {
		throw new RequestError("Somebody has already dealt with this.", 409);
	}
	dropOpenSuggestions(row.report_id);

	if (decision === "approve") {
		try {
			const current = await sql<{ version: string }>(
				`SELECT version FROM reports WHERE report_id = $1`,
				[row.report_id],
			);
			await applyEdits(policy, identity.email, {
				reportId: row.report_id,
				baseVersion: Number(current[0]?.version ?? 0),
				operations: row.operations,
			});
		} catch (error) {
			// Back to open, so the answer can be a decline rather than nothing.
			await sql(
				`UPDATE report_suggestions
				 SET status = 'open', decided_by = NULL, decided_on = NULL,
				     decision_note = NULL
				 WHERE suggestion_id = $1`,
				[suggestionId],
			);
			dropOpenSuggestions(row.report_id);
			if (
				error instanceof EditRejectedError ||
				error instanceof EditForbiddenError
			) {
				throw new RequestError(
					`This cannot be applied any more. ${error.message}`,
				);
			}
			if (error instanceof EditConflictError) {
				throw new RequestError(
					"The report changed at the same moment. Try again.",
					409,
				);
			}
			throw error;
		}
	}

	await insertLog({
		recordType: "report",
		recordId: row.report_id,
		action: `suggestion_${status}`,
		changedBy: identity.email,
		newValue: JSON.stringify({ suggestionId, author: row.author_email }),
	});
	if (decision !== "withdraw") {
		const report = await sql<{ title: string; slug: string }>(
			`SELECT title, slug FROM reports WHERE report_id = $1`,
			[row.report_id],
		);
		tell([row.author_email], identity.email, {
			title: `Your suggestion to ${report[0]?.title ?? "a report"} was ${status}`,
			body: cleanNote(note) ?? undefined,
			link: `/r/${report[0]?.slug}`,
		});
	}
}

// --- Asking for a page to be made official ------------------------------------

export interface PublishRequest {
	requestId: string;
	reportId: string;
	reportTitle: string;
	reportSlug: string;
	categoryId: string;
	categoryName: string | null;
	requestedBy: string;
	note: string | null;
	createdOn: string;
}

interface PublishRow {
	request_id: string;
	report_id: string;
	title: string;
	slug: string;
	category_id: string;
	category_name: string | null;
	requested_by: string;
	note: string | null;
	created_on: string;
}

function toPublishRequest(row: PublishRow): PublishRequest {
	return {
		requestId: row.request_id,
		reportId: row.report_id,
		reportTitle: row.title,
		reportSlug: row.slug,
		categoryId: row.category_id,
		categoryName: row.category_name,
		requestedBy: row.requested_by,
		note: row.note,
		createdOn: row.created_on,
	};
}

export async function askToPublish(
	identity: Identity,
	reportId: string,
	categoryId: string,
	note?: unknown,
): Promise<void> {
	const subject = await reportSubject(reportId);
	if (!subject || !subject.is_personal) {
		throw new RequestError("Only a personal page can be asked about.");
	}
	if (
		(subject.owner_email ?? "").toLowerCase() !==
		identity.email.toLowerCase()
	) {
		throw new RequestError("That is not one of your pages.", 403);
	}
	const category = await sql<{ name: string }>(
		`SELECT name FROM categories WHERE category_id = $1 AND is_active = TRUE`,
		[categoryId],
	);
	if (category.length === 0) {
		throw new RequestError("That category does not exist.");
	}

	await sql(
		`INSERT INTO publish_requests (report_id, category_id, requested_by, note)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (report_id) WHERE status = 'open'
		 DO UPDATE SET category_id = EXCLUDED.category_id, note = EXCLUDED.note`,
		[reportId, categoryId, identity.email, cleanNote(note)],
	);
	await insertLog({
		recordType: "report",
		recordId: reportId,
		action: "ask_to_publish",
		changedBy: identity.email,
		newValue: categoryId,
	});
	// Whoever decides can open the page from now on.
	invalidateAccessCache();

	const page = await sql<{ title: string; slug: string }>(
		`SELECT title, slug FROM reports WHERE report_id = $1`,
		[reportId],
	);
	tell(await usersHolding("report.makeOfficial"), identity.email, {
		title: `${identity.email} asked to publish ${page[0]?.title ?? "a page"}`,
		body: `In ${category[0].name}`,
		link: `/mine`,
	});
}

export async function decidePublish(
	policy: PolicyClass,
	identity: Identity,
	requestId: string,
	decision: Decision,
	input: { categoryId?: unknown; note?: unknown },
): Promise<void> {
	const rows = await sql<{
		report_id: string;
		category_id: string;
		requested_by: string;
		status: string;
	}>(
		`SELECT report_id::text AS report_id, category_id, requested_by, status
		 FROM publish_requests WHERE request_id = $1`,
		[requestId],
	);
	const row = rows[0];
	if (!row) throw new RequestError("Not found", 404);
	if (row.status !== "open") {
		throw new RequestError("Somebody has already dealt with this.", 409);
	}

	const categoryId =
		typeof input.categoryId === "string" && input.categoryId
			? input.categoryId
			: row.category_id;
	const mine =
		row.requested_by.toLowerCase() === identity.email.toLowerCase();

	if (decision === "withdraw") {
		if (!mine) throw new RequestError("Not found", 404);
	} else {
		const context = await getExplicitContext(policy, identity.email);
		if (
			!can(
				context.capabilities,
				"report.makeOfficial",
				categoryId,
				context.denied,
			)
		) {
			throw new RequestError(
				"Only a Report Publisher can decide on this.",
				403,
			);
		}
		if (decision === "approve")
			refuseOwnApproval(row.requested_by, identity.email);
	}

	let published: { slug: string; title: string } | null = null;
	if (decision === "approve") {
		// While the request is still open, because that is what lets somebody who
		// is not the owner publish it.
		published = await publishPage(identity, row.report_id, categoryId);
	}

	const status =
		decision === "approve"
			? "approved"
			: decision === "decline"
				? "declined"
				: "withdrawn";
	await sql(
		`UPDATE publish_requests
		 SET status = $2, decided_by = $3, decided_on = now(), decision_note = $4
		 WHERE request_id = $1`,
		[requestId, status, identity.email, cleanNote(input.note)],
	);
	await insertLog({
		recordType: "report",
		recordId: row.report_id,
		action: `publish_request_${status}`,
		changedBy: identity.email,
		newValue: JSON.stringify({ requestId, categoryId }),
	});
	invalidateAccessCache();

	if (decision !== "withdraw") {
		const page = await sql<{ title: string; slug: string }>(
			`SELECT title, slug FROM reports WHERE report_id = $1`,
			[row.report_id],
		);
		tell([row.requested_by], identity.email, {
			title: `${page[0]?.title ?? "Your page"} was ${
				published ? "published" : "not published"
			}`,
			body: cleanNote(input.note) ?? undefined,
			link: `/r/${page[0]?.slug}`,
		});
	}
}

// --- What is waiting for this person -------------------------------------------

export interface Waiting {
	suggestions: Suggestion[];
	publishRequests: PublishRequest[];
	myOpen: {
		suggestions: Suggestion[];
		publishRequests: PublishRequest[];
	};
	// Where a page can be asked to go.
	categories: { id: string; name: string }[];
	// Drafts asked to join a category this person looks after, to read before a Publisher
	// decides.
	draftsToRead: PublishRequest[];
}

export async function waitingFor(
	policy: PolicyClass,
	identity: Identity,
): Promise<Waiting> {
	const [suggestionRows, publishRows, categories, context] =
		await Promise.all([
			sql<SuggestionRow & { operations: EditOperation[] }>(
				`SELECT ${suggestionColumns}, s.operations
				 FROM report_suggestions s
				 JOIN reports r ON r.report_id = s.report_id AND r.is_active = TRUE
				 WHERE s.status = 'open'
				 ORDER BY s.created_on`,
			),
			sql<PublishRow>(
				`SELECT q.request_id::text AS request_id,
				        q.report_id::text AS report_id, r.title, r.slug,
				        q.category_id, c.name AS category_name, q.requested_by,
				        q.note, q.created_on
				 FROM publish_requests q
				 JOIN reports r ON r.report_id = q.report_id AND r.is_active = TRUE
				 LEFT JOIN categories c ON c.category_id = q.category_id
				 WHERE q.status = 'open'
				 ORDER BY q.created_on`,
			),
			sql<{ category_id: string; name: string }>(
				`SELECT category_id, name FROM categories
				 WHERE is_active = TRUE ORDER BY sort_order, name`,
			),
			getExplicitContext(policy, identity.email),
		]);

	const email = identity.email.toLowerCase();
	const canAdministerAccess = can(
		context.capabilities,
		"access.grant",
		null,
		context.denied,
	);
	// Unanswered for long enough, a request reaches an administrator as well.
	const overdueBefore =
		Date.now() - settings().requestEscalationDays * 24 * 60 * 60 * 1000;
	const overdue = (createdOn: string) =>
		canAdministerAccess && new Date(createdOn).getTime() < overdueBefore;

	// Worked out only for reports this person holds a page of, which is almost nobody.
	const throughPages = new Set<string>();
	for (const row of suggestionRows) {
		if (
			context.pagesByReport?.has(row.report_id) &&
			(await decidesThroughPages(context, row.report_id, row.operations))
		) {
			throughPages.add(row.suggestion_id);
		}
	}

	return {
		suggestions: suggestionRows
			.filter(
				(row) =>
					row.author_email.toLowerCase() !== email &&
					(overdue(row.created_on) ||
						throughPages.has(row.suggestion_id) ||
						canOnReport(
							context.capabilities,
							"report.review",
							{
								reportId: row.report_id,
								categoryId: row.category_id,
								tags: row.tags,
							},
							context.denied,
						)),
			)
			.map(toSuggestion),
		publishRequests: publishRows
			.filter(
				(row) =>
					row.requested_by.toLowerCase() !== email &&
					(overdue(row.created_on) ||
						can(
							context.capabilities,
							"report.makeOfficial",
							row.category_id,
							context.denied,
						)),
			)
			.map(toPublishRequest),
		myOpen: {
			suggestions: suggestionRows
				.filter((row) => row.author_email.toLowerCase() === email)
				.map(toSuggestion),
			publishRequests: publishRows
				.filter((row) => row.requested_by.toLowerCase() === email)
				.map(toPublishRequest),
		},
		categories: categories.map((c) => ({
			id: c.category_id,
			name: c.name,
		})),
		draftsToRead: publishRows
			.filter(
				(row) =>
					row.requested_by.toLowerCase() !== email &&
					can(
						context.capabilities,
						"report.review",
						row.category_id,
						context.denied,
					) &&
					!can(
						context.capabilities,
						"report.makeOfficial",
						row.category_id,
						context.denied,
					),
			)
			.map(toPublishRequest),
	};
}
