"use client";

import { useRef, useEffect, useCallback } from "react";

interface UseInfiniteScrollOptions {
	hasMore: boolean;
	loading: boolean;
	onLoadMore: () => void;
	rootMargin?: string;
}

export function useInfiniteScroll({
	hasMore,
	loading,
	onLoadMore,
	rootMargin = "200px",
}: UseInfiniteScrollOptions) {
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	const observerRef = useRef<IntersectionObserver | null>(null);

	const handleIntersect = useCallback(
		(entries: IntersectionObserverEntry[]) => {
			const entry = entries[0];
			if (entry.isIntersecting && hasMore && !loading) {
				onLoadMore();
			}
		},
		[hasMore, loading, onLoadMore],
	);

	useEffect(() => {
		if (observerRef.current) {
			observerRef.current.disconnect();
		}

		observerRef.current = new IntersectionObserver(handleIntersect, {
			rootMargin,
		});

		const sentinel = sentinelRef.current;
		if (sentinel) {
			observerRef.current.observe(sentinel);
		}

		return () => {
			if (observerRef.current) {
				observerRef.current.disconnect();
			}
		};
	}, [handleIntersect, rootMargin]);

	return sentinelRef;
}
