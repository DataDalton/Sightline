"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The distinct values of a field, a page at a time.
//
// The filter list used to ask for two hundred and say "Showing first 200. Type
// to narrow." on anything longer. That is a cap presented as advice: a reader
// looking for a customer whose name starts with S was told to type rather than
// scroll, and a reader who did not know what they were looking for had no way
// through the list at all.
//
// Pages are stable because the query orders by the field ascending, so page two
// is the rows after page one rather than a fresh arbitrary slice. Each page is
// cached on the server by the same key as any other read, so scrolling back and
// forth costs one warehouse query per page and no more.

export interface ValuePages {
	values: string[];
	// Another page exists. Not the same as loading: a list that has run out
	// says so by turning this off.
	more: boolean;
	loading: boolean;
	error: string | null;
	// Attach to a sentinel at the end of the list. The next page is asked for
	// when it comes into view.
	sentinelRef: (node: HTMLElement | null) => void;
}

interface Request {
	sourceKey: string;
	field: string;
	search: string;
	filters: unknown[];
}

export function useValuePages(
	request: Request | null,
	pageSize = 100,
): ValuePages {
	const [values, setValues] = useState<string[]>([]);
	const [more, setMore] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The request as a string, so a caller rebuilding the same object on every
	// render does not restart the list.
	const key = request
		? JSON.stringify({
				s: request.sourceKey,
				f: request.field,
				q: request.search,
				fl: request.filters,
			})
		: null;

	// What has been asked for, so two observers firing in the same frame do not
	// both ask for page two. A ref rather than state because the guard has to
	// be read and set in one go, before any render.
	const asked = useRef<{ key: string | null; offset: number }>({
		key: null,
		offset: 0,
	});

	const load = useCallback(
		async (offset: number) => {
			if (!key || !request) return;
			// The same page twice, or a page for a request that has since
			// changed.
			if (asked.current.key === key && asked.current.offset > offset) {
				return;
			}
			asked.current = { key, offset: offset + pageSize };

			setLoading(true);
			setError(null);
			try {
				const response = await fetch("/api/query/values", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sourceKey: request.sourceKey,
						field: request.field,
						search: request.search,
						filters: request.filters,
						limit: pageSize,
						offset,
					}),
				});
				if (!response.ok) {
					const detail = await response.json().catch(() => null);
					throw new Error(
						detail?.error ?? `Request failed (${response.status})`,
					);
				}
				const body = (await response.json()) as {
					values: string[];
					truncated: boolean;
				};

				// Dropped where the request changed while this was in flight,
				// so an answer to the old question never lands in the new list.
				if (asked.current.key !== key) return;

				setValues((current) =>
					offset === 0 ? body.values : [...current, ...body.values],
				);
				setMore(body.truncated);
			} catch (err) {
				if (asked.current.key !== key) return;
				setError(err instanceof Error ? err.message : "Request failed");
				setMore(false);
			} finally {
				setLoading(false);
			}
		},
		[key, request, pageSize],
	);

	// A new question starts a new list. Cleared first rather than replaced on
	// arrival, so a reader never sees the previous field's values under the
	// heading of this one.
	useEffect(() => {
		if (!key) {
			setValues([]);
			setMore(false);
			asked.current = { key: null, offset: 0 };
			return;
		}
		setValues([]);
		setMore(false);
		asked.current = { key: null, offset: 0 };
		void load(0);
		// load is rebuilt whenever the key is, which is the only thing that
		// should restart the list.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);

	// The observer is attached through a callback ref rather than in an effect,
	// because the sentinel is inside a popover that mounts after this hook
	// runs, and an effect would have nothing to observe on its first pass.
	const observer = useRef<IntersectionObserver | null>(null);
	const pending = useRef({ more, loading, values });
	pending.current = { more, loading, values };

	const sentinelRef = useCallback(
		(node: HTMLElement | null) => {
			observer.current?.disconnect();
			if (!node) return;

			observer.current = new IntersectionObserver(
				(entries) => {
					if (!entries.some((e) => e.isIntersecting)) return;
					const state = pending.current;
					if (!state.more || state.loading) return;
					void load(state.values.length);
				},
				// A little early, so the next page is on its way before the
				// reader reaches the end of this one.
				{ rootMargin: "120px" },
			);
			observer.current.observe(node);
		},
		[load],
	);

	useEffect(() => () => observer.current?.disconnect(), []);

	return { values, more, loading, error, sentinelRef };
}
