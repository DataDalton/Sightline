import {
	fieldParam,
	packClauses,
	slug as nameInAddress,
	type ShareClause,
} from "./shareState";

// Moving from one report to another, carrying what the reader was looking at.
//
// An author names the reports a visual leads to. A reader clicks something on
// the visual, and the app offers those reports already filtered to what was
// clicked. The filter travels in the address the target report reads anyway, so
// the receiving end needs nothing special and the result is a link somebody can
// send.
//
// A target only takes a filter it has a control for. Applying one with nothing
// on screen able to show or clear it would change the figures without saying so,
// which is why the address format drops those. So a link is only offered for a
// click when the target can really receive it. Otherwise the reader would land on
// an unfiltered report that looks like the answer to what they clicked.

export interface ReportLink {
	slug: string;
	title: string;
	// What the author wants it called, in place of the report's title.
	label?: string;
}

// What the app knows about a report as somewhere to go.
export interface LinkTarget {
	slug: string;
	title: string;
	pages: { title: string; filterFields: string[] }[];
}

export function readLinks(value: unknown): ReportLink[] {
	if (!Array.isArray(value)) return [];
	const links: ReportLink[] = [];
	for (const raw of value) {
		const held = raw as Partial<ReportLink> | null;
		if (typeof held?.slug !== "string" || !held.slug) continue;
		if (typeof held.title !== "string") continue;
		links.push({
			slug: held.slug,
			title: held.title,
			...(typeof held.label === "string" && held.label.trim()
				? { label: held.label.trim() }
				: {}),
		});
	}
	return links;
}

// The page of a target that can receive these fields, preferring the one that
// takes the most of them. The first page wins a tie, since that is where the
// report opens. Null when none of its pages has a control for any of them.
export function pageReceiving(
	target: LinkTarget,
	fields: string[],
): number | null {
	let best: number | null = null;
	let bestCount = 0;
	target.pages.forEach((page, index) => {
		const count = fields.filter((f) =>
			page.filterFields.includes(f),
		).length;
		if (count > bestCount) {
			best = index;
			bestCount = count;
		}
	});
	return best;
}

// The address that opens a report filtered to these clauses, written the same way
// the report writes its own address. A later clause on a field replaces an
// earlier one, so what was clicked overrides what the page was already set to.
export function linkAddress(
	slug: string,
	clauses: ShareClause[],
	pageTitle?: string | null,
): string {
	const byField = new Map<string, ShareClause[]>();
	for (const clause of clauses) byField.set(clause.field, []);
	for (const clause of clauses) byField.get(clause.field)?.push(clause);

	const params = new URLSearchParams();
	if (pageTitle) params.set("page", nameInAddress(pageTitle));
	for (const [field, held] of byField) {
		// A range is two clauses that belong together. Anything else keeps the
		// last one said.
		const isRange = held.every((c) => c.op === "gte" || c.op === "lte");
		const packed = packClauses(isRange ? held : [held[held.length - 1]]);
		if (packed !== null) params.set(fieldParam(field), packed);
	}

	const query = params.toString();
	return `/r/${encodeURIComponent(slug)}/${query ? `?${query}` : ""}`;
}

// Reports that can receive a click on these fields, listed first when an author
// is choosing. A report that cannot is still choosable, for a page's navigation.
export function suggestTargets(
	targets: LinkTarget[],
	fields: string[],
): { suggested: LinkTarget[]; others: LinkTarget[] } {
	const suggested: LinkTarget[] = [];
	const others: LinkTarget[] = [];
	for (const target of targets) {
		(pageReceiving(target, fields) === null ? others : suggested).push(
			target,
		);
	}
	return { suggested, others };
}
