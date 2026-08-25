"use client";

import { useEffect, useState } from "react";
import { formatValue } from "../../lib/format";
import styles from "./Filters.module.css";

// How current the data on a page is.
//
// Every page carries one, in the same place, reading the same way. A reader
// deciding whether a number is worth acting on needs to know when it stopped
// moving, and the alternative to a standard stamp is each report answering the
// question differently or not at all.
//
// The field is an editor's choice because only they know which column means
// "when this was true": an order date, a paid date, a load timestamp. The
// source's own time field is the fallback so a page shows something sensible
// before anyone configures it.

interface DataFreshnessProps {
	sourceKey: string;
	field: string;
	label?: string | null;
	dataType?: string | null;
}

export function DataFreshness({
	sourceKey,
	field,
	label,
	dataType,
}: DataFreshnessProps) {
	const [value, setValue] = useState<string | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

	useEffect(() => {
		let cancelled = false;
		setState("loading");

		fetch("/api/query/freshness", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sourceKey, field }),
		})
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
			.then((data: { value: string | null }) => {
				if (cancelled) return;
				setValue(data.value);
				setState("ready");
			})
			.catch(() => {
				if (!cancelled) setState("failed");
			});

		return () => {
			cancelled = true;
		};
	}, [sourceKey, field]);

	// A stamp that cannot be read is worse than none: it invites a reader to
	// treat a stale figure as current. Nothing is shown instead.
	if (state === "failed" || (state === "ready" && !value)) return null;

	const looksLikeDate =
		(dataType ?? "").startsWith("date") ||
		(dataType ?? "").startsWith("timestamp") ||
		/date|day|month|year/i.test(field);

	return (
		<div
			className={styles.freshness}
			title={`The latest ${field} in this data. Not affected by the filters on this page.`}
		>
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 7v5l3 2" />
			</svg>
			<span className={styles.freshnessLabel}>{label ?? "Data through"}</span>
			<span className={styles.freshnessValue}>
				{state === "loading"
					? "…"
					: looksLikeDate
						? formatValue(value, "date")
						: String(value)}
			</span>
		</div>
	);
}
