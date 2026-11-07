// A report as a file, for moving it between environments such as dev to prod. Holds what it
// is, never its data, and stands alone, so nothing in it depends on ids from where it came.
//
// Pure, so what travels and what an import checks can be tested.

export const packageFormat = 1;

export interface PackagedVisual {
	localId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: Record<string, unknown>;
	layout: { x: number; y: number; w: number; h: number } | null;
}

export interface PackagedPage {
	title: string;
	sourceKey: string | null;
	config: Record<string, unknown>;
	visuals: PackagedVisual[];
}

export interface ReportPackage {
	format: number;
	title: string;
	description: string | null;
	theme: string | null;
	sourceKey: string | null;
	pages: PackagedPage[];
}

interface SourceReport {
	title: string;
	description?: string | null;
	theme?: string | null;
	sourceKey?: string | null;
	pages: {
		title: string;
		sourceKey?: string | null;
		config?: Record<string, unknown>;
		visuals: {
			visualId: string;
			visualType: string;
			title?: string | null;
			sourceKey?: string | null;
			config?: Record<string, unknown>;
			layout?: PackagedVisual["layout"];
		}[];
	}[];
}

// A reference to something that only exists here means nothing somewhere else, so a block
// link goes and the visual keeps what it shows.
function portableConfig(config: Record<string, unknown>) {
	const { blockRef: _block, ...rest } = config;
	return rest;
}

export function packReport(report: SourceReport): ReportPackage {
	return {
		format: packageFormat,
		title: report.title,
		description: report.description ?? null,
		theme: report.theme ?? null,
		sourceKey: report.sourceKey ?? null,
		pages: report.pages.map((page) => ({
			title: page.title,
			sourceKey: page.sourceKey ?? null,
			config: page.config ?? {},
			visuals: page.visuals.map((visual) => ({
				localId: visual.visualId,
				visualType: visual.visualType,
				title: visual.title ?? null,
				sourceKey: visual.sourceKey ?? null,
				config: portableConfig(visual.config ?? {}),
				layout: visual.layout ?? null,
			})),
		})),
	};
}

export class PackageError extends Error {}

export function readPackage(raw: unknown): ReportPackage {
	const held = raw as Partial<ReportPackage> | null;
	if (!held || typeof held !== "object" || !Array.isArray(held.pages)) {
		throw new PackageError("That is not a report file.");
	}
	if (held.format !== packageFormat) {
		throw new PackageError(
			`That file is format ${held.format}, and this app reads format ${packageFormat}.`,
		);
	}
	if (typeof held.title !== "string" || !held.title.trim()) {
		throw new PackageError("That report file has no title.");
	}
	if (held.pages.length === 0) {
		throw new PackageError("That report file has no pages.");
	}
	return held as ReportPackage;
}

// What does not exist here, said before anything is created, since a report arriving with
// broken charts is worse than one that says what it needs.
export function missingHere(
	pack: ReportPackage,
	known: Map<string, { dimensions: string[]; measures: string[] }>,
): string[] {
	const out = new Set<string>();
	const check = (sourceKey: string | null, fields: unknown) => {
		if (!sourceKey) return;
		const source = known.get(sourceKey);
		if (!source) {
			out.add(`The source ${sourceKey} is not registered here.`);
			return;
		}
		if (!Array.isArray(fields)) return;
		const all = new Set([...source.dimensions, ...source.measures]);
		for (const field of fields) {
			if (
				typeof field === "string" &&
				!field.startsWith("<") &&
				!all.has(field)
			) {
				out.add(`${sourceKey} has no field called ${field} here.`);
			}
		}
	};
	if (pack.sourceKey) check(pack.sourceKey, []);
	for (const page of pack.pages) {
		for (const visual of page.visuals) {
			const key = visual.sourceKey ?? page.sourceKey ?? pack.sourceKey;
			check(key, visual.config?.dimensions);
			check(key, visual.config?.measures);
		}
	}
	return [...out];
}

// Each visual's new id, swapped in wherever the package refers to one, such as a group
// holding a visual or a mark on it.
export function remapIds<T>(value: T, ids: Map<string, string>): T {
	if (typeof value === "string") {
		return (ids.get(value) ?? value) as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => remapIds(item, ids)) as T;
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				remapIds(item, ids),
			]),
		) as T;
	}
	return value;
}
