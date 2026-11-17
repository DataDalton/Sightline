"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// A page's tab, kept in the address.
//
// Switching tabs adds a history entry, so the browser's back button returns to
// the tab the reader was on rather than leaving the page, and a link copied
// from the address bar opens on the same tab. The default tab is left out of
// the address, so a plain link to the page stays plain.
export function useTabParam<T extends string>(
	key: string,
	tabs: readonly T[],
	fallback: T,
): [T, (next: T) => void] {
	const params = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();
	const named = params?.get(key);
	const current = tabs.includes(named as T) ? (named as T) : fallback;

	const choose = useCallback(
		(next: T) => {
			if (next === current) return;
			const query = new URLSearchParams(window.location.search);
			if (next === fallback) query.delete(key);
			else query.set(key, next);
			const search = query.toString();
			router.push(`${pathname}${search ? `?${search}` : ""}`, {
				scroll: false,
			});
		},
		[current, fallback, key, pathname, router],
	);

	return [current, choose];
}
