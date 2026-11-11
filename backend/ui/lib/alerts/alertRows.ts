import { invalidateDefinitions } from "../platform/definitionCache";

// Where the alerts on a page are held for each reader. See listPageAlerts in
// lib/alerts/pageStore.
//
// Every reader of a page sees its alerts, their last check and how many follow
// each, so anything that changes one of those drops the page for everyone: an
// alert set, changed or removed, anyone following or leaving one, and each
// check. Keyed under the report as well, so a save that renames the report or
// its pages drops all of its pages at once.

export function alertRowsKey(
	reportId: string,
	pageId: string,
	email: string,
): string {
	return `page-alert-rows:${reportId.toLowerCase()}|${pageId.toLowerCase()}|${email.toLowerCase()}`;
}

export function alertRowsChanged(reportId: string, pageId?: string): void {
	invalidateDefinitions(
		pageId
			? `page-alert-rows:${reportId.toLowerCase()}|${pageId.toLowerCase()}|`
			: `page-alert-rows:${reportId.toLowerCase()}|`,
	);
}
