import { sql, tryAdvisoryLock } from "../data/lakebase";
import { notify } from "../notify/store";
import {
	collectDependents,
	maintainersFor,
	type Dependent,
	type DependentKind,
	type DependentReport,
} from "../platform/dependents";
import { demoMode } from "../runtime";
import { syncSourceFields, type FieldSyncResult } from "./fieldSync";
import { loadRegistry } from "./registry";

// Noticing that a field went away, and telling the people it affects.
//
// A field disappears upstream without anybody in this application doing
// anything, so waiting for an administrator to click sync meant the first
// anyone heard of it was a chart that stopped drawing. The field sync runs on
// its own once a day per source, and whoever owns an item naming a field that
// went is told once, with the items named.

// --- Telling people ---------------------------------------------------------

// How an item is called in a sentence.
const kindWords: Record<DependentKind, string> = {
	visual: "page",
	pageFreshness: "page",
	savedView: "saved view",
	exploration: "exploration",
	exploreView: "saved exploration",
	alert: "alert",
	pageAlert: "page alert",
	delivery: "scheduled page",
	sheet: "sheet",
	sourceDefaultTime: "default time field",
};

interface ClaimedField {
	source_key: string;
	source_title: string;
	field_name: string;
	renamed_to: string | null;
	rename_candidate: string | null;
}

function describeField(field: ClaimedField, sourceTitle: string): string {
	const base = `"${field.field_name}" is no longer in ${sourceTitle}.`;
	if (field.renamed_to)
		return `${base} It was renamed to "${field.renamed_to}".`;
	if (field.rename_candidate) {
		return `${base} It may have been renamed to "${field.rename_candidate}".`;
	}
	return base;
}

function list(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// One line per item, deduplicated, as an owner would recognise it.
function itemLabel(dependent: Dependent): string {
	if (dependent.kind === "visual" || dependent.kind === "pageFreshness") {
		return `page "${dependent.report?.title ?? dependent.name ?? "untitled"}"`;
	}
	return `${kindWords[dependent.kind]} "${dependent.name ?? "untitled"}"`;
}

// Whose own item this is, rather than a curated report looked after by its
// category's maintainers.
function isPersonalItem(dependent: Dependent): boolean {
	if (dependent.kind === "sourceDefaultTime") return false;
	if (
		dependent.kind === "visual" ||
		dependent.kind === "pageFreshness" ||
		dependent.kind === "pageAlert"
	) {
		return dependent.report?.isPersonal === true;
	}
	return true;
}

export interface AnnounceResult {
	fields: number;
	notified: number;
}

// Tells people about every missing field on the given sources that has not
// been announced yet, and marks each announced so a later sync says nothing
// more. Claimed before anything is sent, so two replicas finishing a sync at
// once do not both send.
export async function announceMissingFields(
	sourceKeys: string[] | null = null,
): Promise<AnnounceResult> {
	const claimed = await sql<ClaimedField>(
		`UPDATE source_fields AS f
		 SET announced_on = now()
		 FROM data_sources d
		 WHERE d.source_key = f.source_key AND d.is_active
		   AND f.status = 'missing' AND f.announced_on IS NULL
		   AND ($1::text[] IS NULL OR f.source_key = ANY($1::text[]))
		 RETURNING f.source_key, d.title AS source_title, f.field_name,
		           f.renamed_to, f.rename_candidate`,
		[sourceKeys],
	);
	if (claimed.length === 0) return { fields: 0, notified: 0 };

	const bySource = new Map<string, ClaimedField[]>();
	for (const row of claimed) {
		const held = bySource.get(row.source_key) ?? [];
		held.push(row);
		bySource.set(row.source_key, held);
	}

	// Per owner, across every source, so somebody is told once however many
	// of their things broke.
	const owners = new Map<
		string,
		{ lines: Set<string>; items: Set<string>; link: string | null }
	>();
	let notified = 0;

	for (const [sourceKey, fields] of bySource) {
		const sourceTitle = fields[0].source_title;
		const byName = new Map(fields.map((f) => [f.field_name, f]));
		let dependents: Dependent[];
		try {
			dependents = await collectDependents(
				[sourceKey],
				[...byName.keys()],
			);
		} catch (error) {
			console.warn(
				`Could not find what depends on the missing fields of ${sourceKey}:`,
				error,
			);
			continue;
		}
		if (dependents.length === 0) continue;

		// Curated reports, per category, for their maintainers.
		const reports = new Map<string, DependentReport>();
		const reportFields = new Map<string, Set<string>>();
		let defaultTime: string | null = null;

		for (const dependent of dependents) {
			const field = byName.get(dependent.field);
			if (!field) continue;

			if (dependent.kind === "sourceDefaultTime") {
				defaultTime = dependent.field;
				continue;
			}

			if (!isPersonalItem(dependent)) {
				if (dependent.report) {
					reports.set(dependent.report.reportId, dependent.report);
					const held =
						reportFields.get(dependent.report.reportId) ??
						new Set<string>();
					held.add(dependent.field);
					reportFields.set(dependent.report.reportId, held);
				}
				continue;
			}

			const owner = dependent.ownerEmail?.toLowerCase();
			if (!owner) continue;
			const held = owners.get(owner) ?? {
				lines: new Set<string>(),
				items: new Set<string>(),
				link: dependent.link,
			};
			held.lines.add(describeField(field, sourceTitle));
			held.items.add(itemLabel(dependent));
			owners.set(owner, held);
		}

		if (reports.size > 0 || defaultTime) {
			notified += await tellMaintainers(
				sourceKey,
				sourceTitle,
				[...reports.values()],
				reportFields,
				defaultTime,
				fields,
			);
		}
	}

	for (const [email, held] of owners) {
		const items = [...held.items];
		const body =
			`${[...held.lines].join(" ")} ` +
			`Your ${list(items)} ${items.length === 1 ? "uses" : "use"} it and ` +
			`will show an error until ${items.length === 1 ? "it is" : "they are"} ` +
			"changed to another field.";
		try {
			await notify(email, {
				kind: "schema",
				title:
					items.length === 1
						? "A field one of your items uses has gone"
						: `A field ${items.length} of your items use has gone`,
				body,
				link: held.link,
				data: { items },
			});
			notified++;
		} catch (error) {
			console.warn(
				`Could not tell ${email} about a missing field:`,
				error,
			);
		}
	}

	return { fields: claimed.length, notified };
}

// One message per maintainer for one source, naming the reports of theirs that
// name a field that went.
async function tellMaintainers(
	sourceKey: string,
	sourceTitle: string,
	reports: DependentReport[],
	reportFields: Map<string, Set<string>>,
	defaultTime: string | null,
	fields: ClaimedField[],
): Promise<number> {
	// Who looks after which report. Holders of the catalogue sync capability
	// look after all of them and come back from every category.
	const recipients = new Map<string, Set<string>>();
	const categories = [...new Set(reports.map((r) => r.categoryId ?? ""))];
	for (const category of categories) {
		let people: string[];
		try {
			people = await maintainersFor(category ? [category] : []);
		} catch (error) {
			console.warn("Could not read who maintains a category:", error);
			continue;
		}
		for (const email of people) {
			const held = recipients.get(email) ?? new Set<string>();
			for (const report of reports) {
				if ((report.categoryId ?? "") === category) {
					held.add(report.reportId);
				}
			}
			recipients.set(email, held);
		}
	}
	if (defaultTime && categories.length === 0) {
		for (const email of await maintainersFor([]).catch(() => [])) {
			if (!recipients.has(email)) recipients.set(email, new Set());
		}
	}

	const byId = new Map(reports.map((r) => [r.reportId, r]));
	const byName = new Map(fields.map((f) => [f.field_name, f]));
	let told = 0;

	for (const [email, reportIds] of recipients) {
		const theirs = [...reportIds]
			.map((id) => byId.get(id))
			.filter((r): r is DependentReport => Boolean(r));
		const named = new Set<string>();
		for (const report of theirs) {
			for (const field of reportFields.get(report.reportId) ?? []) {
				named.add(field);
			}
		}
		if (defaultTime) named.add(defaultTime);

		const lines = [...named]
			.map((name) => byName.get(name))
			.filter((f): f is ClaimedField => Boolean(f))
			.map((f) => describeField(f, sourceTitle));
		const parts = [lines.join(" ")];
		if (theirs.length > 0) {
			parts.push(
				`${theirs.length === 1 ? "The report" : "Reports"} ` +
					`${list(theirs.map((r) => `"${r.title}"`))} ` +
					`${theirs.length === 1 ? "uses" : "use"} it.`,
			);
		}
		if (defaultTime) {
			parts.push(
				`"${defaultTime}" is also the default time field of ${sourceTitle}.`,
			);
		}
		parts.push(
			"A rename can be remapped in one step under Platform, Sources.",
		);

		try {
			await notify(email, {
				kind: "schema",
				title:
					theirs.length > 0
						? `${theirs.length} ${theirs.length === 1 ? "report uses" : "reports use"} a field gone from ${sourceTitle}`
						: `A field is gone from ${sourceTitle}`,
				body: parts.join(" "),
				link: theirs[0]
					? `/r/${encodeURIComponent(theirs[0].slug)}/`
					: "/admin/",
				data: {
					sourceKey,
					fields: [...named],
					reports: theirs.map((r) => r.slug),
				},
			});
			told++;
		} catch (error) {
			console.warn(
				`Could not tell ${email} about a missing field:`,
				error,
			);
		}
	}
	return told;
}

// --- Daily detection --------------------------------------------------------

// Identifies the daily field sync lock. Every replica ticks, one syncs.
const dailyFieldSyncLockKey = 8577425;

// How long a source's fields are trusted before they are read again.
const syncEveryMs = 24 * 60 * 60 * 1000;

// A source whose sync failed is not retried on every tick. The failure is
// usually a privilege the application lacks, which a few hours do not change.
const retryAfterMs = 6 * 60 * 60 * 1000;
const failedAt = new Map<string, number>();

let running = false;

// Reads the fields of every source not read in the last day, under the
// application's own identity, then tells people about anything that went.
//
// Safe to call as often as a timer likes, because sources read recently are
// skipped and only one replica works at a time.
export async function runDailyFieldSync(): Promise<void> {
	// The demonstration has no catalogue, and reading one would find every
	// sample field missing.
	if (demoMode || running) return;
	running = true;
	try {
		await tryAdvisoryLock(dailyFieldSyncLockKey, syncDueSources);
	} catch (error) {
		console.warn("The daily field sync did not run:", error);
	} finally {
		running = false;
	}
}

async function syncDueSources(): Promise<void> {
	const due = await sql<{ source_key: string }>(
		`SELECT source_key FROM data_sources
		 WHERE is_active
		   AND (fields_synced_on IS NULL
		        OR fields_synced_on < now() - make_interval(secs => $1))
		 ORDER BY fields_synced_on NULLS FIRST, source_key`,
		[syncEveryMs / 1000],
	);

	const now = Date.now();
	const results: FieldSyncResult[] = [];
	// One at a time, as an administrator's sync does, so a burst of catalogue
	// reads does not compete with readers for warehouse slots.
	for (const { source_key } of due) {
		const failed = failedAt.get(source_key);
		if (failed && now - failed < retryAfterMs) continue;
		const result = await syncSourceFields(null, source_key).catch(
			(error): FieldSyncResult | null => {
				console.warn(
					`Daily field sync of ${source_key} failed:`,
					error,
				);
				return null;
			},
		);
		if (!result || result.error) {
			failedAt.set(source_key, now);
			if (result?.error) {
				console.warn(
					`Daily field sync of ${source_key} did not complete: ${result.error}`,
				);
			}
		} else {
			failedAt.delete(source_key);
		}
		if (result) results.push(result);
	}

	const changed = results.some(
		(r) =>
			r.added.length > 0 ||
			r.reclassified.length > 0 ||
			r.newlyMissing.length > 0 ||
			r.returned.length > 0 ||
			r.protection?.changed,
	);
	if (changed) await loadRegistry(true);

	// Every source read cleanly, so a field whose announcement failed last
	// time is told about now.
	const touched = results.filter((r) => !r.error).map((r) => r.sourceKey);
	if (touched.length > 0) {
		await announceMissingFields(touched).catch((error) => {
			console.warn("Could not announce missing fields:", error);
		});
	}
}
