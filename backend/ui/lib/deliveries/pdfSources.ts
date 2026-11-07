import { isPageControl } from "../visuals/catalog";

// Which sources a scheduled PDF reads, and whether it may be drawn while its owner is away.

// Every source the drawn page reads. Page controls and links are left off paper, so what
// they sit on does not count.
export function pageSourceKeys(
	page: {
		sourceKey: string | null;
		visuals: { visualType: string; sourceKey: string | null }[];
	},
	reportSourceKey: string | null,
): string[] {
	const keys = new Set<string>();
	for (const visual of page.visuals) {
		if (isPageControl(visual.visualType)) continue;
		if (visual.visualType === "navLinks") continue;
		const key = visual.sourceKey ?? page.sourceKey ?? reportSourceKey;
		if (key) keys.add(key);
	}
	return [...keys];
}

// Each source on the page has to have been confirmed readable by the owner, and either show
// everybody the same rows or have a usable recording of what the owner sees.
export function pdfMayDrawWhileAway(input: {
	pageSources: string[];
	confirmedSources: string[];
	unattended: string[];
	restrictable: string[];
	recorded: string[];
}): boolean {
	return input.pageSources.every(
		(key) =>
			input.confirmedSources.includes(key) &&
			(input.unattended.includes(key) ||
				(input.restrictable.includes(key) &&
					input.recorded.includes(key))),
	);
}
