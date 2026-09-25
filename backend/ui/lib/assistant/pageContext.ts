import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { getReport } from "../platform/reports";
import type { SemanticSource } from "../semantic/types";
import type { PageContext } from "./agent";

// What the person asking is looking at, in words the model can use.
//
// The assistant is opened from any page, and a question asked from a report is
// usually about that report: "why is this down", "what's driving the second
// chart". Without this it has to ask which report, or guess from the whole
// catalogue. With it, the report, the open page, its charts and the datasets
// behind them are named up front.
//
// Read through getReport, so a report the person cannot open describes nothing
// and the assistant is told nothing about it.

const reportPath = /^\/r\/([^/?#]+)/;

// Charts listed per page. Enough to resolve "the second chart", few enough
// that a crowded page does not crowd out the question.
const maxVisuals = 20;

export async function describePage(
	identity: Identity,
	policy: PolicyClass,
	path: string,
	title: string,
	available: SemanticSource[],
): Promise<PageContext | null> {
	const match = reportPath.exec(path);
	if (!match) return null;

	const report = await getReport(
		policy,
		identity,
		decodeURIComponent(match[1]),
	).catch(() => null);
	if (!report) return null;

	// The page open is the one whose title the browser tab carries. Without a
	// match the first page stands in, which is the page a report opens on.
	const page =
		report.pages.find((p) => title.includes(p.title)) ?? report.pages[0];

	const readable = new Map(available.map((s) => [s.sourceKey, s]));
	const sourceKeys = new Set<string>();
	const note = (key: string | null | undefined) => {
		if (key && readable.has(key)) sourceKeys.add(key);
	};
	note(report.sourceKey);
	for (const p of report.pages) note(p.sourceKey);
	for (const v of page?.visuals ?? []) note(v.sourceKey);

	const charts = (page?.visuals ?? [])
		.filter((v) => (v.config.measures?.length ?? 0) > 0)
		.slice(0, maxVisuals)
		.map((v, i) => {
			const fields = [
				...(v.config.measures ?? []),
				...(v.config.dimensions?.length
					? [`by ${v.config.dimensions.join(", ")}`]
					: []),
			].join(" ");
			return `${i + 1}. ${v.title ?? v.visualType} (${v.visualType}: ${fields})`;
		});

	const lines = [
		`They are viewing the report "${report.title}"${report.description ? `, described as: ${report.description}` : ""}.`,
		page
			? `The open page is "${page.title}". Other pages: ${
					report.pages
						.filter((p) => p !== page)
						.map((p) => `"${p.title}"`)
						.join(", ") || "none"
				}.`
			: "",
		charts.length ? `Charts on the open page:\n${charts.join("\n")}` : "",
		sourceKeys.size
			? `It is built on: ${[...sourceKeys]
					.map((k) => `${k} (${readable.get(k)?.title})`)
					.join(
						", ",
					)}. When they say "this" or "here", start from these.`
			: "",
	].filter(Boolean);

	// Each visual as a query, by id. Looked up when somebody points at one, so
	// the assistant knows exactly what it shows rather than guessing from the
	// text on screen.
	const visuals: Record<string, string> = {};
	for (const p of report.pages) {
		for (const v of p.visuals) {
			const source = v.sourceKey ?? p.sourceKey ?? report.sourceKey;
			const measures = v.config.measures ?? [];
			const dimensions = v.config.dimensions ?? [];
			const filters = (v.config.filters ?? [])
				.map((f) => {
					const c = f as {
						field?: string;
						op?: string;
						value?: string;
						values?: string[];
					};
					const value = c.values?.length
						? c.values.join(" or ")
						: (c.value ?? "");
					return c.field
						? `${c.field} ${c.op ?? ""} ${value}`.trim()
						: "";
				})
				.filter(Boolean);
			visuals[v.visualId] = [
				`"${v.title ?? v.visualType}", a ${v.visualType} on page "${p.title}"`,
				source ? `from dataset ${source}` : "",
				measures.length ? `measuring ${measures.join(", ")}` : "",
				dimensions.length ? `by ${dimensions.join(", ")}` : "",
				filters.length ? `where ${filters.join(" and ")}` : "",
			]
				.filter(Boolean)
				.join(", ");
		}
	}

	return {
		description: lines.join("\n"),
		preferredSources: [...sourceKeys],
		visuals,
	};
}
