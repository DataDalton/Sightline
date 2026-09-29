"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { Condition, ConditionOp } from "../../lib/explore/conditions";
import { useNotify } from "../notify/NotifyContext";
import { isTemporalField, type SourceMeta } from "../visuals/types";
import styles from "../visuals/Visual.module.css";

// Loaded when the button is pressed, since every chart on every page carries
// the button and few are ever pressed.
const AlertDialog = dynamic(
	() => import("./AlertDialog").then((m) => m.AlertDialog),
	{ ssr: false },
);

// "Tell me if this looks unusual", on any chart or table in a report.
//
// Opens the alert dialog already set up from the visual: its dataset, its
// first measure, split by its first dimension that is not a date, read across
// its date field, narrowed by its own filters, and judged against its own
// history. Nothing to choose unless somebody wants to, which is what makes it
// something anybody will do from the page they are reading.

interface WatchedVisual {
	sourceKey: string | null;
	config: {
		dimensions?: string[];
		measures?: string[];
		filters?: unknown[];
	};
}

const ops = new Set<ConditionOp>([
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"contains",
	"starts_with",
	"ends_with",
	"is_empty",
	"is_not_empty",
]);

// The visual's own filters as alert conditions. Anything that is not a plain
// comparison on a field, such as a nested group, is left for the author to
// add in the dialog rather than guessed at.
function conditionsFrom(filters: unknown[] | undefined): Condition[] {
	return (filters ?? []).flatMap((raw) => {
		const f = (raw ?? {}) as Record<string, unknown>;
		const op = f.op as ConditionOp;
		if (typeof f.field !== "string" || !ops.has(op)) return [];
		if (f.field.startsWith("<")) return [];
		const scalar = (v: unknown) =>
			typeof v === "string" ||
			typeof v === "number" ||
			typeof v === "boolean";
		const values = Array.isArray(f.values)
			? f.values.filter(scalar).map(String)
			: null;
		const value = scalar(f.value) ? String(f.value) : null;
		const needsValue = op !== "is_empty" && op !== "is_not_empty";
		// A comparison with nothing to compare against would read as a
		// different rule, so it is left out rather than carried half formed.
		if (needsValue && !values?.length && value === null) return [];
		return [
			{
				field: f.field,
				op,
				...(values?.length
					? { values }
					: value !== null
						? { value }
						: {}),
				negate: f.negate === true,
				join: "and" as const,
			},
		];
	});
}

export function WatchAction({
	visual,
	sources,
}: {
	visual: WatchedVisual;
	sources: Record<string, SourceMeta>;
}) {
	const { alertsEnabled } = useNotify();
	const [open, setOpen] = useState(false);
	const [watching, setWatching] = useState(false);

	const source = visual.sourceKey ? sources[visual.sourceKey] : undefined;
	const measure = visual.config.measures?.[0];
	if (!alertsEnabled || !source || !measure) return null;

	const dimensions = visual.config.dimensions ?? [];
	const timeField =
		dimensions.find((d) => isTemporalField(source, d)) ??
		source.defaultTimeField ??
		null;
	const groupBy = dimensions.find((d) => !isTemporalField(source, d)) ?? null;

	return (
		<>
			<button
				type="button"
				className={`${styles.frameAction} ${watching ? styles.frameActionMarked : ""}`}
				onClick={() => setOpen(true)}
				title={
					watching
						? "Watching for anything unusual. Your alerts are under Inbox."
						: "Tell me if this looks unusual"
				}
				aria-label="Tell me if this looks unusual"
			>
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M3 12h4l3-8 4 16 3-8h4" />
				</svg>
			</button>
			{open && (
				<AlertDialog
					sources={Object.values(sources)}
					prefill={{
						sourceKey: source.sourceKey,
						measure,
						groupBy,
						conditions: conditionsFrom(visual.config.filters),
						condition: timeField ? "unusual" : "above",
						timeField,
					}}
					onClose={() => setOpen(false)}
					onSaved={() => {
						setOpen(false);
						setWatching(true);
					}}
				/>
			)}
		</>
	);
}
