"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
	examinePage,
	gradeFor,
	reportGrade,
	untimedVisuals,
	slowAfterMs,
	speedRanking,
	verySlowAfterMs,
	applyFix,
	type DoctorFix,
} from "../../lib/visuals/reportDoctor";
import { isPageControl } from "../../lib/visuals/catalog";
import type { SourceMeta } from "../visuals/types";
import type { EditableVisual } from "./types";
import styles from "./Editor.module.css";

// The report doctor. The grade of the page and of the whole report, what is wrong, how long
// each visual takes and how readers use it. Speed and use can also be shown on the canvas.

export type CanvasOverlayMode = "off" | "speed" | "use";

export interface CanvasBadge {
	text: string;
	tone: "good" | "warn" | "bad" | "quiet";
	// Null leaves the visual untinted.
	heat: number | null;
}

// What to show over each visual, by id. Null when nothing is being shown.
export const CanvasOverlayContext = createContext<Record<
	string,
	CanvasBadge
> | null>(null);

export function useCanvasBadge(visualId: string): CanvasBadge | null {
	return useContext(CanvasOverlayContext)?.[visualId] ?? null;
}

export interface Timing {
	warehouseMs: number | null;
	rowCount: number | null;
	note: string | null;
}

interface Readership {
	pages: { pageId: string; readers: number }[];
	visuals: { visualId: string; actions: number; readers: number }[];
}

function secondsText(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function speedTone(ms: number): CanvasBadge["tone"] {
	if (ms >= verySlowAfterMs) return "bad";
	if (ms >= slowAfterMs) return "warn";
	return "good";
}

// A page of the report as published, graded whole-report.
export interface DoctorPage {
	pageId: string;
	title: string;
	sourceKey: string | null;
	config: unknown;
	visuals: EditableVisual[];
}

// The editor is rebuilt for each page, so timings for the whole report and the page to reopen
// the doctor on are held here for the length of the visit.
const reportTimings = new Map<string, Record<string, Timing>>();
let doctorOpenOn: string | null = null;

export function doctorOpensOn(pageId: string): boolean {
	return doctorOpenOn === pageId;
}

export function useReadership(slug: string, enabled: boolean) {
	return useSWR<Readership>(
		enabled
			? `/api/report/${encodeURIComponent(slug)}/readership?days=30`
			: null,
	).data;
}

// What the canvas shows for the chosen overlay.
export function overlayBadges(
	mode: CanvasOverlayMode,
	visuals: EditableVisual[],
	timings: Record<string, Timing>,
	readership: Readership | undefined,
): Record<string, CanvasBadge> | null {
	if (mode === "off") return null;
	const badges: Record<string, CanvasBadge> = {};
	const shown = visuals.filter((v) => !isPageControl(v.visualType));

	if (mode === "speed") {
		for (const visual of shown) {
			const timing = timings[visual.visualId];
			badges[visual.visualId] =
				timing?.warehouseMs != null
					? {
							text: secondsText(timing.warehouseMs),
							tone: speedTone(timing.warehouseMs),
							heat: null,
						}
					: { text: "Not timed", tone: "quiet", heat: null };
		}
		return badges;
	}

	const use = new Map(readership?.visuals.map((v) => [v.visualId, v]));
	const most = Math.max(1, ...[...use.values()].map((v) => v.readers));
	for (const visual of shown) {
		const readers = use.get(visual.visualId)?.readers ?? 0;
		badges[visual.visualId] = {
			text: readers === 1 ? "1 person" : `${readers} people`,
			tone: readers === 0 ? "quiet" : "good",
			heat: readers / most,
		};
	}
	return badges;
}

export function ReportCheckPanel({
	slug,
	visuals,
	reportPages,
	onOpenPage,
	sources,
	pageId,
	pageSourceKey,
	pageConfig,
	canSeeUse,
	readOnly,
	timings,
	onTimings,
	overlay,
	onOverlay,
	readership,
	onSelect,
	onApply,
	onClose,
}: {
	slug: string;
	visuals: EditableVisual[];
	reportPages: DoctorPage[];
	onOpenPage: (pageId: string) => void;
	sources: Record<string, SourceMeta>;
	pageId: string;
	pageSourceKey: string | null;
	pageConfig: unknown;
	canSeeUse: boolean;
	readOnly: boolean;
	timings: Record<string, Timing>;
	onTimings: (next: Record<string, Timing>) => void;
	overlay: CanvasOverlayMode;
	onOverlay: (next: CanvasOverlayMode) => void;
	readership: Readership | undefined;
	onSelect: (visualId: string) => void;
	onApply: (next: EditableVisual) => void;
	onClose: () => void;
}) {
	const [timing, setTiming] = useState(false);
	const [progress, setProgress] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [scope, setScope] = useState<"page" | "report">(() =>
		doctorOpensOn(pageId) ? "report" : "page",
	);
	const [held, setHeld] = useState<Record<string, Timing>>(
		() => reportTimings.get(slug) ?? {},
	);
	useEffect(() => {
		doctorOpenOn = null;
	}, []);
	const known = useMemo(() => ({ ...held, ...timings }), [held, timings]);
	const remember = (next: Record<string, Timing>) => {
		const merged = { ...(reportTimings.get(slug) ?? {}), ...next };
		reportTimings.set(slug, merged);
		setHeld(merged);
	};

	const examine = useMemo(
		() =>
			(
				page: string,
				onPage: EditableVisual[],
				fallbackSource: string | null,
			) =>
				examinePage({
					visuals: onPage.map((v) => ({
						...v,
						sourceKey: v.sourceKey ?? fallbackSource,
					})) as never,
					timings: known,
					usage: readership
						? {
								pageReaders:
									readership.pages.find(
										(p) => p.pageId === page,
									)?.readers ?? 0,
								visuals: Object.fromEntries(
									readership.visuals.map((v) => [
										v.visualId,
										{
											actions: v.actions,
											readers: v.readers,
										},
									]),
								),
							}
						: undefined,
					sourceFields: (sourceKey) => {
						const source = sources[sourceKey];
						return source
							? {
									dimensions: source.dimensions.map(
										(f) => f.name,
									),
									measures: source.measures.map(
										(f) => f.name,
									),
								}
							: null;
					},
				}),
		[known, readership, sources],
	);

	const findings = useMemo(
		() => examine(pageId, visuals, pageSourceKey),
		[examine, pageId, visuals, pageSourceKey],
	);
	const grade = gradeFor(findings);
	const untimed = untimedVisuals(visuals as never, known);

	// This page as it stands in the editor, every other page as published.
	const pageResults = useMemo(
		() =>
			reportPages.map((page) => {
				const onPage = page.pageId === pageId ? visuals : page.visuals;
				const found = examine(
					page.pageId,
					onPage,
					page.pageId === pageId ? pageSourceKey : page.sourceKey,
				);
				return {
					page,
					onPage,
					found,
					grade: gradeFor(found),
					untimed: untimedVisuals(onPage as never, known),
				};
			}),
		[reportPages, pageId, visuals, pageSourceKey, examine, known],
	);
	const wholeGrade = reportGrade(pageResults.map((row) => row.grade));
	const pagesUntimed = pageResults.filter((row) => row.untimed > 0).length;
	const ranked = speedRanking(visuals as never, timings);
	const notes = visuals.flatMap((visual) =>
		timings[visual.visualId]?.note
			? [
					{
						visualId: visual.visualId,
						title: visual.title,
						note: timings[visual.visualId].note,
					},
				]
			: [],
	);
	const totalMs = ranked.reduce((sum, row) => sum + row.warehouseMs, 0);

	const timeVisuals = async (
		onPage: EditableVisual[],
		fallbackSource: string | null,
		config: unknown,
	): Promise<Record<string, Timing>> => {
		const response = await fetch(
			`/api/report/${encodeURIComponent(slug)}/xray`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					visuals: onPage.map((v) => ({
						visualId: v.visualId,
						visualType: v.visualType,
						sourceKey: v.sourceKey,
						title: v.title,
						config: v.config,
					})),
					pageSourceKey: fallbackSource,
					pageConfig: config,
				}),
			},
		);
		const detail = await response.json().catch(() => null);
		if (!response.ok) {
			throw new Error(detail?.error ?? "Could not time this page.");
		}
		const next: Record<string, Timing> = {};
		for (const row of detail.timings as (Timing & {
			visualId: string;
		})[]) {
			next[row.visualId] = row;
		}
		return next;
	};

	// One page after another, so a whole report does not ask the warehouse for everything at once.
	const timeEveryPage = async () => {
		setTiming(true);
		setFailure(null);
		try {
			for (const [index, row] of pageResults.entries()) {
				setProgress(
					`Timing page ${index + 1} of ${pageResults.length}`,
				);
				const isHere = row.page.pageId === pageId;
				const next = await timeVisuals(
					row.onPage,
					isHere ? pageSourceKey : row.page.sourceKey,
					isHere ? pageConfig : row.page.config,
				);
				remember(next);
				if (isHere) onTimings(next);
			}
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not time this report.",
			);
		} finally {
			setProgress(null);
			setTiming(false);
		}
	};

	const timePage = async () => {
		setTiming(true);
		setFailure(null);
		try {
			const next = await timeVisuals(visuals, pageSourceKey, pageConfig);
			remember(next);
			onTimings(next);
			onOverlay("speed");
		} catch (error) {
			setFailure(
				error instanceof Error
					? error.message
					: "Could not time this page.",
			);
		} finally {
			setTiming(false);
		}
	};

	const fix = (visualId: string | null, how: DoctorFix) => {
		const visual = visuals.find((v) => v.visualId === visualId);
		if (visual) onApply(applyFix(visual as never, how) as never);
	};

	return (
		<div className={styles.panel}>
			<div className={styles.panelHead}>
				<span className={styles.panelKind}>Report doctor</span>
				<span className={styles.panelSubject}>
					{scope === "page" ? "This page" : "Whole report"}
				</span>
				<button
					type="button"
					className={styles.panelBack}
					onClick={onClose}
					aria-label="Close"
				>
					×
				</button>
			</div>
			<div className={styles.panelBody}>
				<div
					className={`${styles.checkOverlayChoices} ${styles.checkScope}`}
				>
					{(
						[
							["page", "This page"],
							["report", "Whole report"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							className={`${styles.toolButton} ${
								scope === value ? styles.primary : ""
							}`}
							aria-pressed={scope === value}
							onClick={() => setScope(value)}
						>
							{label}
						</button>
					))}
				</div>

				{scope === "report" && (
					<>
						<div className={styles.checkGrade}>
							<span
								className={`${styles.checkGradeLetter} ${
									pagesUntimed > 0
										? styles.checkGradeUnchecked
										: styles[`checkGrade${wholeGrade}`]
								}`}
							>
								{wholeGrade}
							</span>
							<span className={styles.hint}>
								{pagesUntimed > 0
									? `Not fully checked. ${pagesUntimed} of ${pageResults.length} pages still need timing, which is how speed, slices and bars are checked.`
									: "Graded by its weakest page."}
							</span>
						</div>
						<button
							type="button"
							className={styles.saveButton}
							disabled={timing}
							onClick={() => void timeEveryPage()}
						>
							{progress ??
								(pagesUntimed === 0
									? "Time every page again"
									: "Time every page")}
						</button>
						{failure && (
							<div className={styles.panelError}>{failure}</div>
						)}
						<div className={styles.checkPageList}>
							{pageResults.map((row) => (
								<button
									key={row.page.pageId}
									type="button"
									className={styles.checkPageRow}
									onClick={() => {
										if (row.page.pageId === pageId) {
											setScope("page");
											return;
										}
										doctorOpenOn = row.page.pageId;
										onOpenPage(row.page.pageId);
									}}
								>
									<span
										className={`${styles.checkGradeLetter} ${
											row.untimed > 0
												? styles.checkGradeUnchecked
												: styles[
														`checkGrade${row.grade}`
													]
										}`}
									>
										{row.grade}
									</span>
									<span className={styles.checkPageWords}>
										{row.page.title}
										<span className={styles.panelAbout}>
											{row.found.length === 0
												? "Nothing to fix"
												: `${row.found.length} thing${row.found.length === 1 ? "" : "s"} to look at`}
											{row.untimed > 0
												? ", not timed"
												: ""}
										</span>
									</span>
								</button>
							))}
						</div>
					</>
				)}

				{scope === "page" && (
					<>
						<div className={styles.checkGrade}>
							<span
								className={`${styles.checkGradeLetter} ${
									untimed > 0
										? styles.checkGradeUnchecked
										: styles[`checkGrade${grade}`]
								}`}
							>
								{grade}
							</span>
							<span className={styles.hint}>
								{untimed > 0
									? `Not fully checked. ${findings.length === 0 ? "Nothing wrong so far" : `${findings.length} thing${findings.length === 1 ? "" : "s"} to look at so far`}. Time the page to check speed, slices and bars.`
									: findings.length === 0
										? "Nothing to fix on this page."
										: `${findings.length} thing${findings.length === 1 ? "" : "s"} to look at.`}
							</span>
						</div>

						{findings.map((finding) => (
							<div
								key={finding.key}
								className={styles.checkFinding}
							>
								<button
									type="button"
									className={styles.checkFindingTitle}
									disabled={!finding.visualId}
									onClick={() =>
										finding.visualId &&
										onSelect(finding.visualId)
									}
								>
									<span
										className={
											finding.severity === "problem"
												? styles.checkDotBad
												: styles.checkDotWarn
										}
										aria-hidden="true"
									/>
									{finding.title}
								</button>
								<p className={styles.hint}>{finding.detail}</p>
								{finding.fix && !readOnly && (
									<button
										type="button"
										className={styles.saveButton}
										onClick={() =>
											fix(
												finding.visualId,
												finding.fix as DoctorFix,
											)
										}
									>
										{finding.fix.label}
									</button>
								)}
							</div>
						))}

						<div className={styles.field}>
							<label className={styles.fieldLabel}>Speed</label>
							<p className={styles.hint}>
								Runs each visual against the warehouse as you,
								skipping the cache, so it shows what the first
								reader waits for.
							</p>
							<button
								type="button"
								className={styles.saveButton}
								disabled={timing}
								onClick={() => void timePage()}
							>
								{timing
									? "Timing"
									: ranked.length > 0
										? "Time again"
										: "Time this page"}
							</button>
							{failure && (
								<div className={styles.panelError}>
									{failure}
								</div>
							)}
						</div>

						{ranked.length > 0 && (
							<div className={styles.field}>
								<p className={styles.hint}>
									{secondsText(totalMs)} of warehouse time in
									total.
								</p>
								{ranked.map((row) => (
									<button
										key={row.visualId}
										type="button"
										className={styles.checkSpeedRow}
										onClick={() => onSelect(row.visualId)}
									>
										<span className={styles.checkSpeedName}>
											{row.title}
										</span>
										<span
											className={
												styles[
													`checkTone${speedTone(row.warehouseMs)}`
												]
											}
										>
											{secondsText(row.warehouseMs)}
										</span>
										<span
											className={styles.checkSpeedBar}
											style={{ width: `${row.share}%` }}
											aria-hidden="true"
										/>
									</button>
								))}
								{notes.map((row) => (
									<p
										key={row.visualId}
										className={styles.hint}
									>
										{row.title || "A visual"}: {row.note}
									</p>
								))}
							</div>
						)}

						<div className={styles.field}>
							<label className={styles.fieldLabel}>
								Show on the canvas
							</label>
							<div className={styles.checkOverlayChoices}>
								{(
									[
										["off", "Nothing"],
										["speed", "Speed"],
										...(canSeeUse
											? [["use", "Reader use"]]
											: []),
									] as [CanvasOverlayMode, string][]
								).map(([value, label]) => (
									<button
										key={value}
										type="button"
										className={`${styles.toolButton} ${
											overlay === value
												? styles.primary
												: ""
										}`}
										aria-pressed={overlay === value}
										onClick={() => onOverlay(value)}
									>
										{label}
									</button>
								))}
							</div>
							{overlay === "use" && (
								<p className={styles.hint}>
									People who expanded, opened the figures of,
									or selected in each visual over the last 30
									days. Reading one without touching it is not
									counted.
								</p>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
