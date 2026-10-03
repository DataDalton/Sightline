import { sql } from "../data/lakebase";
import { cachedDefinition, invalidateDefinitions } from "./definitionCache";

// Every active curated report, held once for the whole replica.
//
// The rows are the same for every reader. Which of them a reader may open is
// decided per reader by the resolver, so listings, navigation counts, search
// and catalogue reachability all filter this one list in memory rather than
// each asking the database for it.
//
// Personal pages are left out at the query. They belong to one person and the
// people named on them, so a list shared by everyone has no business holding
// them.

export interface CuratedReportRow {
	report_id: string;
	category_id: string | null;
	slug: string;
	title: string;
	description: string | null;
	source_key: string | null;
	visibility: string;
	version: string | number;
	modified_on: string;
	is_personal: boolean;
	owner_email: string | null;
	protect_delete: boolean;
	protect_edit: boolean;
	protect_add_page: boolean;
	sort_order: number;
}

// Under the navigation prefix, so every write that already drops navigation
// (creating, moving, removing or publishing a report, and category changes)
// drops this with it.
const curatedKey = "navigation:curated";

export async function curatedReports(): Promise<CuratedReportRow[]> {
	return await cachedDefinition(
		curatedKey,
		async () =>
			await sql<CuratedReportRow>(
				`SELECT report_id::text AS report_id, category_id, slug, title,
				        description, source_key, visibility, version, modified_on,
				        is_personal, owner_email, protect_delete, protect_edit,
				        protect_add_page, sort_order
				 FROM reports
				 WHERE is_active = TRUE AND is_personal = FALSE
				 ORDER BY sort_order, title`,
			),
	);
}

// Drops what this replica holds about one report after a save to it: the
// header under its slug, its pages and visuals, the lookup from its id to its
// slug, and the shared curated list, which carries its title, version and
// modification time.
//
// Every slug the report has been reachable under is passed, so a rename drops
// the entry under the old address as well as the new one. With no slug known,
// every report header is dropped rather than risk keeping a stale one.
export function invalidateReport(
	reportId: string,
	slugs: (string | null | undefined)[],
): void {
	const known = [...new Set(slugs)].filter((s): s is string => Boolean(s));
	if (known.length === 0) invalidateDefinitions("report:");
	for (const slug of known) invalidateDefinitions(`report:${slug}`);
	invalidateDefinitions(`report-body:${reportId}`);
	invalidateDefinitions(`report-slug:${reportId.toLowerCase()}`);
	invalidateDefinitions(`report-subject:${reportId.toLowerCase()}`);
	invalidateDefinitions(curatedKey);
}

// Drops everything built from the catalogue as a whole: the navigation, the
// curated list and every reader's home page plan, which chooses its figures
// from the reports a reader can open. Called when a report or category is
// created, removed, moved, renamed or published, not when one is only
// edited, so a busy editor does not empty everyone's held plan on each save.
export function catalogueChanged(): void {
	invalidateDefinitions("navigation:");
	invalidateDefinitions("briefing-plan:");
}

export interface ReportSubject {
	category_id: string | null;
	is_personal: boolean;
	owner_email: string | null;
}

// What an access check needs to know about one report, its category, whether
// it is personal and who owns it, held like the rest of its definition so a
// page that checks it on each of its requests reads it once. The check itself
// still runs per request, against the reader's own grants. Null when there is
// no such active report.
export async function reportSubject(
	reportId: string,
): Promise<ReportSubject | null> {
	const rows = await cachedDefinition(
		`report-subject:${reportId.toLowerCase()}`,
		async () =>
			await sql<ReportSubject>(
				`SELECT category_id, is_personal, owner_email
				 FROM reports
				 WHERE report_id = $1 AND is_active = TRUE`,
				[reportId],
			),
	);
	return rows[0] ?? null;
}
