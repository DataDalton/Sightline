import type { EditorPanel } from "./editorPanels";

// Where each setting in the editor lives, for searching across panels. Each panel also searches
// its own contents as they are drawn. This is how someone gets to the right panel at all.

export interface EditorSetting {
	label: string;
	where: string;
	panel: EditorPanel;
	section?: string;
	words: string;
}

const visual = "Visual panel";
const page = "Page panel";
const report = "Report panel";

export const editorSettings: EditorSetting[] = [
	{
		label: "Fields",
		where: visual,
		panel: "visual",
		section: "visual-fields",
		words: "dimension measure column series data",
	},
	{
		label: "Filters, top rows and sorting",
		where: visual,
		panel: "visual",
		section: "visual-shaping",
		words: "filter limit sort order top rank compare total period forecast predict ahead",
	},
	{
		label: "Click to drill in",
		where: visual,
		panel: "visual",
		section: "visual-drill",
		words: "drill hierarchy cross filter click descend",
	},
	{
		label: "Wait for a filter",
		where: visual,
		panel: "visual",
		section: "visual-wait",
		words: "require filter choose first",
	},
	{
		label: "Links to other reports",
		where: visual,
		panel: "visual",
		section: "visual-links",
		words: "link navigate click through open report",
	},
	{
		label: "What clicking does",
		where: visual,
		panel: "visual",
		section: "visual-interaction",
		words: "interaction click select cross filter",
	},
	{
		label: "Note on the visual",
		where: visual,
		panel: "visual",
		section: "visual-note",
		words: "note caption text explain tooltip",
	},
	{
		label: "Group",
		where: visual,
		panel: "visual",
		section: "visual-group",
		words: "group popup frame hold parent",
	},
	{
		label: "Labels, density and height",
		where: visual,
		panel: "visual",
		section: "visual-display",
		words: "display labels density height border weight legend",
	},
	{
		label: "Series colours",
		where: visual,
		panel: "visual",
		section: "visual-series",
		words: "series color colour palette line",
	},
	{
		label: "Axes",
		where: visual,
		panel: "visual",
		section: "visual-axes",
		words: "axis axes scale gridline reference",
	},
	{
		label: "Colour rules and appearance",
		where: visual,
		panel: "visual",
		section: "visual-appearance",
		words: "appearance condition rule color colour scale loading",
	},
	{
		label: "Phone layout",
		where: visual,
		panel: "visual",
		section: "visual-phone",
		words: "phone mobile small screen hide",
	},
	{
		label: "Title and frame",
		where: visual,
		panel: "visual",
		section: "visual-chrome",
		words: "title frame chrome border header",
	},
	{
		label: "Page name",
		where: page,
		panel: "page",
		section: "page-details",
		words: "page name title rename details about",
	},
	{
		label: "Data through stamp",
		where: page,
		panel: "page",
		section: "page-stamp",
		words: "stamp data through as of freshness",
	},
	{
		label: "Filters on this page",
		where: page,
		panel: "page",
		section: "page-filters",
		words: "require filter sticky keep in view behaviour behavior",
	},
	{
		label: "When the page is empty",
		where: page,
		panel: "page",
		section: "page-details",
		words: "empty nothing to show text",
	},
	{
		label: "Page alerts",
		where: "Alerts panel",
		panel: "alerts",
		words: "alert notify threshold watch",
	},
	{
		label: "Goals",
		where: "Goals panel",
		panel: "goals",
		words: "goal target due progress",
	},
	{
		label: "Report subtitle",
		where: report,
		panel: "report",
		section: "report-details",
		words: "subtitle description details about",
	},
	{
		label: "Report theme",
		where: report,
		panel: "report",
		section: "report-details",
		words: "theme color colour accent palette brand",
	},
	{
		label: "Tags",
		where: report,
		panel: "report",
		section: "report-details",
		words: "tag tags label rights",
	},
	{
		label: "Who can edit",
		where: "Access panel",
		panel: "access",
		section: "access-editing",
		words: "access permission policy editor maintainers only",
	},
	{
		label: "People and roles",
		where: "Access panel",
		panel: "access",
		section: "access-people",
		words: "access people add someone maintainer editor role group page rights",
	},
	{
		label: "Location",
		where: report,
		panel: "report",
		section: "report-placement",
		words: "category placement move address url slug link location",
	},
	{
		label: "Report file",
		where: report,
		panel: "report",
		section: "report-file",
		words: "export download file package import another workspace",
	},
	{
		label: "Protection and locks",
		where: report,
		panel: "report",
		section: "report-protection",
		words: "protect protection lock unlock",
	},
	{
		label: "Take back or delete",
		where: report,
		panel: "report",
		section: "report-danger",
		words: "delete remove take back draft",
	},
	{
		label: "Walkthroughs",
		where: "Slides panel",
		panel: "present",
		words: "tour walkthrough guide steps spotlight",
	},
	{
		label: "Slides",
		where: "Slides panel",
		panel: "present",
		words: "slide slides deck layout presentation",
	},
	{
		label: "Marks kept on the page",
		where: "Slides panel",
		panel: "present",
		words: "mark callout arrow highlight annotate",
	},
	{
		label: "Report doctor and speed",
		where: "Doctor panel",
		panel: "check",
		words: "check doctor speed xray performance problems",
	},
	{
		label: "Version history",
		where: "History panel",
		panel: "history",
		words: "history version restore undo compare",
	},
];

// Best first. A word at the start of the name beats one inside it, which beats a match on the
// other words someone might use for it.
export function rankSettings(
	query: string,
	settings: EditorSetting[] = editorSettings,
): EditorSetting[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const scored = settings.flatMap((setting) => {
		const label = setting.label.toLowerCase();
		const score = label.startsWith(needle)
			? 0
			: label.includes(` ${needle}`)
				? 1
				: label.includes(needle)
					? 2
					: setting.words.includes(needle)
						? 3
						: null;
		return score === null ? [] : [{ setting, score }];
	});
	return scored.sort((a, b) => a.score - b.score).map((held) => held.setting);
}
