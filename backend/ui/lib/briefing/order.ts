// The order the briefing reads a person's reports in. Pure, so the order
// can be tested without the platform store.

export interface BriefingReport {
	reportId: string;
	slug: string;
	title: string;
	categoryId: string | null;
	// Why it is near the top of the reader's list. Null for a report taken
	// only because the reader can open it.
	why: "favourite" | "yours" | "frequent" | "popular" | null;
}

export interface Candidate {
	reportId: string;
	slug: string;
	title: string;
	categoryId: string | null;
}

// The reader's reports in the order the briefing reads them. Most people read
// curated reports and build nothing themselves, so after their own marks the
// order comes from use, with what they open most, then what the people who share
// their access open most, so somebody new to a team starts on what their
// colleagues watch. Everything else they can open follows.
export function orderReports(
	visible: Candidate[],
	lists: {
		favourites: string[];
		yours: string[];
		frequent: string[];
		popular: string[];
	},
): BriefingReport[] {
	const byId = new Map(visible.map((r) => [r.reportId, r]));
	const out: BriefingReport[] = [];
	const taken = new Set<string>();
	const add = (id: string, why: BriefingReport["why"]) => {
		const report = byId.get(id);
		if (!report || taken.has(id)) return;
		taken.add(id);
		out.push({ ...report, why });
	};
	for (const id of lists.favourites) add(id, "favourite");
	for (const id of lists.yours) add(id, "yours");
	for (const id of lists.frequent) add(id, "frequent");
	for (const id of lists.popular) add(id, "popular");
	for (const report of visible) add(report.reportId, null);
	return out;
}
