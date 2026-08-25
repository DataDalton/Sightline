"use client";

import { memo } from "react";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";
import styles from "./InfiniteScroll.module.css";

interface InfiniteScrollProps {
	hasMore: boolean;
	loading: boolean;
	onLoadMore: () => void;
	rootMargin?: string;
	children: React.ReactNode;
}

export const InfiniteScroll = memo(function InfiniteScroll({
	hasMore,
	loading,
	onLoadMore,
	rootMargin,
	children,
}: InfiniteScrollProps) {
	const sentinelRef = useInfiniteScroll({
		hasMore,
		loading,
		onLoadMore,
		rootMargin,
	});

	return (
		<div className={styles.container}>
			{children}
			<div ref={sentinelRef} className={styles.sentinel} />
			{loading && hasMore && (
				<div className={styles.loader}>
					<div className={styles.spinner} />
					<span>Loading more...</span>
				</div>
			)}
			{!hasMore && !loading && (
				<div className={styles.endMessage}>No more items</div>
			)}
		</div>
	);
});
