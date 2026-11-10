import type { AboutChange, AboutItem } from "./model";

// How an update's about list is shown. Fields sit under their dataset and are grouped by
// what happened to them. Datasets given exactly the same changes are shown once under
// all their names, so ten fields added to two datasets read as one list.

export interface AboutNames {
	source: (key: string) => string;
	category: (id: string) => string;
	report: (id: string) => string;
	page: (id: string) => string;
}

export interface ShownField {
	name: string;
	// A renamed field's old name.
	from?: string;
}

export interface FieldGroup {
	change: AboutChange | null;
	fields: ShownField[];
}

export interface AboutSection {
	// "tables" is several tables of one catalog and schema, named once as that schema with
	// the short table names as its one group.
	kind: "dataset" | "report" | "page" | "category" | "table" | "tables";
	names: string[];
	// What happened to the dataset itself, where that was said.
	change: AboutChange | null;
	groups: FieldGroup[];
}

// Added first, then what moved, then what went, so the list reads in the order a reader
// acts on it. Fields with no change said come last.
const changeOrder: (AboutChange | null)[] = [
	"added",
	"changed",
	"renamed",
	"removed",
	null,
];

const changeWords: Record<AboutChange, string> = {
	added: "Added",
	changed: "Changed",
	renamed: "Renamed",
	removed: "Removed",
};

export function changeWord(change: AboutChange): string {
	return changeWords[change];
}

export function aboutSections(
	about: AboutItem[],
	names: AboutNames,
): AboutSection[] {
	// Each dataset in the order it was first named, with its own change and its fields.
	const datasets = new Map<
		string,
		{ change: AboutChange | null; fields: Map<string, FieldGroup> }
	>();
	const datasetFor = (key: string) => {
		const held = datasets.get(key) ?? {
			change: null,
			fields: new Map<string, FieldGroup>(),
		};
		datasets.set(key, held);
		return held;
	};
	const others: AboutSection[] = [];
	// Tables named by catalog.schema.table, held under their catalog.schema in the order
	// each schema was first named.
	const schemas = new Map<string, AboutSection>();

	for (const item of about) {
		const lastDot = item.kind === "table" ? item.id.lastIndexOf(".") : -1;
		if (lastDot > 0) {
			const schema = item.id.slice(0, lastDot);
			const table = item.id.slice(lastDot + 1);
			const held = schemas.get(schema) ?? {
				kind: "tables" as const,
				names: [schema],
				change: null,
				groups: [{ change: null, fields: [] }],
			};
			if (!schemas.has(schema)) {
				schemas.set(schema, held);
				others.push(held);
			}
			const fields = held.groups[0].fields;
			if (!fields.some((field) => field.name === table)) {
				fields.push({ name: table });
			}
			continue;
		}
		if (item.kind === "source") {
			const dataset = datasetFor(item.id);
			dataset.change = item.change ?? dataset.change;
		} else if (item.kind === "field" && item.sourceKey) {
			const dataset = datasetFor(item.sourceKey);
			const key = item.change ?? "";
			const group = dataset.fields.get(key) ?? {
				change: item.change ?? null,
				fields: [],
			};
			dataset.fields.set(key, group);
			if (
				!group.fields.some(
					(field) =>
						field.name === item.id && field.from === item.from,
				)
			) {
				group.fields.push(
					item.from
						? { name: item.id, from: item.from }
						: { name: item.id },
				);
			}
		} else {
			// A field without its dataset is not accepted any more, and is shown by name.
			const kind = item.kind === "field" ? "table" : item.kind;
			const name =
				item.kind === "category"
					? names.category(item.id)
					: item.kind === "report"
						? names.report(item.id)
						: item.kind === "page"
							? names.page(item.id)
							: item.id;
			if (
				!others.some(
					(other) => other.kind === kind && other.names[0] === name,
				)
			) {
				others.push({ kind, names: [name], change: null, groups: [] });
			}
		}
	}

	// Datasets with the same change and the same fields under the same changes merge.
	const merged = new Map<string, AboutSection>();
	for (const [key, dataset] of datasets) {
		const groups = changeOrder.flatMap((change) => {
			const group = dataset.fields.get(change ?? "");
			return group ? [group] : [];
		});
		const signature = JSON.stringify([dataset.change, groups]);
		const held = merged.get(signature);
		if (held) {
			held.names.push(names.source(key));
		} else {
			merged.set(signature, {
				kind: "dataset",
				names: [names.source(key)],
				change: dataset.change,
				groups,
			});
		}
	}
	// A schema with one table is shown as that table by its full name.
	const shownOthers = others.map((section): AboutSection => {
		const tables = section.groups[0]?.fields ?? [];
		return section.kind === "tables" && tables.length === 1
			? {
					kind: "table",
					names: [`${section.names[0]}.${tables[0].name}`],
					change: null,
					groups: [],
				}
			: section;
	});
	return [...merged.values(), ...shownOthers];
}

// "A", "A and B", "A, B and C".
export function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function fieldText(field: ShownField): string {
	return field.from ? `${field.from} to ${field.name}` : field.name;
}

// One line of plain text for a timeline card or an export, naming every field.
export function aboutLine(sections: AboutSection[]): string {
	return sections
		.map((section) => {
			const head = section.change
				? `${joinNames(section.names)} (${changeWords[section.change].toLowerCase()})`
				: joinNames(section.names);
			if (section.groups.length === 0) return head;
			const body = section.groups
				.map((group) => {
					const fields = group.fields.map(fieldText).join(", ");
					return group.change
						? `${changeWords[group.change]}: ${fields}`
						: fields;
				})
				.join(". ");
			return `${head}. ${body}`;
		})
		.join("; ");
}
