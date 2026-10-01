"use client";

import { SWRConfig } from "swr";
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

// Seeded with what the server already knew.
//
// Every key here is one request the browser does not have to make before it can
// render. SWR treats fallback data as the first value rather than as a cache
// entry, so the component renders with it immediately and revalidates in the
// background if it is configured to.
export default function SWRProvider({
	fallback,
	children,
}: {
	fallback?: Record<string, unknown>;
	children: React.ReactNode;
}) {
	return (
		<SWRConfig value={{ ...swrDefaults, fallback: fallback ?? {} }}>
			{children}
		</SWRConfig>
	);
}
