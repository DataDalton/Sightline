// Plain sentences for a batch of report edits, so whoever is asked to approve a
// suggested change reads what it does rather than a list of operations.
//
// Pure, so the wording can be tested. Repeats are folded, because moving twelve
// visuals is one thing to decide about rather than twelve.

export interface OperationSummaryInput {
	type: string;
	visualId?: string;
	pageId?: string;
	title?: string | null;
	visualType?: string;
	description?: string | null;
	theme?: string | null;
}

export function describeOperations(
	operations: OperationSummaryInput[],
	titleOf: (visualId: string) => string | null,
	// The report as it stands, so a change to it can say what actually differs.
	current?: { description?: string | null; theme?: string | null },
): string[] {
	const lines: string[] = [];
	const say = (line: string) => {
		if (!lines.includes(line)) lines.push(line);
	};
	const named = (op: OperationSummaryInput) => {
		const title =
			(op.visualId ? titleOf(op.visualId.toLowerCase()) : null) ??
			op.title;
		return title ? `"${title}"` : "a visual";
	};

	for (const op of operations) {
		switch (op.type) {
			case "addVisual":
				say(
					op.title
						? `Adds "${op.title}"`
						: `Adds a ${(op.visualType ?? "visual").replace(/_/g, " ")}`,
				);
				break;
			case "removeVisual":
				say(`Removes ${named(op)}`);
				break;
			case "updateVisual":
				say(`Changes ${named(op)}`);
				break;
			case "reorderVisuals":
				say("Rearranges a page");
				break;
			case "addPage":
				say(op.title ? `Adds a page, "${op.title}"` : "Adds a page");
				break;
			case "removePage":
				say("Removes a page");
				break;
			case "updatePage":
				say(
					op.title
						? `Changes the page "${op.title}"`
						: "Changes a page's settings",
				);
				break;
			case "reorderPages":
				say("Puts the pages in a new order");
				break;
			case "updateReport": {
				if (!current) {
					say("Changes the report's subtitle or theme");
					break;
				}
				if ((op.description ?? "") !== (current.description ?? "")) {
					say(
						op.description
							? `Changes the subtitle to "${op.description}"`
							: "Removes the subtitle",
					);
				}
				if ((op.theme ?? "") !== (current.theme ?? "")) {
					say(
						op.theme
							? "Changes the theme"
							: "Goes back to the app's own colours",
					);
				}
				break;
			}
			default:
				say("Makes another change to the report");
		}
	}
	return lines;
}
