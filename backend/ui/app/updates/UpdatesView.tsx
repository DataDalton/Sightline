"use client";

import { TabStrip } from "../components/shared/TabStrip";
import { EmptyState, emptyIcons } from "../components/shared/EmptyState";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Modal } from "../components/shared/Modal";
import { Select } from "../components/shared/Select";
import { Toggle } from "../components/shared/Toggle";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { TextPanel } from "../visuals/TextPanel";
import Link from "../components/AppLink";
import {
	aboutSections,
	changeWord,
	joinNames,
	type AboutNames,
	type AboutSection,
} from "../../lib/updates/aboutDisplay";
import {
	currentWindow,
	sourcesOf,
	type AboutChange,
	type AboutItem,
	type Author,
	type Delivery,
	type Follow,
	type Update,
	type UpdateTypeDefinition,
} from "../../lib/updates/model";
import form from "../authoring/Authoring.module.css";
import styles from "./Updates.module.css";

// The Updates page. A timeline with filters and search, a maintenance calendar, what each
// reader follows, and for those who may, posting and looking after types and templates.

// Authors and poster in words, as the API sends them.
type Named = {
	authorsShown?: (Author & { matched: boolean })[];
	poster?: string;
};

// "Jane Doe", "Jane Doe and Sam Lee", "Jane Doe, Sam Lee and Pat Kim".
function byline(authors: { name: string }[]): string {
	const names = authors.map((author) => author.name);
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Up to two initials for a name, for the mark beside a note.
function initialsOf(name: string): string {
	const words = name.split(/[\s.@_-]+/).filter(Boolean);
	return words
		.slice(0, 2)
		.map((word) => word.charAt(0).toUpperCase())
		.join("");
}

function isPast(iso: string | null | undefined): boolean {
	return Boolean(iso) && new Date(iso as string).getTime() <= Date.now();
}

type ListedUpdate = Update &
	Named & {
		read: boolean;
		acknowledged: boolean;
		// Present only for the poster and moderators, on an update asking for acknowledgement.
		acks: number | null;
	};

interface Answer {
	updates: ListedUpdate[];
	types: UpdateTypeDefinition[];
	follows: Follow[];
	drafts: Update[];
	templates: {
		templateId: string;
		name: string;
		type: string;
		fields: Record<string, unknown>;
	}[];
	quietSources: string[];
	canPost: boolean;
	canModerate: boolean;
}

interface Detail {
	update: Update & Named;
	history: {
		kind: string;
		by_email: string;
		by_name?: string;
		at: string;
		note: string | null;
		snapshot: { title?: string } | null;
	}[];
	affects: { slug: string; title: string }[];
	acknowledgedBy: string[] | null;
}

// How many reports are named before the rest wait behind a click.
const reportsNamed = 3;

function ReportsAffected({
	reports,
}: {
	reports: { slug: string; title: string }[];
}) {
	const [all, setAll] = useState(false);
	const shown = all ? reports : reports.slice(0, reportsNamed);
	const left = reports.length - shown.length;
	return (
		<span>
			{shown.map((report, index) => (
				<span key={report.slug}>
					{index > 0 &&
						(index === shown.length - 1 && left === 0
							? " and "
							: ", ")}
					<Link
						className={styles.factLink}
						href={`/r/${report.slug}`}
					>
						{report.title}
					</Link>
				</span>
			))}
			{left > 0 && (
				<>
					{" and "}
					<button
						type="button"
						className={styles.factMore}
						onClick={() => setAll(true)}
					>
						{left} more
					</button>
				</>
			)}
		</span>
	);
}

const audienceWords: Record<string, string> = {
	readers: "Whoever can read the source",
	everyone: "Everyone",
	groups: "Groups",
	category: "Readers of a category",
	source: "Readers of a source",
	report: "Readers of a report",
};

const historyWords: Record<string, string> = {
	created: "Posted",
	published: "Published",
	corrected: "Corrected",
	retracted: "Retracted",
	investigating: "Investigating",
	identified: "Identified",
	resolved: "Resolved",
	note: "Note",
};

// A group of settings, closed until wanted and saying what it holds while closed.
function ComposerGroup({
	title,
	summary,
	startOpen = false,
	children,
}: {
	title: string;
	summary: string;
	startOpen?: boolean;
	children: React.ReactNode;
}) {
	return (
		<details className={styles.group} open={startOpen || undefined}>
			<summary className={styles.groupHead}>
				<svg
					className={styles.groupChevron}
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M9 18l6-6-6-6" />
				</svg>
				<span className={styles.groupWords}>
					<strong>{title}</strong>
					<span className={styles.groupSummary}>{summary}</span>
				</span>
			</summary>
			<div className={styles.groupBody}>{children}</div>
		</details>
	);
}

async function post(body: Record<string, unknown>) {
	const response = await fetch("/api/changes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const detail = await response.json().catch(() => null);
	if (!response.ok) throw new Error(detail?.error ?? "That did not work.");
	return detail;
}

function when(iso: string | null): string {
	if (!iso) return "";
	return new Date(iso).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function toLocalInput(iso: string | null | undefined): string {
	if (!iso) return "";
	const at = new Date(iso);
	return new Date(at.getTime() - at.getTimezoneOffset() * 60000)
		.toISOString()
		.slice(0, 16);
}

const deliveryWords: [keyof Delivery, string][] = [
	["banner", "Banner across the app"],
	["popup", "One-time pop-up"],
	["home", "Card on Home"],
	["inbox", "Inbox"],
	["push", "Phone and desktop push"],
	["page", "On the pages it affects"],
];

function TypeBadge({
	type,
	types,
}: {
	type: string;
	types: UpdateTypeDefinition[];
}) {
	const found = types.find((t) => t.typeId === type);
	return (
		<span
			className={styles.badge}
			style={{ borderColor: found?.color, color: found?.color }}
		>
			{found?.label ?? type}
		</span>
	);
}

type Draft = Record<string, unknown> & {
	type: string;
	updateId?: string;
	delivery: Delivery;
	about: AboutItem[];
};

// What the caller can see, with whether they may post about each. Following and choosing
// an audience use everything listed. Attaching an update offers only what may be posted.
export interface UpdateChoices {
	postsEverywhere?: boolean;
	people?: { email: string; name: string }[];
	sources: {
		key: string;
		title: string;
		fields: string[];
		canPost?: boolean;
	}[];
	categories: { id: string; name: string; canPost?: boolean }[];
	reports: {
		id: string;
		title: string;
		canPost?: boolean;
		canPostReportChange?: boolean;
		pages: { id: string; title: string }[];
	}[];
}

function useUpdateChoices(): UpdateChoices | undefined {
	const { data } = useSWR<UpdateChoices>("/api/changes?choices=1");
	return data;
}

// Names for what an update is about, from the lists this caller can see. Anything not
// listed, such as a dataset the caller cannot read, shows by its key.
function aboutNames(choices: UpdateChoices | undefined): AboutNames {
	const reports = choices?.reports ?? [];
	return {
		source: (key) =>
			choices?.sources.find((s) => s.key === key)?.title ?? key,
		category: (id) =>
			choices?.categories.find((c) => c.id === id)?.name ?? id,
		report: (id) => reports.find((r) => r.id === id)?.title ?? id,
		page: (id) => {
			for (const report of reports) {
				const page = report.pages.find((p) => p.id === id);
				if (page) return `${report.title}, ${page.title}`;
			}
			return id;
		},
	};
}

const sectionKindWords: Record<AboutSection["kind"], string | null> = {
	dataset: null,
	report: "Report",
	page: "Page",
	category: "Category",
	table: "Table",
};

// The mark before a field: a plus for added, a minus for removed and a dot for changed.
// A rename shows its old and new names with an arrow between them instead, and nothing
// shows when what happened was not said.
function ChangeMark({ change }: { change: AboutChange | null }) {
	if (!change || change === "renamed") return null;
	const path =
		change === "added"
			? "M12 5v14M5 12h14"
			: change === "removed"
				? "M5 12h14"
				: "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0";
	return (
		<svg
			width="11"
			height="11"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="3"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}

function fieldKey(field: { name: string; from?: string }): string {
	return `${field.from ?? ""}>${field.name}`;
}

// Every field an update names, under its dataset and grouped by what happened, for the
// detail. Each field is a chip, so a long name never breaks across lines.
function AboutChanges({ sections }: { sections: AboutSection[] }) {
	return (
		<div className={styles.aboutSections}>
			{sections.map((section) => (
				<div
					key={`${section.kind}:${section.names.join("|")}`}
					className={styles.aboutSection}
				>
					<div className={styles.aboutHead}>
						{sectionKindWords[section.kind] && (
							<span className={styles.aboutKind}>
								{sectionKindWords[section.kind]}
							</span>
						)}
						<strong>{joinNames(section.names)}</strong>
						{section.change && (
							<span
								className={`${styles.changePill} ${styles[`tone${section.change}`]}`}
							>
								{changeWord(section.change)}
							</span>
						)}
					</div>
					{section.groups.map((group) => (
						<div
							key={group.change ?? "unsaid"}
							className={styles.fieldGroup}
						>
							{group.change && (
								<span
									className={`${styles.fieldGroupLabel} ${styles[`text${group.change}`]}`}
								>
									{changeWord(group.change)}
									<span className={styles.fieldCount}>
										{group.fields.length}
									</span>
								</span>
							)}
							<div className={styles.fieldChips}>
								{group.fields.map((field) => (
									<span
										key={fieldKey(field)}
										className={`${styles.fieldChip} ${
											group.change
												? styles[`chip${group.change}`]
												: ""
										}`}
									>
										<ChangeMark change={group.change} />
										{field.from ? (
											<>
												<span
													className={styles.oldName}
												>
													{field.from}
												</span>
												<span aria-hidden="true">
													→
												</span>
												<span>{field.name}</span>
											</>
										) : (
											<span>{field.name}</span>
										)}
									</span>
								))}
							</div>
						</div>
					))}
				</div>
			))}
		</div>
	);
}

// The same on a timeline card, as text that wraps and names every field.
function AboutSummary({ sections }: { sections: AboutSection[] }) {
	return (
		<span className={styles.cardAbout}>
			{sections.map((section, index) => (
				<span key={`${section.kind}:${section.names.join("|")}`}>
					{index > 0 && "; "}
					<span className={styles.cardAboutNames}>
						{joinNames(section.names)}
					</span>
					{section.change &&
						` (${changeWord(section.change).toLowerCase()})`}
					{section.groups.map((group) => (
						<span key={group.change ?? "unsaid"}>
							{" · "}
							{group.change && (
								<span className={styles[`text${group.change}`]}>
									{changeWord(group.change)}:{" "}
								</span>
							)}
							{group.fields
								.map((field) =>
									field.from
										? `${field.from} → ${field.name}`
										: field.name,
								)
								.join(", ")}
						</span>
					))}
				</span>
			))}
		</span>
	);
}

function capitalised(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

const aboutKindWords: Record<AboutItem["kind"], string> = {
	source: "Source",
	table: "Table",
	field: "Field",
	category: "Category",
	report: "Report",
	page: "Page",
};

// What an update is about, chosen rather than typed. Choosing a thing adds it straight away,
// so several columns of one source are a few clicks.
function AboutPicker({
	about,
	type,
	onChange,
}: {
	about: AboutItem[];
	type: string;
	onChange: (next: AboutItem[]) => void;
}) {
	const choices = useUpdateChoices();
	const [kind, setKind] = useState<AboutItem["kind"]>("source");
	const [sourceKey, setSourceKey] = useState("");
	const [reportId, setReportId] = useState("");
	// What happened to the next field or dataset added, and the names a removal or a
	// rename needs typed because they are no longer in the list.
	const [change, setChange] = useState<AboutChange | "">("");
	const [typedName, setTypedName] = useState("");
	const [oldName, setOldName] = useState("");
	const changeOptions = [
		{ value: "", label: "Change not said" },
		{ value: "added", label: "Added" },
		{ value: "changed", label: "Changed" },
		{ value: "removed", label: "Removed" },
		...(kind === "field" ? [{ value: "renamed", label: "Renamed" }] : []),
	];
	// Everything listed, for naming what is already attached.
	const sources = choices?.sources ?? [];
	const reports = choices?.reports ?? [];
	// Only what this caller may post about, for adding more.
	const postableSources = sources.filter((source) => source.canPost);
	const postableCategories = (choices?.categories ?? []).filter(
		(category) => category.canPost,
	);
	const postableReports = reports.filter(
		(report) =>
			report.canPost ||
			(type === "reportChange" && report.canPostReportChange),
	);
	// A table is not tied to anything a narrower right can name, so only a caller who
	// may post everywhere attaches one.
	const kindOptions = Object.entries(aboutKindWords)
		.filter(([value]) => value !== "table" || choices?.postsEverywhere)
		.map(([value, label]) => ({ value, label }));
	const { data: tables } = useSWR<{
		sources: { tables: string[] }[];
	}>(
		kind === "table" && sourceKey
			? `/api/data-rules?source=${encodeURIComponent(sourceKey)}`
			: null,
	);

	const add = (item: AboutItem) => {
		const said: AboutItem =
			(item.kind === "field" || item.kind === "source") && change
				? {
						...item,
						change,
						...(change === "renamed"
							? { from: oldName.trim() }
							: {}),
					}
				: item;
		if (
			!about.some(
				(held) =>
					held.kind === said.kind &&
					held.id === said.id &&
					held.sourceKey === said.sourceKey &&
					held.change === said.change &&
					held.from === said.from,
			)
		) {
			onChange([...about, said]);
		}
		if (change === "renamed") setOldName("");
		setTypedName("");
	};
	const labelOf = (item: AboutItem): string => {
		if (item.kind === "source") {
			return sources.find((s) => s.key === item.id)?.title ?? item.id;
		}
		if (item.kind === "category") {
			return (
				choices?.categories.find((c) => c.id === item.id)?.name ??
				item.id
			);
		}
		if (item.kind === "report") {
			return reports.find((r) => r.id === item.id)?.title ?? item.id;
		}
		if (item.kind === "page") {
			for (const report of reports) {
				const page = report.pages.find((p) => p.id === item.id);
				if (page) return `${report.title}, ${page.title}`;
			}
		}
		if (item.kind === "field" && item.sourceKey) {
			const dataset =
				sources.find((s) => s.key === item.sourceKey)?.title ??
				item.sourceKey;
			return item.from
				? `${dataset}: ${item.from} → ${item.id}`
				: `${dataset}: ${item.id}`;
		}
		return item.id;
	};
	const sourceOptions = postableSources.map((source) => ({
		value: source.key,
		label: source.title,
	}));

	return (
		<div className={form.field}>
			<span className={form.label}>What it is about</span>
			{about.length > 0 && (
				<div className={styles.chips}>
					{about.map((item, index) => (
						<span
							key={`${item.kind}:${item.id}`}
							className={styles.chip}
						>
							<span className={styles.chipKind}>
								{item.change
									? `${aboutKindWords[item.kind]} ${changeWord(item.change).toLowerCase()}`
									: aboutKindWords[item.kind]}
							</span>{" "}
							{labelOf(item)}{" "}
							<button
								type="button"
								className={styles.chipRemove}
								aria-label={`Remove ${labelOf(item)}`}
								onClick={() =>
									onChange(
										about.filter((_, i) => i !== index),
									)
								}
							>
								<RemoveMark />
							</button>
						</span>
					))}
				</div>
			)}
			<div className={form.row}>
				<Select
					value={kind}
					ariaLabel="What kind of thing"
					onChange={(next) => {
						setKind(next as AboutItem["kind"]);
						if (next !== "field" && change === "renamed") {
							setChange("");
						}
					}}
					options={kindOptions}
				/>
				{(kind === "field" || kind === "source") && (
					<Select
						value={change}
						ariaLabel="What happened to it"
						onChange={(next) => setChange(next as AboutChange | "")}
						options={changeOptions}
					/>
				)}
				{kind === "source" && (
					<Select
						value=""
						placeholder="Choose a source to add"
						ariaLabel="Source"
						searchable
						onChange={(id) => add({ kind: "source", id })}
						options={sourceOptions}
					/>
				)}
				{(kind === "field" || kind === "table") && (
					<Select
						value={sourceKey}
						placeholder="Choose a source"
						ariaLabel="Source"
						searchable
						onChange={setSourceKey}
						options={sourceOptions}
					/>
				)}
				{kind === "field" && change === "renamed" && (
					<input
						className={form.input}
						value={oldName}
						placeholder="Its old name"
						aria-label="The field's old name"
						disabled={!sourceKey}
						onChange={(e) => setOldName(e.target.value)}
					/>
				)}
				{kind === "field" && change === "removed" && (
					<>
						<input
							className={form.input}
							value={typedName}
							placeholder={
								sourceKey
									? "The removed field's name, then Enter"
									: "Choose a source first"
							}
							aria-label="The removed field's name"
							disabled={!sourceKey}
							onChange={(e) => setTypedName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && typedName.trim()) {
									e.preventDefault();
									add({
										kind: "field",
										id: typedName.trim(),
										sourceKey,
									});
								}
							}}
						/>
						<button
							type="button"
							className={styles.actionButton}
							disabled={!sourceKey || !typedName.trim()}
							onClick={() =>
								add({
									kind: "field",
									id: typedName.trim(),
									sourceKey,
								})
							}
						>
							Add
						</button>
					</>
				)}
				{kind === "field" && change !== "removed" && (
					<Select
						value=""
						placeholder={
							!sourceKey
								? "Choose a source first"
								: change === "renamed"
									? "Choose its new name"
									: "Choose columns to add"
						}
						ariaLabel="Column"
						searchable
						disabled={
							!sourceKey ||
							(change === "renamed" && !oldName.trim())
						}
						onChange={(id) => add({ kind: "field", id, sourceKey })}
						options={(
							sources.find((s) => s.key === sourceKey)?.fields ??
							[]
						).map((field) => ({ value: field, label: field }))}
					/>
				)}
				{kind === "table" && (
					<Select
						value=""
						placeholder={
							sourceKey
								? "Choose a table to add"
								: "Choose a source first"
						}
						ariaLabel="Table"
						searchable
						disabled={!sourceKey}
						onChange={(id) => add({ kind: "table", id })}
						options={(tables?.sources?.[0]?.tables ?? []).map(
							(table) => ({ value: table, label: table }),
						)}
					/>
				)}
				{kind === "category" && (
					<Select
						value=""
						placeholder="Choose a category to add"
						ariaLabel="Category"
						searchable
						onChange={(id) => add({ kind: "category", id })}
						options={postableCategories.map((c) => ({
							value: c.id,
							label: c.name,
						}))}
					/>
				)}
				{(kind === "report" || kind === "page") && (
					<Select
						value={kind === "page" ? reportId : ""}
						placeholder={
							kind === "page"
								? "Choose a report"
								: "Choose a report to add"
						}
						ariaLabel="Report"
						searchable
						onChange={(id) =>
							kind === "page"
								? setReportId(id)
								: add({ kind: "report", id })
						}
						options={postableReports.map((r) => ({
							value: r.id,
							label: r.title,
						}))}
					/>
				)}
				{kind === "page" && (
					<Select
						value=""
						placeholder={
							reportId
								? "Choose a page to add"
								: "Choose a report first"
						}
						ariaLabel="Page"
						searchable
						disabled={!reportId}
						onChange={(id) => add({ kind: "page", id })}
						options={(
							postableReports.find((r) => r.id === reportId)
								?.pages ?? []
						).map((page) => ({
							value: page.id,
							label: page.title,
						}))}
					/>
				)}
			</div>
		</div>
	);
}

// Who an update is for, by the same lists. A group's name has no list to choose from, since
// the app cannot read the directory, so that stays typed.
// Who is credited. Each is somebody who has used the app, picked by name or email, or a name
// typed for anyone else. A GitHub name can be entered as github:name.
// The cross on a chip's remove button.
function RemoveMark() {
	return (
		<svg
			width="10"
			height="10"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="3"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<path d="M6 6l12 12M18 6L6 18" />
		</svg>
	);
}

function AuthorsField({
	authors,
	onChange,
}: {
	authors: Author[];
	onChange: (next: Author[]) => void;
}) {
	const choices = useUpdateChoices();
	const [typed, setTyped] = useState("");
	const people = choices?.people ?? [];
	const add = (raw: string) => {
		const value = raw.trim();
		if (!value) return;
		const person = people.find(
			(held) =>
				held.email.toLowerCase() === value.toLowerCase() ||
				held.name.toLowerCase() === value.toLowerCase(),
		);
		const next: Author = person
			? { name: person.name, email: person.email }
			: value.toLowerCase().startsWith("github:")
				? { name: value.slice(7), github: value.slice(7) }
				: value.includes("@")
					? { name: value, email: value.toLowerCase() }
					: { name: value };
		const key = (author: Author) =>
			(author.email ?? author.github ?? author.name).toLowerCase();
		if (!authors.some((held) => key(held) === key(next))) {
			onChange([...authors, next]);
		}
		setTyped("");
	};
	return (
		<div className={form.field}>
			<span className={form.label}>Authors</span>
			{authors.length > 0 && (
				<div className={styles.chips}>
					{authors.map((author) => (
						<span
							key={author.email ?? author.github ?? author.name}
							className={styles.chip}
							title={author.email ?? author.github ?? undefined}
						>
							{author.name}
							<button
								type="button"
								className={styles.chipRemove}
								aria-label={`Remove ${author.name}`}
								onClick={() =>
									onChange(
										authors.filter(
											(held) => held !== author,
										),
									)
								}
							>
								<RemoveMark />
							</button>
						</span>
					))}
				</div>
			)}
			<input
				className={form.input}
				value={typed}
				list="update-author-choices"
				placeholder="A name or email, then Enter"
				aria-label="Add an author"
				onChange={(e) => setTyped(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === ",") {
						e.preventDefault();
						add(typed);
					}
				}}
				onBlur={() => add(typed)}
			/>
			<datalist id="update-author-choices">
				{people.map((person) => (
					<option key={person.email} value={person.email}>
						{person.name}
					</option>
				))}
			</datalist>
		</div>
	);
}

function AudiencePicker({
	kind,
	ids,
	onChange,
}: {
	kind: string;
	ids: string[];
	onChange: (next: string[]) => void;
}) {
	const choices = useUpdateChoices();
	if (kind === "groups") {
		return (
			<label className={form.field}>
				<span className={form.label}>Group names, with commas</span>
				<input
					className={form.input}
					value={ids.join(", ")}
					onChange={(e) =>
						onChange(
							e.target.value
								.split(",")
								.map((id) => id.trim())
								.filter(Boolean),
						)
					}
				/>
			</label>
		);
	}
	const options =
		kind === "category"
			? (choices?.categories ?? []).map((c) => ({
					value: c.id,
					label: c.name,
				}))
			: kind === "source"
				? (choices?.sources ?? []).map((s) => ({
						value: s.key,
						label: s.title,
					}))
				: (choices?.reports ?? []).map((r) => ({
						value: r.id,
						label: r.title,
					}));
	return (
		<div className={form.field}>
			<span className={form.label}>Which</span>
			{ids.length > 0 && (
				<div className={styles.chips}>
					{ids.map((id) => (
						<span key={id} className={styles.chip}>
							{options.find((o) => o.value === id)?.label ?? id}{" "}
							<button
								type="button"
								className={styles.chipRemove}
								aria-label="Remove"
								onClick={() =>
									onChange(ids.filter((held) => held !== id))
								}
							>
								<RemoveMark />
							</button>
						</span>
					))}
				</div>
			)}
			<Select
				value=""
				placeholder="Choose one to add"
				searchable
				onChange={(id) => {
					if (!ids.includes(id)) onChange([...ids, id]);
				}}
				options={options}
			/>
		</div>
	);
}

function Composer({
	start,
	types,
	templates,
	onDone,
	onClose,
}: {
	start: Draft;
	types: UpdateTypeDefinition[];
	templates: Answer["templates"];
	onDone: () => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState(start);
	const [failure, setFailure] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [templateName, setTemplateName] = useState("");
	const [savingTemplate, setSavingTemplate] = useState(false);
	const set = (patch: Record<string, unknown>) =>
		setDraft({ ...draft, ...patch });
	const type = types.find((t) => t.typeId === draft.type);
	const textValue = (key: string) => String(draft[key] ?? "");
	const textField = (key: string, label: string, placeholder?: string) => (
		<label className={form.field}>
			<span className={form.label}>{label}</span>
			<input
				className={form.input}
				value={textValue(key)}
				placeholder={placeholder}
				onChange={(e) => set({ [key]: e.target.value })}
			/>
		</label>
	);
	const dateField = (key: string, label: string) => (
		<label className={form.field}>
			<span className={form.label}>{label}</span>
			<input
				type="datetime-local"
				className={form.input}
				value={toLocalInput(draft[key] as string | null)}
				onChange={(e) =>
					set({
						[key]: e.target.value
							? new Date(e.target.value).toISOString()
							: null,
					})
				}
			/>
		</label>
	);
	const audience = (draft.audience ?? { kind: "readers" }) as {
		kind: string;
		ids?: string[];
	};

	const send = async (status: "draft" | "published") => {
		setBusy(true);
		setFailure(null);
		try {
			await post({
				...draft,
				status,
				action: draft.updateId ? "change" : "post",
			});
			onDone();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
		} finally {
			setBusy(false);
		}
	};

	const shownOn = deliveryWords
		.filter(([key]) => draft.delivery[key])
		.map(([, label]) => label);
	const detailsSet = [
		draft.before || draft.after ? "Before and after" : null,
		draft.reason ? "Why" : null,
		draft.reference ? "Reference" : null,
		((draft.tags as string[]) ?? []).length > 0 ? "Tags" : null,
	].filter(Boolean);
	const isMaintenance = draft.type === "maintenance";
	const released = isPast(draft.effectiveOn as string | null);

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={draft.updateId ? "Change this update" : "New update"}
			width="1040px"
			footer={
				<>
					<div className={styles.composerFootLeft}>
						<Toggle
							label="Notify people"
							checked={draft.notify !== false}
							onChange={(notify) => set({ notify })}
						/>
						{savingTemplate ? (
							<>
								<input
									className={form.input}
									value={templateName}
									autoFocus
									placeholder="Template name"
									aria-label="Template name"
									onChange={(e) =>
										setTemplateName(e.target.value)
									}
								/>
								<button
									type="button"
									className={styles.actionButton}
									disabled={!templateName.trim()}
									onClick={async () => {
										try {
											const {
												updateId: _updateId,
												title: _title,
												...fields
											} = draft;
											await post({
												action: "saveTemplate",
												name: templateName,
												type: draft.type,
												fields,
											});
											setTemplateName("");
											setSavingTemplate(false);
										} catch (error) {
											setFailure(
												error instanceof Error
													? error.message
													: "That did not save.",
											);
										}
									}}
								>
									Save template
								</button>
							</>
						) : (
							<button
								type="button"
								className={styles.actionButton}
								onClick={() => setSavingTemplate(true)}
							>
								Save as a template
							</button>
						)}
					</div>
					<button
						type="button"
						className={styles.actionButton}
						onClick={onClose}
					>
						Cancel
					</button>
					{!draft.updateId && (
						<button
							type="button"
							className={styles.actionButton}
							disabled={busy}
							onClick={() => void send("draft")}
						>
							Save as draft
						</button>
					)}
					<button
						type="button"
						className={form.primary}
						disabled={busy || !textValue("title").trim()}
						onClick={() => void send("published")}
					>
						{draft.updateId ? "Publish the correction" : "Publish"}
					</button>
				</>
			}
		>
			<div className={styles.composer}>
				<div className={styles.composerMain}>
					<div className={styles.threeUp}>
						<label className={form.field}>
							<span className={form.label}>Type</span>
							<Select
								value={draft.type}
								disabled={Boolean(draft.updateId)}
								onChange={(next) => {
									const picked = types.find(
										(t) => t.typeId === next,
									);
									set({
										type: next,
										impact: picked?.impact,
										delivery: picked?.delivery,
									});
								}}
								options={types.map((t) => ({
									value: t.typeId,
									label: t.label,
								}))}
							/>
						</label>
						<label className={form.field}>
							<span className={form.label}>Impact</span>
							<Select
								value={String(
									draft.impact ?? type?.impact ?? "info",
								)}
								onChange={(impact) => set({ impact })}
								options={[
									{ value: "info", label: "Info" },
									{ value: "notable", label: "Notable" },
									{ value: "breaking", label: "Breaking" },
								]}
							/>
						</label>
						{!draft.updateId && (
							<label className={form.field}>
								<span className={form.label}>Start from</span>
								<Select
									value=""
									disabled={templates.length === 0}
									placeholder={
										templates.length === 0
											? "No templates yet"
											: "Choose a template"
									}
									onChange={(id) => {
										const template = templates.find(
											(t) => t.templateId === id,
										);
										if (template) {
											setDraft({
												...draft,
												...template.fields,
												type: template.type,
											} as Draft);
										}
									}}
									options={templates.map((t) => ({
										value: t.templateId,
										label: t.name,
									}))}
								/>
							</label>
						)}
					</div>

					{textField("title", "Title")}

					<AuthorsField
						authors={(draft.authors as Author[]) ?? []}
						onChange={(authors) => set({ authors })}
					/>

					{textField(
						"whatToDo",
						"What readers should do",
						"Their next step, such as re-applying a saved filter. Leave empty when nothing is needed.",
					)}

					<div className={form.field}>
						<span className={form.label}>Details</span>
						<div className={styles.rich}>
							<TextPanel
								html={textValue("body")}
								editable
								onChange={(body) => set({ body })}
								placeholder="What changed, and what it means for someone reading these figures."
							/>
						</div>
					</div>

					<AboutPicker
						about={draft.about}
						type={draft.type}
						onChange={(about) => set({ about })}
					/>
					{failure && <div className={form.failure}>{failure}</div>}
				</div>

				<aside className={styles.composerSide}>
					<ComposerGroup
						title="When"
						startOpen={isMaintenance}
						summary={
							draft.startsOn
								? `From ${when(draft.startsOn as string)}`
								: released
									? `Released ${when(draft.effectiveOn as string)}, ${
											draft.placement === "history"
												? "placed at that date"
												: "shown at the top as new"
										}`
									: draft.effectiveOn
										? `Takes effect ${when(draft.effectiveOn as string)}`
										: "Takes effect now, shows now"
						}
					>
						{(isMaintenance || draft.startsOn != null) && (
							<>
								{dateField("startsOn", "Starts")}
								{dateField("endsOn", "Ends")}
								<label className={form.field}>
									<span className={form.label}>Repeats</span>
									<Select
										value={String(draft.repeat ?? "none")}
										onChange={(repeat) => set({ repeat })}
										options={[
											{
												value: "none",
												label: "Does not repeat",
											},
											{
												value: "daily",
												label: "Every day",
											},
											{
												value: "weekly",
												label: "Every week",
											},
											{
												value: "monthly",
												label: "Every month",
											},
										]}
									/>
								</label>
							</>
						)}
						{dateField("effectiveOn", "Takes effect or released")}
						{released && (
							<div className={form.field}>
								<span className={form.label}>
									On the timeline
								</span>
								<div
									className={styles.segments}
									role="group"
									aria-label="Where it sits on the timeline"
								>
									{(
										[
											["top", "At the top, as new"],
											["history", "At its release date"],
										] as const
									).map(([value, label]) => (
										<button
											key={value}
											type="button"
											className={`${styles.segment} ${
												(draft.placement ?? "top") ===
												value
													? styles.segmentOn
													: ""
											}`}
											aria-pressed={
												(draft.placement ?? "top") ===
												value
											}
											onClick={() =>
												set({ placement: value })
											}
										>
											{label}
										</button>
									))}
								</div>
							</div>
						)}
						{dateField("periodFrom", "Data affected from")}
						{dateField("periodTo", "Data affected to")}
						{dateField("showFrom", "Show from")}
						{dateField("expiresOn", "Stop showing")}
					</ComposerGroup>

					<ComposerGroup
						title="Who it is for"
						summary={audienceWords[audience.kind] ?? audience.kind}
					>
						<Select
							value={audience.kind}
							ariaLabel="Who it is for"
							onChange={(kind) =>
								set({ audience: { kind, ids: [] } })
							}
							options={Object.entries(audienceWords).map(
								([value, label]) => ({ value, label }),
							)}
						/>
						{audience.kind !== "readers" &&
							audience.kind !== "everyone" && (
								<AudiencePicker
									kind={audience.kind}
									ids={audience.ids ?? []}
									onChange={(ids) =>
										set({ audience: { ...audience, ids } })
									}
								/>
							)}
					</ComposerGroup>

					<ComposerGroup
						title="Where it shows"
						summary={
							shownOn.length > 0
								? shownOn.join(", ")
								: "Only on the Updates list"
						}
					>
						<div className={styles.deliveries}>
							{deliveryWords.map(([key, label]) => (
								<Toggle
									key={key}
									label={label}
									checked={draft.delivery[key]}
									onChange={(on) =>
										set({
											delivery: {
												...draft.delivery,
												[key]: on,
											},
										})
									}
								/>
							))}
							<Toggle
								label="Ask people to acknowledge it"
								checked={draft.requireAck === true}
								onChange={(requireAck) => set({ requireAck })}
							/>
						</div>
					</ComposerGroup>

					<ComposerGroup
						title="More detail"
						summary={
							detailsSet.length > 0
								? detailsSet.join(", ")
								: "Before and after, why, reference, tags"
						}
					>
						{textField("before", "Before")}
						{textField("after", "After")}
						{textField("reason", "Why")}
						{textField(
							"reference",
							"Reference",
							"A commit or ticket",
						)}
						<label className={form.field}>
							<span className={form.label}>
								Tags, with commas between
							</span>
							<input
								className={form.input}
								value={((draft.tags as string[]) ?? []).join(
									", ",
								)}
								onChange={(e) =>
									set({
										tags: e.target.value
											.split(",")
											.map((tag) => tag.trim())
											.filter(Boolean),
									})
								}
							/>
						</label>
					</ComposerGroup>
				</aside>
			</div>
		</Modal>
	);
}

function DetailDialog({
	updateId,
	types,
	canModerate,
	selfEmail,
	onChanged,
	onEdit,
	onClose,
}: {
	updateId: string;
	types: UpdateTypeDefinition[];
	canModerate: boolean;
	selfEmail: string | null;
	onChanged: () => void;
	onEdit: (update: Update) => void;
	onClose: () => void;
}) {
	const { data, mutate } = useSWR<Detail>(`/api/changes?id=${updateId}`);
	const choices = useUpdateChoices();
	const [note, setNote] = useState("");
	const [failure, setFailure] = useState<string | null>(null);
	const [retracting, setRetracting] = useState(false);

	useEffect(() => {
		void post({ action: "read", updateId }).then(onChanged, () => {});
		// Once for each one opened.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [updateId]);

	if (!data) return null;
	const { update } = data;
	const mine = update.createdBy.toLowerCase() === selfEmail?.toLowerCase();
	const canChange = mine || canModerate;

	const act = async (body: Record<string, unknown>) => {
		setFailure(null);
		try {
			await post({ updateId, ...body });
			setNote("");
			await mutate();
			onChanged();
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "That did not work.",
			);
		}
	};

	const acknowledged = (update as { acknowledged?: boolean }).acknowledged;
	const sections = aboutSections(update.about, aboutNames(choices));
	const saysChanges = update.about.some((item) => item.change);
	const facts: [string, React.ReactNode][] = [
		...(update.reason ? [["Why", update.reason]] : []),
		...(update.effectiveOn
			? [
					[
						isPast(update.effectiveOn)
							? "Released"
							: "Takes effect",
						when(update.effectiveOn),
					],
				]
			: []),
		...(update.periodFrom || update.periodTo
			? [
					[
						"Data affected",
						`${when(update.periodFrom)} to ${when(update.periodTo)}`,
					],
				]
			: []),
		...(update.startsOn
			? [
					[
						"Window",
						`${when(update.startsOn)} to ${when(update.endsOn)}${
							update.repeat !== "none"
								? `, every ${update.repeat}`
								: ""
						}`,
					],
				]
			: []),
		...(update.reference ? [["Reference", update.reference]] : []),
		...(data.affects.length > 0
			? [
					[
						"Reports affected",
						<ReportsAffected
							key="reports"
							reports={data.affects}
						/>,
					],
				]
			: []),
		...(update.links.length > 0
			? [
					[
						update.links.length === 1 ? "Link" : "Links",
						<span key="links" className={styles.factLinks}>
							{update.links.map((link) => (
								<a
									key={link.url}
									href={link.url}
									className={styles.factLink}
								>
									{link.label}
								</a>
							))}
						</span>,
					],
				]
			: []),
	] as [string, React.ReactNode][];
	const notes = data.history.filter((event) => event.kind === "note");
	const events = data.history.filter((event) => event.kind !== "note");

	return (
		<Modal
			isOpen
			onClose={onClose}
			title={update.title}
			width="760px"
			footer={
				<>
					{update.requireAck && !acknowledged && (
						<button
							type="button"
							className={form.primary}
							onClick={() =>
								void act({ action: "read", acknowledged: true })
							}
						>
							Acknowledge
						</button>
					)}
					{canChange &&
						update.type === "incident" &&
						(["investigating", "identified", "resolved"] as const)
							.filter((state) => state !== update.incidentState)
							.map((state) => (
								<button
									key={state}
									type="button"
									className={styles.actionButton}
									onClick={() =>
										void act({
											action: "incident",
											state,
											note,
										})
									}
								>
									Mark {state}
								</button>
							))}
					{canChange && (
						<>
							<button
								type="button"
								className={styles.actionButton}
								onClick={() => onEdit(update)}
							>
								Correct
							</button>
							<button
								type="button"
								className={`${styles.actionButton} ${styles.actionDanger}`}
								onClick={() => setRetracting(true)}
							>
								Retract
							</button>
						</>
					)}
				</>
			}
		>
			<div className={styles.detail}>
				<div className={styles.detailHead}>
					<div className={styles.metaRow}>
						<TypeBadge type={update.type} types={types} />
						<span className={styles[`impact${update.impact}`]}>
							{capitalised(update.impact)}
						</span>
						{update.incidentState && (
							<span className={styles.state}>
								{capitalised(update.incidentState)}
							</span>
						)}
					</div>
					<span className={styles.meta}>
						{(update.authorsShown ?? []).length > 0
							? `By ${byline(update.authorsShown ?? [])} · `
							: ""}
						{update.effectiveOn && isPast(update.effectiveOn)
							? `Released ${when(update.effectiveOn)} · `
							: ""}
						{`Posted ${when(update.postedOn)}`}
						{(update.authorsShown ?? []).length === 0
							? ` by ${update.poster ?? update.createdBy}`
							: ""}
						{update.correctedOn
							? ` · Corrected ${when(update.correctedOn)}`
							: ""}
					</span>
				</div>

				{update.whatToDo && (
					<div
						className={`${styles.whatToDo} ${styles[`tone${update.impact}`]}`}
					>
						<span className={styles.whatToDoLabel}>What to do</span>
						<p>{update.whatToDo}</p>
					</div>
				)}

				{update.body && <TextPanel html={update.body} />}

				{(update.before || update.after) && (
					<div className={styles.change}>
						<div>
							<span className={styles.changeLabel}>Before</span>
							<span>{update.before ?? "-"}</span>
						</div>
						<span className={styles.changeArrow} aria-hidden="true">
							→
						</span>
						<div>
							<span className={styles.changeLabel}>After</span>
							<span>{update.after ?? "-"}</span>
						</div>
					</div>
				)}

				{sections.length > 0 && (
					<section className={styles.detailSection}>
						<h3 className={styles.sectionTitle}>
							{saysChanges ? "What changed" : "What it is about"}
						</h3>
						<AboutChanges sections={sections} />
					</section>
				)}

				{facts.length > 0 && (
					<dl className={styles.facts}>
						{facts.map(([label, value]) => (
							<div key={label} className={styles.fact}>
								<dt>{label}</dt>
								<dd>{value}</dd>
							</div>
						))}
					</dl>
				)}

				<section className={styles.activity}>
					<h3 className={styles.sectionTitle}>Activity</h3>

					{notes.length > 0 && (
						<ol className={styles.notes}>
							{notes.map((event, index) => (
								<li key={index} className={styles.noteEntry}>
									<span
										className={styles.noteAvatar}
										aria-hidden="true"
									>
										{initialsOf(
											event.by_name ?? event.by_email,
										)}
									</span>
									<div className={styles.noteBody}>
										<div>
											<strong>
												{event.by_name ??
													event.by_email}
											</strong>{" "}
											<span className={styles.meta}>
												{when(event.at)}
											</span>
										</div>
										{event.note && <p>{event.note}</p>}
									</div>
								</li>
							))}
						</ol>
					)}

					<div className={styles.noteRow}>
						<input
							className={form.input}
							value={note}
							placeholder={
								notes.length > 0
									? "Add to the discussion, such as what you checked"
									: "What you did about this, or what you checked"
							}
							aria-label="Add a note to this update"
							onChange={(e) => setNote(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && note.trim()) {
									void act({ action: "note", note });
								}
							}}
						/>
						<button
							type="button"
							className={styles.actionButton}
							disabled={!note.trim()}
							onClick={() => void act({ action: "note", note })}
						>
							Add note
						</button>
					</div>

					{data.acknowledgedBy && data.acknowledgedBy.length > 0 && (
						<p className={styles.meta}>
							Acknowledged by {data.acknowledgedBy.join(", ")}
						</p>
					)}

					<ol className={styles.events}>
						{events.map((event, index) => (
							<li key={index}>
								<span>
									{historyWords[event.kind] ?? event.kind}
								</span>{" "}
								<span className={styles.meta}>
									{event.by_name ?? event.by_email},{" "}
									{when(event.at)}
								</span>
								{event.note && (
									<span className={styles.meta}>
										{" "}
										· {event.note}
									</span>
								)}
								{event.snapshot?.title &&
									event.snapshot.title !== update.title && (
										<span className={styles.meta}>
											{" "}
											· It read &quot;
											{event.snapshot.title}
											&quot;
										</span>
									)}
							</li>
						))}
					</ol>
				</section>
				{failure && <div className={form.failure}>{failure}</div>}
			</div>

			{retracting && (
				<ConfirmDialog
					title="Retract this update"
					body="It stops showing everywhere. Its history is kept."
					confirmLabel="Retract"
					onConfirm={async () => {
						await act({ action: "retract", note });
						setRetracting(false);
						onClose();
					}}
					onCancel={() => setRetracting(false)}
				/>
			)}
		</Modal>
	);
}

function Calendar({ updates }: { updates: Update[] }) {
	const now = Date.now();
	const windows = updates
		.filter((u) => u.type === "maintenance")
		.flatMap((update) => {
			const window = currentWindow(update, now);
			return window ? [{ update, ...window }] : [];
		})
		.sort((a, b) => a.start - b.start);
	if (windows.length === 0) {
		return (
			<EmptyState
				icon={emptyIcons.calendar}
				title="No maintenance planned"
			>
				Planned work shows here with its dates and the sources it
				touches. While it runs, late data warnings and alerts on those
				sources wait until it finishes.
			</EmptyState>
		);
	}
	return (
		<div className={styles.calendar}>
			{windows.map(({ update, start, end }) => (
				<div key={update.updateId} className={styles.calendarRow}>
					<div className={styles.calendarHead}>
						<span
							className={`${styles.pill} ${start <= now ? styles.pillNow : ""}`}
						>
							{start <= now ? "Happening now" : "Planned"}
						</span>
						<strong>{update.title}</strong>
					</div>
					<span className={styles.meta}>
						{new Date(start).toLocaleString()} to{" "}
						{new Date(end).toLocaleString()}
						{update.repeat !== "none"
							? `, every ${update.repeat}`
							: ""}
					</span>
					<span className={styles.meta}>
						Affects{" "}
						{sourcesOf(update.about).join(", ") || "everything"}
					</span>
				</div>
			))}
		</div>
	);
}

export default function UpdatesView() {
	const { data, mutate } = useSWR<Answer>("/api/changes", {
		refreshInterval: 60_000,
		dedupingInterval: 5000,
	});
	const choices = useUpdateChoices();
	const { data: me } = useSWR<{ email: string }>("/api/user");
	const [tab, setTab] = useState<"timeline" | "calendar" | "following">(
		"timeline",
	);
	const [term, setTerm] = useState("");
	const [typeFilter, setTypeFilter] = useState("");
	const [impactFilter, setImpactFilter] = useState("");
	const [open, setOpen] = useState<string | null>(null);
	const [composing, setComposing] = useState<Draft | null>(null);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const named = params.get("open");
		if (named) setOpen(named);
	}, []);

	const types = data?.types ?? [];
	const blank = (typeId: string): Draft => {
		const type = types.find((t) => t.typeId === typeId);
		return {
			type: typeId,
			title: "",
			body: "",
			impact: type?.impact,
			delivery: (type?.delivery ?? {}) as Delivery,
			about: [],
			tags: [],
			authors: [],
			placement: "top",
			notify: true,
			whatToDo: "",
		};
	};

	const shown = useMemo(() => {
		const needle = term.trim().toLowerCase();
		return (data?.updates ?? []).filter((update) => {
			if (typeFilter && update.type !== typeFilter) return false;
			if (impactFilter && update.impact !== impactFilter) return false;
			if (!needle) return true;
			return [
				update.title,
				update.body,
				update.reference ?? "",
				update.whatToDo ?? "",
				...update.tags,
				...update.about.flatMap((item) =>
					item.from ? [item.id, item.from] : [item.id],
				),
			]
				.join(" ")
				.toLowerCase()
				.includes(needle);
		});
	}, [data, term, typeFilter, impactFilter]);

	const follow = async (
		kind: Follow["kind"],
		value: string,
		mode: Follow["mode"],
		on: boolean,
	) => {
		await post({ action: "follow", kind, value, mode, on });
		await mutate();
	};

	return (
		<div className={styles.embedded}>
			{/* One row, so the views and what can be done sit together rather than taking
			    a band of the page each. */}
			<div className={styles.bar}>
				<TabStrip
					tabs={
						[
							{ id: "timeline", label: "Timeline" },
							{ id: "calendar", label: "Maintenance" },
							{ id: "following", label: "Following" },
						] as const
					}
					value={tab}
					label="Updates"
					onChange={setTab}
				/>
				<div className={styles.headerActions}>
					{tab === "timeline" && (
						<a
							className={styles.button}
							href="/api/changes?format=csv"
						>
							Export
						</a>
					)}
					{data?.canPost && (
						<button
							type="button"
							className={styles.primary}
							onClick={() => setComposing(blank("announcement"))}
						>
							New update
						</button>
					)}
				</div>
			</div>

			{tab === "timeline" && (
				<>
					<div className={styles.controls}>
						<input
							className={form.input}
							type="search"
							value={term}
							placeholder="Search titles, details, fields and references"
							onChange={(e) => setTerm(e.target.value)}
						/>
						<Select
							value={typeFilter}
							onChange={setTypeFilter}
							options={[
								{ value: "", label: "Every type" },
								...types.map((t) => ({
									value: t.typeId,
									label: t.label,
								})),
							]}
						/>
						<Select
							value={impactFilter}
							onChange={setImpactFilter}
							options={[
								{ value: "", label: "Any impact" },
								{ value: "info", label: "Info" },
								{ value: "notable", label: "Notable" },
								{ value: "breaking", label: "Breaking" },
							]}
						/>
					</div>

					{(data?.drafts ?? []).length > 0 && (
						<div className={styles.drafts}>
							<strong>Your drafts</strong>
							{data?.drafts.map((draft) => (
								<button
									key={draft.updateId}
									type="button"
									className={styles.draftRow}
									onClick={() =>
										setComposing({
											...draft,
										} as unknown as Draft)
									}
								>
									{draft.title}
								</button>
							))}
						</div>
					)}

					{data && shown.length === 0 && (
						<EmptyState
							icon={emptyIcons.send}
							title={
								term || typeFilter || impactFilter
									? "Nothing matches"
									: "No updates yet"
							}
						>
							{term || typeFilter || impactFilter
								? "Try clearing the search or filters."
								: "Data changes, report changes, maintenance and announcements will appear here."}
						</EmptyState>
					)}
					<div className={styles.list}>
						{shown.map((update) => (
							<button
								key={update.updateId}
								type="button"
								className={`${styles.item} ${styles[`edge${update.impact}`]}`}
								onClick={() => setOpen(update.updateId)}
							>
								<span className={styles.metaRow}>
									<TypeBadge
										type={update.type}
										types={types}
									/>
									<span
										className={
											styles[`impact${update.impact}`]
										}
									>
										{capitalised(update.impact)}
									</span>
									{update.incidentState && (
										<span className={styles.state}>
											{capitalised(update.incidentState)}
										</span>
									)}
									{update.automatic && (
										<span className={styles.meta}>
											Automatic
										</span>
									)}
									{update.correctedOn && (
										<span className={styles.meta}>
											Corrected
										</span>
									)}
									<span
										className={`${styles.meta} ${styles.itemWhen}`}
									>
										{update.effectiveOn &&
										isPast(update.effectiveOn)
											? `Released ${when(update.effectiveOn)} · posted ${when(update.postedOn)}`
											: update.effectiveOn
												? `Takes effect ${when(update.effectiveOn)} · posted ${when(update.postedOn)}`
												: `Posted ${when(update.postedOn)}`}
									</span>
								</span>
								<strong className={styles.itemTitle}>
									{!update.read && (
										<span
											className={styles.unreadDot}
											aria-label="Not read yet"
										/>
									)}
									{update.title}
								</strong>
								{update.whatToDo && (
									<span className={styles.cardWhatToDo}>
										What to do: {update.whatToDo}
									</span>
								)}
								{update.about.length > 0 && (
									<AboutSummary
										sections={aboutSections(
											update.about,
											aboutNames(choices),
										)}
									/>
								)}
								{((update.authorsShown ?? []).length > 0 ||
									update.acks !== null) && (
									<span className={styles.meta}>
										{[
											(update.authorsShown ?? []).length >
											0
												? `By ${byline(update.authorsShown ?? [])}`
												: "",
											update.acks !== null
												? `Acknowledged by ${update.acks}`
												: "",
										]
											.filter(Boolean)
											.join(" · ")}
									</span>
								)}
							</button>
						))}
					</div>
				</>
			)}

			{tab === "calendar" && <Calendar updates={data?.updates ?? []} />}

			{tab === "following" && (
				<FollowingPane
					types={types}
					follows={data?.follows ?? []}
					onFollow={follow}
				/>
			)}

			{open && (
				<DetailDialog
					updateId={open}
					types={types}
					canModerate={data?.canModerate ?? false}
					selfEmail={me?.email ?? null}
					onChanged={() => void mutate()}
					onEdit={(update) => {
						setOpen(null);
						setComposing({ ...update } as unknown as Draft);
					}}
					onClose={() => setOpen(null)}
				/>
			)}
			{composing && (
				<Composer
					start={composing}
					types={types}
					templates={data?.templates ?? []}
					onDone={() => {
						setComposing(null);
						void mutate();
					}}
					onClose={() => setComposing(null)}
				/>
			)}
		</div>
	);
}

// What someone hears about and how. Three plain choices per row, each in place.
function FollowingPane({
	types,
	follows,
	onFollow,
}: {
	types: UpdateTypeDefinition[];
	follows: Follow[];
	onFollow: (
		kind: Follow["kind"],
		value: string,
		mode: Follow["mode"],
		on: boolean,
	) => Promise<void>;
}) {
	const choices = useUpdateChoices();
	const [kind, setKind] = useState<"source" | "field">("source");
	const [sourceKey, setSourceKey] = useState("");
	const sources = choices?.sources ?? [];
	const titleOf = (key: string) =>
		sources.find((source) => source.key === key)?.title ?? key;
	const rows = [
		{
			kind: "all" as const,
			value: "",
			label: "Everything",
			hint: "Every update you can read.",
		},
		...types.map((t) => ({
			kind: "type" as const,
			value: t.typeId,
			label: t.label,
			hint: `Whenever a new ${t.label.toLowerCase()} is posted.`,
		})),
		...follows
			.filter((f) => f.kind === "source" || f.kind === "field")
			.map((f) => ({
				kind: f.kind,
				value: f.value,
				label: f.kind === "source" ? titleOf(f.value) : f.value,
				hint:
					f.kind === "source"
						? "Anything about this source."
						: "Anything about this field.",
			})),
	];
	const modes: { id: "off" | Follow["mode"]; label: string }[] = [
		{ id: "off", label: "Off" },
		{ id: "instant", label: "As it happens" },
		{ id: "digest", label: "Daily digest" },
	];
	return (
		<div className={styles.follows}>
			<div className={styles.followIntro}>
				<strong>What following does</strong>
				<p>
					Updates you follow arrive in your Inbox, and on your phone
					if you have pushes on. <b>As it happens</b> sends each one
					when it is posted. <b>Daily digest</b> sends one message a
					day listing them. Breaking changes and maintenance still
					show across the app whatever you choose here.
				</p>
			</div>
			<div className={styles.followList}>
				{rows.map((row) => {
					const held = follows.find(
						(f) => f.kind === row.kind && f.value === row.value,
					);
					const current = held ? held.mode : "off";
					return (
						<div
							key={`${row.kind}:${row.value}`}
							className={styles.followRow}
						>
							<span className={styles.followWords}>
								<span className={styles.followLabel}>
									{row.label}
								</span>
								<span className={styles.meta}>{row.hint}</span>
							</span>
							<span
								className={styles.segments}
								role="group"
								aria-label={`How to hear about ${row.label}`}
							>
								{modes.map((mode) => (
									<button
										key={mode.id}
										type="button"
										aria-pressed={current === mode.id}
										className={`${styles.segment} ${current === mode.id ? styles.segmentOn : ""}`}
										onClick={() =>
											void onFollow(
												row.kind,
												row.value,
												mode.id === "digest"
													? "digest"
													: "instant",
												mode.id !== "off",
											)
										}
									>
										{mode.label}
									</button>
								))}
							</span>
						</div>
					);
				})}
			</div>
			<div className={styles.followAdd}>
				<strong className={styles.followLabel}>
					Follow one source or field
				</strong>
				<div className={form.row}>
					<Select
						value={kind}
						ariaLabel="Follow a source or a field"
						onChange={(next) => setKind(next as "source" | "field")}
						options={[
							{ value: "source", label: "A source" },
							{ value: "field", label: "A field" },
						]}
					/>
					{kind === "source" ? (
						<Select
							value=""
							placeholder="Choose a source"
							ariaLabel="Source"
							searchable
							onChange={(key) =>
								void onFollow("source", key, "instant", true)
							}
							options={sources.map((source) => ({
								value: source.key,
								label: source.title,
							}))}
						/>
					) : (
						<>
							<Select
								value={sourceKey}
								placeholder="Choose a source"
								ariaLabel="Source"
								searchable
								onChange={setSourceKey}
								options={sources.map((source) => ({
									value: source.key,
									label: source.title,
								}))}
							/>
							<Select
								value=""
								placeholder="Choose a field"
								ariaLabel="Field"
								searchable
								disabled={!sourceKey}
								onChange={(field) =>
									void onFollow(
										"field",
										field,
										"instant",
										true,
									)
								}
								options={(
									sources.find((s) => s.key === sourceKey)
										?.fields ?? []
								).map((field) => ({
									value: field,
									label: field,
								}))}
							/>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
