"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Select } from "../components/shared/Select";
import { SkeletonTable } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { usePageTitle } from "../hooks/usePageTitle";
import { describeFetchError } from "../../lib/swr";
import styles from "./Dictionary.module.css";

// What every field means, and what depends on it.
//
// The descriptions are written next to the data and synced from there, so this
// is a view onto definitions that already exist rather than a second set
// somebody has to keep current. What it adds is reach: until it existed they
// could only be read by opening a report built on the source and hovering the
// right column.

interface Field {
	sourceKey: string;
	sourceTitle: string;
	name: string;
	displayName: string | null;
	kind: "dimension" | "measure";
	dataType: string | null;
	description: string | null;
	formatHint: string | null;
	tags: Record<string, string>;
	folder: string | null;
	uses: number;
}

interface Usage {
	reportSlug: string;
	reportTitle: string;
	pageTitle: string | null;
	visualId: string;
	visualTitle: string | null;
	visualType: string;
	isPersonal: boolean;
	ownerEmail: string | null;
	usedAs: "dimension" | "measure" | "filter" | "sort";
}

type Shown = "all" | "dimension" | "measure" | "unused";

// How the view calculates a field, read from its definition.
interface Definition {
	expr: string;
	window: string | null;
	uses: string[];
	reads: string | null;
	filter: string | null;
	joins: { name: string; source: string; on: string }[];
}

// Rows drawn per step as the list scrolls.
const rowsPerPage = 150;

// A type as the warehouse spells it is not what somebody looking up a field
// wants to read. Only the head of it is kept, so DECIMAL(38,6) reads as a
// number without the precision nobody asked about.
function readableType(type: string | null): string {
	if (!type) return "";
	const head = type.split("(")[0].toLowerCase();
	if (/int|long|short|byte/.test(head)) return "whole number";
	if (/decimal|double|float|numeric/.test(head)) return "number";
	if (/timestamp|date/.test(head))
		return head.includes("date") ? "date" : "date and time";
	if (/bool/.test(head)) return "true or false";
	if (/string|varchar|char/.test(head)) return "text";
	return head;
}

export default function DictionaryView() {
	usePageTitle("Dictionary");

	const { data, error, isLoading } = useSWR<{ fields: Field[] }>(
		"/api/dictionary",
	);
	const showSkeleton = useDeferredLoading(isLoading);

	const [term, setTerm] = useState("");
	const [source, setSource] = useState("");
	const [shown, setShown] = useState<Shown>("all");
	const [open, setOpen] = useState<Field | null>(null);

	const fields = useMemo(() => data?.fields ?? [], [data]);

	// The whole catalogue arrives in one response, which is what makes the
	// search instant: a couple of thousand short rows is a small payload, and
	// asking the server again on every keystroke would be slower than filtering
	// what is already here. What is expensive is putting all of them in the
	// page at once, so rows are drawn a page at a time as the list is scrolled.
	const [drawn, setDrawn] = useState(rowsPerPage);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const sentinelRef = useRef<HTMLTableRowElement | null>(null);

	const sources = useMemo(() => {
		const seen = new Map<string, string>();
		for (const f of fields) seen.set(f.sourceKey, f.sourceTitle);
		return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
	}, [fields]);

	// Matched against the description as well as the name. Somebody who does
	// not know a field is called Net Amount searches for "revenue", and the
	// word is in the definition rather than in the key.
	const matching = useMemo(() => {
		const needle = term.trim().toLowerCase();
		return fields.filter((f) => {
			if (source && f.sourceKey !== source) return false;
			if (
				shown === "unused"
					? f.uses > 0
					: shown !== "all" && f.kind !== shown
			) {
				return false;
			}
			if (!needle) return true;
			return (
				f.name.toLowerCase().includes(needle) ||
				(f.displayName ?? "").toLowerCase().includes(needle) ||
				(f.description ?? "").toLowerCase().includes(needle)
			);
		});
	}, [fields, term, source, shown]);

	// A new search starts from the top of a fresh list.
	useEffect(() => {
		setDrawn(rowsPerPage);
		scrollRef.current?.scrollTo({ top: 0 });
	}, [term, source, shown]);

	useEffect(() => {
		const sentinel = sentinelRef.current;
		if (!sentinel) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					setDrawn((n) => n + rowsPerPage);
				}
			},
			{ root: scrollRef.current, rootMargin: "300px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [matching.length, drawn]);

	// Opens a field by name from inside the panel, so a ratio can be followed
	// back to the measures it divides.
	const openByName = (sourceKey: string, name: string) => {
		const target = fields.find(
			(f) => f.sourceKey === sourceKey && f.name === name,
		);
		if (target) setOpen(target);
	};

	if (error) {
		return (
			<div className={styles.page}>
				<div className={styles.state}>
					{describeFetchError(error, "dictionary")}
				</div>
			</div>
		);
	}

	return (
		<div className={styles.page}>
			<header className={styles.header}>
				<div>
					<h1 className={styles.title}>Dictionary</h1>
					<p className={styles.subtitle}>
						Every field on every source you can read, what it means,
						and which reports depend on it.
					</p>
				</div>
			</header>

			<div className={styles.controls}>
				<input
					className={styles.search}
					type="search"
					value={term}
					placeholder="Search names and definitions"
					aria-label="Search the dictionary"
					onChange={(e) => setTerm(e.target.value)}
				/>
				<Select
					value={source}
					onChange={setSource}
					ariaLabel="Source"
					searchable
					options={[
						{ value: "", label: "Every source" },
						...sources.map(([key, title]) => ({
							value: key,
							label: title,
						})),
					]}
				/>
				<div
					className={styles.segmented}
					role="group"
					aria-label="Show"
				>
					{(
						[
							["all", "All"],
							["dimension", "Dimensions"],
							["measure", "Measures"],
							["unused", "Unused"],
						] as [Shown, string][]
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							className={`${styles.segment} ${
								shown === id ? styles.segmentOn : ""
							}`}
							aria-pressed={shown === id}
							onClick={() => setShown(id)}
						>
							{label}
						</button>
					))}
				</div>
			</div>

			{showSkeleton && isLoading && (
				<SkeletonTable rows={10} columns={4} />
			)}

			{!isLoading && (
				<>
					<p className={styles.count}>
						{matching.length.toLocaleString()} of{" "}
						{fields.length.toLocaleString()} fields
						{shown === "unused" &&
							" that no visual references. Safe to retire, or missing from the reports that should use them."}
					</p>

					<div className={styles.tableWrap} ref={scrollRef}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th>Field</th>
									<th>Source</th>
									<th>Type</th>
									<th>Definition</th>
									<th className={styles.numeric}>Used on</th>
								</tr>
							</thead>
							<tbody>
								{matching.slice(0, drawn).map((f) => (
									<tr
										key={`${f.sourceKey}.${f.name}`}
										className={styles.row}
										onClick={() => setOpen(f)}
										title="See where this is used"
									>
										<td>
											<span className={styles.fieldName}>
												{f.displayName ?? f.name}
											</span>
											<span
												className={`${styles.kind} ${
													f.kind === "measure"
														? styles.kindMeasure
														: ""
												}`}
											>
												{f.kind}
											</span>
										</td>
										<td className={styles.muted}>
											{f.sourceTitle}
										</td>
										<td className={styles.muted}>
											{readableType(f.dataType)}
										</td>
										<td className={styles.definition}>
											{f.description ?? (
												<span
													className={styles.missing}
												>
													No definition written on the
													source
												</span>
											)}
										</td>
										<td className={styles.numeric}>
											{f.uses === 0 ? (
												<span
													className={styles.missing}
												>
													—
												</span>
											) : (
												f.uses
											)}
										</td>
									</tr>
								))}
								{drawn < matching.length && (
									<tr ref={sentinelRef}>
										<td colSpan={5} className={styles.more}>
											Loading more
										</td>
									</tr>
								)}
								{matching.length === 0 && (
									<tr>
										<td colSpan={5}>
											Nothing matches that.
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</>
			)}

			{open && (
				<UsagePanel
					key={`${open.sourceKey}.${open.name}`}
					field={open}
					onOpen={(name) => openByName(open.sourceKey, name)}
					onClose={() => setOpen(null)}
				/>
			)}
		</div>
	);
}

// Where one field is used.
//
// Fetched when the field is opened rather than with the list: the list is
// hundreds of rows and this is a handful per row, so asking for all of it up
// front is a query nobody reads the answer to.
function UsagePanel({
	field,
	onOpen,
	onClose,
}: {
	field: Field;
	onOpen: (name: string) => void;
	onClose: () => void;
}) {
	const { data, isLoading } = useSWR<{
		usage: Usage[];
		definition: Definition | null;
	}>(
		`/api/dictionary?sourceKey=${encodeURIComponent(field.sourceKey)}&field=${encodeURIComponent(field.name)}`,
	);

	const usage = data?.usage ?? [];
	const definition = data?.definition ?? null;

	// Grouped by report, because the question is which reports to check before
	// changing something, and a report listed eight times reads as eight
	// problems rather than one.
	const byReport = useMemo(() => {
		const groups = new Map<
			string,
			{ title: string; slug: string; on: Usage[] }
		>();
		for (const use of usage) {
			const held = groups.get(use.reportSlug);
			if (held) held.on.push(use);
			else
				groups.set(use.reportSlug, {
					title: use.reportTitle,
					slug: use.reportSlug,
					on: [use],
				});
		}
		return [...groups.values()];
	}, [usage]);

	return (
		<>
			<div
				className={styles.scrim}
				onClick={onClose}
				aria-hidden="true"
			/>
			<aside
				className={styles.panel}
				role="dialog"
				aria-label={`${field.displayName ?? field.name} usage`}
			>
				<header className={styles.panelHead}>
					<div>
						<h2 className={styles.panelTitle}>
							{field.displayName ?? field.name}
						</h2>
						<p className={styles.panelMeta}>
							{field.kind} on {field.sourceTitle}
							{field.dataType
								? `, ${readableType(field.dataType)}`
								: ""}
						</p>
					</div>
					<button
						type="button"
						className={styles.panelClose}
						onClick={onClose}
						aria-label="Close"
					>
						×
					</button>
				</header>

				{field.description && (
					<p className={styles.panelBody}>{field.description}</p>
				)}

				{/* The expression itself. The comment says what a field is meant
				    to be; this is what it is, and it is the only thing that
				    settles a disagreement between the two. */}
				<h3 className={styles.panelSection}>Calculation</h3>
				{isLoading && <SkeletonTable rows={1} columns={1} />}
				{!isLoading && !definition && (
					<p className={styles.panelNote}>
						The definition could not be read for this field.
					</p>
				)}
				{definition && (
					<>
						<pre className={styles.expr}>{definition.expr}</pre>

						{definition.uses.length > 0 && (
							<div className={styles.builtFrom}>
								<span className={styles.builtFromLabel}>
									Built from
								</span>
								{definition.uses.map((name) => (
									<button
										key={name}
										type="button"
										className={styles.measureLink}
										onClick={() => onOpen(name)}
									>
										{name}
									</button>
								))}
							</div>
						)}

						{definition.window && (
							<>
								<p className={styles.panelNote}>
									Calculated over a window, which decides what
									it accumulates or compares across:
								</p>
								<pre className={styles.expr}>
									{definition.window}
								</pre>
							</>
						)}

						{definition.reads && (
							<dl className={styles.facts}>
								<dt>Reads from</dt>
								<dd className={styles.mono}>
									{definition.reads}
								</dd>
								{definition.joins.map((join) => (
									<div
										key={join.name}
										className={styles.factPair}
									>
										<dt>Joined {join.name}</dt>
										<dd className={styles.mono}>
											{join.source} on {join.on}
										</dd>
									</div>
								))}
								{definition.filter && (
									<>
										<dt>Every row filtered by</dt>
										<dd className={styles.mono}>
											{definition.filter}
										</dd>
									</>
								)}
							</dl>
						)}
					</>
				)}

				{/* The key a query names it by, which is not always the label
				    above it and is what an author has to type. */}
				<dl className={styles.facts}>
					<dt>Query name</dt>
					<dd className={styles.mono}>{field.name}</dd>
					{field.formatHint && (
						<>
							<dt>Format</dt>
							<dd>{field.formatHint}</dd>
						</>
					)}
					{Object.entries(field.tags).map(([key, value]) => (
						<div key={key} className={styles.factPair}>
							<dt>{key}</dt>
							<dd>{value}</dd>
						</div>
					))}
				</dl>

				<h3 className={styles.panelSection}>Used on</h3>

				{isLoading && <SkeletonTable rows={3} columns={2} />}

				{!isLoading && byReport.length === 0 && (
					<p className={styles.panelNote}>
						No visual you can open references this field. It is
						either new, retired, or used only on reports you cannot
						reach.
					</p>
				)}

				{byReport.map((report) => (
					<div key={report.slug} className={styles.usageGroup}>
						<Link
							href={`/r/${report.slug}`}
							className={styles.usageReport}
						>
							{report.title}
						</Link>
						<ul className={styles.usageList}>
							{report.on.map((use) => (
								<li key={use.visualId}>
									<span className={styles.usageVisual}>
										{use.visualTitle ?? use.visualType}
									</span>
									<span className={styles.usageWhere}>
										{use.pageTitle
											? `${use.pageTitle}, as a ${use.usedAs}`
											: `as a ${use.usedAs}`}
									</span>
								</li>
							))}
						</ul>
					</div>
				))}
			</aside>
		</>
	);
}
