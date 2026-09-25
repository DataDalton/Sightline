"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { SkeletonText } from "../components/shared/Skeleton";
import { useDeferredLoading } from "../hooks/useDeferredLoading";
import { usePageTitle } from "../hooks/usePageTitle";
import { describeFetchError } from "../../lib/swr";
import { toFilterLogic, type Condition } from "../../lib/explore/conditions";
import { DataGrid } from "../visuals/DataGrid";
import { fieldMap, type SourceMeta } from "../visuals/types";
import {
	decodeState,
	encodeState,
	type ExploreState,
} from "../../lib/explore/state";
import { ExploreBar } from "./ExploreBar";
import { SavedViews, type SavedView } from "./SavedViews";
import styles from "./Explore.module.css";

// A table of whatever somebody wants to see, built from one search bar.
//
// The question that reaches an editor most often is not a report, it is one
// table somebody needs once. Here it is typed: a dataset, the columns, and
// conditions joined by and, or and not. The table follows the bar as it
// changes, so there is nothing to submit.
//
// Every query goes through the endpoint every report uses, under the reader's
// own access, so the rows are filtered exactly as a report's would be.
//
// The exploration lives in the address as it changes, so a reload comes back to
// it and copying the address shares it. It can also be saved by name.

export default function ExploreView() {
	usePageTitle("Explore");

	const { data, error, isLoading } = useSWR<{ sources: SourceMeta[] }>(
		"/api/authoring",
	);
	const showSkeleton = useDeferredLoading(isLoading);

	const [sourceKey, setSourceKey] = useState("");
	const [columns, setColumns] = useState<string[]>([]);
	const [conditions, setConditions] = useState<Condition[]>([]);
	// The saved view that is open, and what it held when opened or last
	// saved, which is how "modified" is known.
	const [openView, setOpenView] = useState<{
		id: string;
		name: string;
		saved: string;
	} | null>(null);
	const [restored, setRestored] = useState(false);

	const apply = (state: ExploreState) => {
		setSourceKey(state.sourceKey);
		setColumns(state.columns);
		setConditions(state.conditions);
	};

	// Read once on arrival, after mount so the server render and the first
	// client render agree.
	useEffect(() => {
		const q = new URLSearchParams(window.location.search).get("q");
		const state = q ? decodeState(q) : null;
		if (state) apply(state);
		setRestored(true);
	}, []);

	const current: ExploreState | null = sourceKey
		? { sourceKey, columns, conditions }
		: null;
	const encoded = current ? encodeState(current) : "";

	// Written back as it changes. Replaced rather than pushed, so the back
	// button leaves the page instead of undoing one chip at a time.
	useEffect(() => {
		if (!restored) return;
		const url = new URL(window.location.href);
		if (encoded) url.searchParams.set("q", encoded);
		else url.searchParams.delete("q");
		window.history.replaceState(null, "", url.toString());
	}, [encoded, restored]);

	const openSaved = (view: SavedView) => {
		apply(view.state);
		setOpenView({
			id: view.id,
			name: view.name,
			saved: encodeState(view.state),
		});
	};

	const sources = useMemo(
		() =>
			[...(data?.sources ?? [])].sort((a, b) =>
				a.title.localeCompare(b.title),
			),
		[data],
	);
	const source = sources.find((s) => s.sourceKey === sourceKey);
	const fields = useMemo(() => fieldMap(source), [source]);

	const measureNames = useMemo(
		() => new Set(source?.measures.map((m) => m.name) ?? []),
		[source],
	);
	const dimensions = columns.filter((c) => !measureNames.has(c));
	const measures = columns.filter((c) => measureNames.has(c));

	const kinds = useMemo(
		() =>
			new Map<string, "dimension" | "measure">([
				...(source?.dimensions ?? []).map(
					(f) => [f.name, "dimension"] as const,
				),
				...(source?.measures ?? []).map(
					(f) => [f.name, "measure"] as const,
				),
			]),
		[source],
	);
	const logic = useMemo(
		() => toFilterLogic(conditions, kinds),
		[conditions, kinds],
	);

	const switchSource = (key: string) => {
		// Field names belong to a dataset, so none of them carry across.
		setSourceKey(key);
		setColumns([]);
		setConditions([]);
		if (!key) setOpenView(null);
	};

	if (error) {
		return (
			<div className={styles.page}>
				<div className={styles.state}>
					{describeFetchError(error, "datasets")}
				</div>
			</div>
		);
	}

	return (
		<div className={styles.page}>
			<header className={styles.headerRow}>
				<div className={styles.header}>
					<h1 className={styles.title}>
						Explore
						{openView && (
							<span className={styles.viewTitle}>
								{openView.name}
								{openView.saved !== encoded && (
									<span className={styles.viewModified}>
										edited
									</span>
								)}
							</span>
						)}
					</h1>
					<p className={styles.subtitle}>
						Type a dataset, the columns you want, and any
						conditions. Use <b>and</b>, <b>or</b> and <b>not</b>,
						and click a condition to change it.
					</p>
				</div>
				<SavedViews
					current={current}
					currentView={openView}
					modified={Boolean(openView && openView.saved !== encoded)}
					sourceTitle={(key) =>
						sources.find((s) => s.sourceKey === key)?.title ?? key
					}
					onOpen={openSaved}
					onSaved={(view) =>
						setOpenView({
							id: view.id,
							name: view.name,
							saved: encodeState(view.state),
						})
					}
				/>
			</header>

			{showSkeleton && isLoading && <SkeletonText lines={2} />}

			{!isLoading && (
				<ExploreBar
					sources={sources}
					source={source}
					columns={columns}
					conditions={conditions}
					onSource={switchSource}
					onColumns={setColumns}
					onConditions={setConditions}
				/>
			)}

			{logic.problem && <p className={styles.problem}>{logic.problem}</p>}

			{!isLoading && !source && (
				<div className={styles.state}>
					Start by typing the name of a dataset, or of a field you
					know.
				</div>
			)}

			{source && columns.length === 0 && (
				<div className={styles.state}>
					Add a column to see rows from {source.title}.
				</div>
			)}

			{source && columns.length > 0 && !logic.problem && (
				<DataGrid
					// A different dataset is a different table, not the same
					// one with new columns.
					key={source.sourceKey}
					sourceKey={source.sourceKey}
					dimensions={dimensions}
					measures={measures}
					baseFilters={logic.filters}
					anyOf={logic.anyOf}
					fields={fields}
					height="calc(100vh - var(--header-height) - 300px)"
					showTotals={measures.length > 0}
				/>
			)}
		</div>
	);
}
