// Reports ranked by how many people with the same access open them. Pure, so
// the ranking can be tested without the platform store.

// One person's opens of one report over the window.
export interface PeerOpens {
	reportId: string;
	// Lowercased.
	email: string;
	opens: number;
}

// Opens per report, by reader, for one policy class. Held per class and shared
// by everyone in it, with each reader's own opens left in so they can be taken
// out per reader.
export type PeerUsage = Map<string, Map<string, number>>;

export function peerUsage(rows: PeerOpens[]): PeerUsage {
	const usage: PeerUsage = new Map();
	for (const row of rows) {
		const readers = usage.get(row.reportId) ?? new Map<string, number>();
		readers.set(row.email, (readers.get(row.email) ?? 0) + row.opens);
		usage.set(row.reportId, readers);
	}
	return usage;
}

// The reports other people opened most, with the reader's own opens left out.
// Counted by people first, so one enthusiast opening a report all day does not
// outrank one a whole team reads, then by opens.
export function rankByPeers(
	usage: PeerUsage,
	email: string,
	limit: number,
): string[] {
	const me = email.toLowerCase();
	const ranked: { reportId: string; people: number; opens: number }[] = [];
	for (const [reportId, readers] of usage) {
		let people = 0;
		let opens = 0;
		for (const [reader, count] of readers) {
			if (reader === me) continue;
			people++;
			opens += count;
		}
		if (people === 0) continue;
		ranked.push({ reportId, people, opens });
	}
	ranked.sort(
		(a, b) =>
			b.people - a.people ||
			b.opens - a.opens ||
			a.reportId.localeCompare(b.reportId),
	);
	return ranked.slice(0, limit).map((r) => r.reportId);
}
