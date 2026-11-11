"use client";

import { formatValue } from "../../lib/format";
import { usePostResource } from "../hooks/usePostResource";

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
//
// Drawn in the page's data status, which carries the page's notices as well.
// See app/r/DataHealth.

export interface FreshnessStamp {
	label: string;
	// The newest value, written for reading, or null while it is asked for.
	value: string | null;
	// Why the stamp says what it does, for its tooltip.
	explanation: string;
}

export function useFreshness({
	sourceKey,
	field,
	label,
	dataType,
}: {
	sourceKey: string | null;
	field: string | null;
	label?: string | null;
	dataType?: string | null;
}): FreshnessStamp | null {
	// Every page on a report carries this, and they mostly ask about the same
	// source, so one request answers all of them.
	// A live source says how soon to ask again, so the stamp keeps up with
	// the charts beside it.
	const { data, error, isLoading } = usePostResource<{
		value: string | null;
		refreshAfterMs?: number | null;
	}>(
		"/api/query/freshness",
		sourceKey && field ? { sourceKey, field } : null,
		(latest) => latest?.refreshAfterMs ?? 0,
	);

	if (!sourceKey || !field) return null;
	const value = data?.value ?? null;

	// A stamp that cannot be read is worse than none: it invites a reader to
	// treat a stale figure as current. Nothing is shown instead.
	if (error || (!isLoading && !value)) return null;

	const looksLikeDate =
		(dataType ?? "").startsWith("date") ||
		(dataType ?? "").startsWith("timestamp") ||
		/date|day|month|year/i.test(field);

	return {
		label: label ?? "Data through",
		value: isLoading
			? null
			: looksLikeDate
				? formatValue(value, "date")
				: String(value),
		explanation: `The latest ${field} in this data. Not affected by the filters on this page.`,
	};
}
