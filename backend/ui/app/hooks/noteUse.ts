// Tells the server a page of a report was shown, or a visual on it used, for
// the report's maintainers. Sent without waiting on the answer, and never
// retried, since a missed figure costs nothing a reader would notice.
//
// The same event is sent once a minute at most, so a chart clicked through or
// a page flicked back to repeatedly counts as one look rather than many.

const quietMs = 60_000;
const lastSent = new Map<string, number>();

export function noteUse(event: {
	reportId: string;
	pageId: string;
	visualId?: string;
	action?: "expand" | "figures" | "notes" | "select";
}): void {
	const key = `${event.reportId}:${event.pageId}:${event.visualId ?? ""}:${event.action ?? ""}`;
	const now = Date.now();
	if (now - (lastSent.get(key) ?? 0) < quietMs) return;
	lastSent.set(key, now);

	void fetch("/api/report-use/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(event),
		keepalive: true,
	}).catch(() => {});
}
