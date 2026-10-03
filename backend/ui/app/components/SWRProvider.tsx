"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { SWRConfig, type Middleware } from "swr";
import { cache, SWRGlobalState } from "swr/_internal";
import { swrDefaults } from "../../lib/swr";

// Answers held in the browser at most, before the least recently read ones are
// let go. A key let go is fetched again the next time something asks for it.
const cacheBound = 600;
// Eviction runs down to this many, so it runs once per batch of new keys
// rather than on every one.
const cacheFloor = 500;

// Bounds SWR's default cache in place.
//
// The default cache stays the one in use, because the global mutate imported
// from swr writes to it. Each read and write records when the key was last
// touched, and once there are too many keys the least recently touched are
// deleted. A key with a mounted hook, a fetch under way or a mutation under way
// is never deleted, and neither is an internal key, which starts with "$".
function boundCache() {
	const map = cache as Map<string, unknown>;
	if ((map as { bounded?: boolean }).bounded) return;
	(map as { bounded?: boolean }).bounded = true;
	const touched = new Map<string, number>();
	let tick = 0;
	const get = map.get.bind(map);
	const set = map.set.bind(map);
	const remove = map.delete.bind(map);

	const inUse = (key: string): boolean => {
		if (key.startsWith("$")) return true;
		const state = SWRGlobalState.get(cache);
		if (!state) return true;
		const [revalidators, mutations, fetches] = state;
		return (
			(revalidators[key]?.length ?? 0) > 0 ||
			mutations[key]?.[1] === 0 ||
			key in fetches
		);
	};

	const evict = () => {
		const oldest = [...map.keys()]
			.filter((key) => !inUse(key))
			.sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0));
		for (const key of oldest) {
			if (map.size <= cacheFloor) break;
			remove(key);
			touched.delete(key);
		}
	};

	map.get = (key: string) => {
		const value = get(key);
		if (value !== undefined) touched.set(key, ++tick);
		return value;
	};
	map.set = (key: string, value: unknown) => {
		touched.set(key, ++tick);
		set(key, value);
		if (map.size > cacheBound) evict();
		return map;
	};
	map.delete = (key: string) => {
		touched.delete(key);
		return remove(key);
	};
}

if (typeof window !== "undefined") boundCache();

// Keys the server answered while rendering this document. Those answers are
// as fresh as anything a request could fetch, so a hook mounting with one is
// not sent to fetch it again. SWR otherwise treats a seeded value as stale and
// asks for it the moment the page mounts, which made every page load ask the
// server for what it had just sent. Cleared on the first move to another
// page, after which those keys are fetched on mount as any other key is.
const seededFresh = new Set<string>();

// Answers a page rendered on the server handed over for its own requests,
// keyed as the client asks for them. A hook asking one of these starts from it
// and does not fetch it again, as with the shell's keys above.
const pageSeeds = new Map<string, unknown>();

// Called while the page renders, before the hooks under it mount.
export function seedResponses(answers: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(answers)) {
		pageSeeds.set(key, value);
		seededFresh.add(key);
	}
}

const trustSeeded: Middleware = (useSWRNext) => (key, fetcher, config) => {
	if (typeof key !== "string" || !seededFresh.has(key))
		return useSWRNext(key, fetcher, config);
	return useSWRNext(key, fetcher, {
		...config,
		revalidateOnMount: false,
		...(pageSeeds.has(key)
			? { fallbackData: pageSeeds.get(key) as typeof config.fallbackData }
			: {}),
	});
};

// Seeded with what the server already knew.
//
// Every key here is one request the browser does not have to make before it can
// render. SWR treats fallback data as the first value rather than as a cache
// entry, so the component renders with it immediately.
export default function SWRProvider({
	fallback,
	children,
}: {
	fallback?: Record<string, unknown>;
	children: React.ReactNode;
}) {
	const seeded = useRef(false);
	if (!seeded.current) {
		seeded.current = true;
		for (const key of Object.keys(fallback ?? {})) seededFresh.add(key);
	}
	const pathname = usePathname();
	const firstPath = useRef(pathname);
	useEffect(() => {
		if (pathname !== firstPath.current) {
			seededFresh.clear();
			pageSeeds.clear();
		}
	}, [pathname]);
	return (
		<SWRConfig
			value={{
				...swrDefaults,
				fallback: fallback ?? {},
				use: [trustSeeded],
			}}
		>
			{children}
		</SWRConfig>
	);
}
