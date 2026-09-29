import {
	isPageControl,
	visualByType,
	visualCatalog,
	type VisualOption,
} from "../../visuals/catalog";
import { gridColumns } from "../../visuals/layout";
import {
	describeProblems,
	hasError,
	validateVisual,
} from "../../visuals/validate";
import type { SemanticSource } from "../../semantic/types";
import {
	asRecord,
	describeState,
	filterSchema,
	operators,
	refusal,
	requireField,
	sourceFor,
	stringList,
	SurfaceRefused,
	text,
	type Surface,
} from "./shared";

// Building and changing a report page from a description.
//
// The model sends a list of edits: add a visual, change one, take one off,
// rename the page, start a new page. Each visual is checked with the same
// validation the editor's save runs, against the fields of the dataset it
// reads, so a chart that could not be drawn never reaches the canvas. The
// accepted edits go into the editor's unsaved draft as one step the author can
// undo, and nothing is published until the author publishes it.

// Visuals the assistant may place. Groups hold other visuals by reference and
// a notice is written by the platform, so neither is something to design with.
const excluded = new Set(["group", "blockedNotice"]);

export const editableTypes = visualCatalog
	.map((v) => v.type)
	.filter((t) => !excluded.has(t));

export interface EditorVisual {
	visualId: string;
	visualType: string;
	title: string | null;
	sourceKey: string | null;
	config: Record<string, unknown>;
	// Absent where the model left placement to the editor, which finds a free
	// place for it on the grid.
	layout: { x: number; y: number; w: number; h: number } | null;
}

export type EditorOp =
	| { op: "newPage"; title: string }
	| { op: "add"; visual: EditorVisual }
	| { op: "update"; visual: EditorVisual }
	| { op: "remove"; visualId: string }
	| { op: "page"; title: string }
	| { op: "tidy" };

export interface EditorState {
	reportTitle: string;
	pageTitle: string;
	pageSourceKey: string | null;
	readOnly: boolean;
	canAddPage: boolean;
	// Unsaved changes on the page open, which a new page would lose.
	dirty: boolean;
	visuals: EditorVisual[];
}

export function readEditorState(raw: unknown): EditorState {
	const s = asRecord(raw);
	const visuals = (Array.isArray(s.visuals) ? s.visuals : [])
		.map(asRecord)
		.slice(0, 120)
		.map(
			(v): EditorVisual => ({
				visualId: text(v.visualId, 80),
				visualType: text(v.visualType, 60),
				title: text(v.title, 200) || null,
				sourceKey: text(v.sourceKey, 200) || null,
				config: asRecord(v.config),
				layout: readLayout(v.layout),
			}),
		)
		.filter((v) => v.visualId && v.visualType);
	return {
		reportTitle: text(s.reportTitle, 200),
		pageTitle: text(s.pageTitle, 200),
		pageSourceKey: text(s.pageSourceKey, 200) || null,
		readOnly: s.readOnly === true,
		canAddPage: s.canAddPage !== false,
		dirty: s.dirty === true,
		visuals,
	};
}

function whole(value: unknown, min: number, max: number): number | null {
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	return Math.min(max, Math.max(min, Math.round(n)));
}

function readLayout(raw: unknown): EditorVisual["layout"] {
	const r = asRecord(raw);
	const w = whole(r.w, 1, gridColumns);
	const h = whole(r.h, 1, 40);
	const x = whole(r.x, 0, gridColumns - 1);
	const y = whole(r.y, 0, 400);
	if (w === null || h === null || x === null || y === null) return null;
	return { x: Math.min(x, gridColumns - w), y, w, h };
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// A text panel's words as the panel stores them, one paragraph per blank
// line. Written as plain text by the model and escaped here, so nothing it
// writes is read as markup.
export function textToHtml(value: string): string {
	return value
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

function describeOption(option: VisualOption): string | null {
	switch (option.kind) {
		case "select":
			return `${option.key} (${option.choices.map((c) => c.value || '""').join("|")})`;
		case "toggle":
			return `${option.key} (true|false)`;
		case "number":
			return `${option.key} (number)`;
		case "text":
			return `${option.key} (text)`;
		default:
			return null;
	}
}

function visualMenu(): string {
	return visualCatalog
		.filter((v) => !excluded.has(v.type))
		.map((v) => {
			const options = (v.options ?? [])
				.map(describeOption)
				.filter(Boolean)
				.join(", ");
			const where = isPageControl(v.type)
				? " Sits on the filter strip above the page, so its layout is ignored."
				: ` Default size ${v.defaultLayout.w}x${v.defaultLayout.h}.`;
			return `  ${v.type}: ${v.label}. ${v.guidance} Takes ${v.encoding.dimensions.min}-${v.encoding.dimensions.max} dimensions and ${v.encoding.measures.min}-${v.encoding.measures.max} measures.${where}${options ? ` Options: ${options}.` : ""}`;
		})
		.join("\n");
}

const visualProperties = {
	visualType: { type: "string", enum: editableTypes },
	title: { type: "string" },
	sourceKey: {
		type: "string",
		description: "The dataset it reads. Defaults to the page's.",
	},
	dimensions: { type: "array", items: { type: "string" } },
	measures: { type: "array", items: { type: "string" } },
	filters: {
		type: "array",
		items: filterSchema,
		description: "Filters on this visual alone, on top of the page's.",
	},
	sort: {
		type: "array",
		items: {
			type: "object",
			properties: {
				field: { type: "string" },
				direction: { type: "string", enum: ["asc", "desc"] },
			},
			required: ["field", "direction"],
		},
	},
	options: {
		type: "object",
		description: "Settings from the visual's option list, by key.",
	},
	text: {
		type: "string",
		description:
			"For textPanel, the words it shows as plain text. Blank lines separate paragraphs.",
	},
	layout: {
		type: "object",
		properties: {
			x: { type: "integer" },
			y: { type: "integer" },
			w: { type: "integer" },
			h: { type: "integer" },
		},
		description: `Place on the grid of ${gridColumns} columns: x and w in columns, y and h in rows. Leave out to put it in the next free place.`,
	},
};

const tool = {
	type: "function" as const,
	function: {
		name: "edit_page",
		description:
			"Change the report page open in the editor, in order. The edits go into the author's unsaved draft as one step they can undo.",
		parameters: {
			type: "object",
			properties: {
				operations: {
					type: "array",
					items: {
						type: "object",
						properties: {
							op: {
								type: "string",
								enum: [
									"new_page",
									"add_visual",
									"update_visual",
									"remove_visual",
									"rename_page",
									"tidy",
								],
								description:
									"new_page starts a blank page and must come first. update_visual changes only the properties given. tidy closes gaps and levels rows.",
							},
							visualId: {
								type: "string",
								description:
									"For update_visual and remove_visual.",
							},
							...visualProperties,
						},
						required: ["op"],
					},
				},
			},
			required: ["operations"],
		},
	},
};

function newId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ?? `v${Date.now()}${Math.random()}`
	);
}

// A visual as the model described it, over what it was before, checked.
function buildVisual(
	args: Record<string, unknown>,
	base: EditorVisual | null,
	fallbackSource: string | null,
	available: SemanticSource[],
): EditorVisual {
	const visualType = text(args.visualType, 60) || base?.visualType || "";
	const definition = visualByType[visualType];
	if (!definition || excluded.has(visualType)) {
		throw new SurfaceRefused(
			`"${visualType || "(none)"}" is not a visual that can be placed. Choose one of the listed types.`,
		);
	}

	const config: Record<string, unknown> = { ...(base?.config ?? {}) };
	const readsData =
		definition.encoding.dimensions.max > 0 ||
		definition.encoding.measures.max > 0;

	let sourceKey: string | null = null;
	let source: SemanticSource | null = null;
	if (readsData) {
		source = sourceFor(
			available,
			args.sourceKey ?? base?.sourceKey ?? fallbackSource,
		);
		sourceKey = source.sourceKey;
	}

	if (args.dimensions !== undefined) {
		config.dimensions = stringList(args.dimensions);
	}
	if (args.measures !== undefined)
		config.measures = stringList(args.measures);
	config.dimensions ??= [];
	config.measures ??= [];
	// The shared validation only warns about an unknown field, since a page
	// may outlive a field. A new draft has no such excuse.
	if (source) {
		for (const d of config.dimensions as string[]) {
			if (!d.startsWith("<")) requireField(source, d, "dimension");
		}
		for (const m of config.measures as string[]) {
			requireField(source, m, "measure");
		}
	}

	if (args.filters !== undefined) {
		const filters = (Array.isArray(args.filters) ? args.filters : [])
			.map(asRecord)
			.slice(0, 40)
			.map((f) => {
				const values = stringList(f.values, 200);
				return {
					field: text(f.field, 200),
					op: operators.includes(String(f.op)) ? String(f.op) : "eq",
					...(values.length
						? { values }
						: typeof f.value === "string"
							? { value: f.value.slice(0, 500) }
							: {}),
					...(f.negate === true ? { negate: true } : {}),
				};
			})
			.filter((f) => f.field);
		if (source) for (const f of filters) requireField(source, f.field);
		config.filters = filters;
	}
	config.filters ??= [];

	if (args.sort !== undefined) {
		const sort = (Array.isArray(args.sort) ? args.sort : [])
			.map(asRecord)
			.slice(0, 5)
			.map((s) => ({
				field: text(s.field, 200),
				direction: s.direction === "asc" ? "asc" : "desc",
			}))
			.filter((s) => s.field);
		if (source) for (const s of sort) requireField(source, s.field);
		config.sort = sort;
	}
	config.sort ??= [];

	const options: Record<string, unknown> = {
		...asRecord(config.options),
		...asRecord(args.options),
	};
	if (visualType === "textPanel" && typeof args.text === "string") {
		options.html = textToHtml(args.text.slice(0, 4000));
	}
	if (Object.keys(options).length > 0) config.options = options;
	else delete config.options;

	const problems = validateVisual(
		visualType,
		config,
		source
			? {
					dimensions: source.dimensions.map((f) => f.name),
					measures: source.measures.map((f) => f.name),
				}
			: null,
	);
	if (hasError(problems)) {
		throw new SurfaceRefused(describeProblems(problems));
	}

	const title =
		args.title !== undefined
			? text(args.title, 200) || null
			: (base?.title ?? definition.label);

	return {
		visualId: base?.visualId ?? newId(),
		visualType,
		title,
		sourceKey,
		config,
		layout:
			args.layout !== undefined
				? readLayout(args.layout)
				: (base?.layout ?? null),
	};
}

export function editorSurface(
	state: unknown,
	available: SemanticSource[],
): Surface {
	const page = readEditorState(state);
	// The page as the edits so far have left it, so a second call in the same
	// answer can change a visual the first one added.
	let visuals = [...page.visuals];
	let startedPage = false;

	return {
		kind: "editor",
		preferredSourceKey: page.pageSourceKey,
		tools: page.readOnly ? [] : [tool],
		instructions: [
			`The person is editing the report "${page.reportTitle}" in the report editor, on the page "${page.pageTitle}".`,
			page.readOnly
				? "This page is locked against changes, so you cannot edit it. Say so if they ask."
				: "They want you to build or change the page for them with edit_page.",
			page.pageSourceKey
				? `The page reads the dataset ${page.pageSourceKey} unless a visual names another.`
				: "",
			`What is on the page now: ${describeState(
				visuals.map((v) => ({
					visualId: v.visualId,
					visualType: v.visualType,
					title: v.title,
					sourceKey: v.sourceKey,
					dimensions: v.config.dimensions,
					measures: v.config.measures,
					filters: v.config.filters,
					options: v.config.options,
					layout: v.layout,
				})),
			)}`,
			"How to build a page:",
			"- Read each dataset with describe_source before using its fields, and use names exactly as listed. Choose the measure whose definition fits.",
			`- The page is a grid ${gridColumns} columns wide. Put a row of headline figures (kpiRow, full width) at the top, then charts side by side, often two to a row at w 6, then detail tables full width at the bottom. Leave layout out when the default place is fine.`,
			"- A trend over time is a lineChart or areaChart by a date dimension. A ranking is a horizontalBarChart with the options topN and topBy, which keep the largest few by that measure. A share of a whole is a donutChart with few slices.",
			"- Filters that apply to the whole page are controls such as dateRangeFilter and dropdownFilter. They sit on the filter strip.",
			"- Give every visual a short title that says what it shows.",
			page.dirty
				? "- The page open has unsaved changes, so new_page is refused until they publish or discard them."
				: page.canAddPage
					? "- To design a new page, start with new_page and its title, then add its visuals in the same call."
					: "- New pages cannot be added to this report.",
			"- Call edit_page with every edit for the request in one list where you can. If it is refused, read the reason, correct it and call again.",
			"- Then reply with one or two short sentences saying what you changed. The canvas shows it, the author can undo it in one step, and nothing is published until they publish.",
			"Visuals:",
			visualMenu(),
		]
			.filter(Boolean)
			.join("\n"),
		label: (_name, args) => {
			const count = Array.isArray(args.operations)
				? args.operations.length
				: 0;
			return count === 1
				? "Changing the page"
				: `Making ${count} changes to the page`;
		},
		run: (_name, args) => {
			try {
				if (page.readOnly) {
					throw new SurfaceRefused(
						"This page is locked against changes.",
					);
				}
				const raw = (
					Array.isArray(args.operations) ? args.operations : []
				)
					.map(asRecord)
					.slice(0, 60);
				if (raw.length === 0) {
					throw new SurfaceRefused("Give at least one operation.");
				}

				let working = [...visuals];
				const ops: EditorOp[] = [];
				const done: string[] = [];

				raw.forEach((item, index) => {
					const kind = text(item.op, 40);
					const at = `Operation ${index + 1} (${kind || "no op"})`;
					try {
						if (kind === "new_page") {
							if (index !== 0) {
								throw new SurfaceRefused(
									"new_page must come first.",
								);
							}
							if (startedPage) {
								throw new SurfaceRefused(
									"A new page was already started in this answer. Add to it instead.",
								);
							}
							if (!page.canAddPage) {
								throw new SurfaceRefused(
									"This report does not allow new pages.",
								);
							}
							if (page.dirty) {
								throw new SurfaceRefused(
									"The page open has unsaved changes. Ask the author to publish or discard them first.",
								);
							}
							const title = text(item.title, 120);
							if (!title)
								throw new SurfaceRefused(
									"Give the page a title.",
								);
							working = [];
							ops.push({ op: "newPage", title });
							done.push(`started the page "${title}"`);
							return;
						}
						if (kind === "add_visual") {
							const visual = buildVisual(
								item,
								null,
								page.pageSourceKey,
								available,
							);
							working.push(visual);
							ops.push({ op: "add", visual });
							done.push(
								`added ${visual.visualType} "${visual.title ?? ""}" as ${visual.visualId}`,
							);
							return;
						}
						if (
							kind === "update_visual" ||
							kind === "remove_visual"
						) {
							const id = text(item.visualId, 80);
							const existing = working.find(
								(v) => v.visualId === id,
							);
							if (!existing) {
								throw new SurfaceRefused(
									`There is no visual ${id || "(no id)"} on the page.`,
								);
							}
							if (kind === "remove_visual") {
								working = working.filter(
									(v) => v.visualId !== id,
								);
								ops.push({ op: "remove", visualId: id });
								done.push(`removed ${id}`);
								return;
							}
							const visual = buildVisual(
								item,
								existing,
								page.pageSourceKey,
								available,
							);
							working = working.map((v) =>
								v.visualId === id ? visual : v,
							);
							ops.push({ op: "update", visual });
							done.push(`changed ${id}`);
							return;
						}
						if (kind === "rename_page") {
							const title = text(item.title, 120);
							if (!title)
								throw new SurfaceRefused(
									"Give the page a title.",
								);
							ops.push({ op: "page", title });
							done.push(`renamed the page "${title}"`);
							return;
						}
						if (kind === "tidy") {
							ops.push({ op: "tidy" });
							done.push("tidied the layout");
							return;
						}
						throw new SurfaceRefused(
							`"${kind}" is not an operation.`,
						);
					} catch (error) {
						throw new SurfaceRefused(
							`${at}: ${error instanceof Error ? error.message : "refused"} Nothing in this call was applied.`,
						);
					}
				});

				if (ops[0]?.op === "newPage") startedPage = true;
				visuals = working;
				return {
					ok: true,
					summary:
						done.length === 1 ? done[0] : `${done.length} changes`,
					result: `Applied to the draft: ${done.join("; ")}.`,
					draft: ops,
				};
			} catch (error) {
				return refusal(error);
			}
		},
	};
}
