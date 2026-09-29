"use client";

import * as echarts from "echarts/core";
import { knownCountries } from "../../lib/visuals/countryNames";

// The boundaries a choropleth draws on.
//
// Fetched rather than bundled, and only when a map is actually on a page. The
// file is four hundred kilobytes of coordinates, which is larger than the rest
// of the application put together, and the overwhelming majority of pages here
// have no map on them at all.
//
// Registered with ECharts once per browsing session. Registration is global to
// the library, so a second map on the same page reuses this rather than
// fetching again, and the promise is held so two maps mounting together make
// one request between them.

export const worldMapName = "sightline-world";

// The names the loaded boundaries carry, for matching a dimension value
// against. Null until the boundaries have loaded.
let names: Map<string, string> | null = null;
let loading: Promise<Map<string, string>> | null = null;

interface CountryFeature {
	properties?: { name?: unknown };
	geometry?: { coordinates?: unknown };
}

// Each region's extent as west, south, east and north in degrees, so a map
// can centre and zoom on a selected region without searching the boundaries
// again on every draw.
export type RegionBounds = [number, number, number, number];
let bounds: Map<string, RegionBounds> | null = null;

export function worldNames(): Map<string, string> | null {
	return names;
}

export function regionBounds(name: string): RegionBounds | null {
	return bounds?.get(name) ?? null;
}

// The extent of every position in a nest of coordinate arrays, which covers a
// polygon and a set of polygons alike.
function extentOf(coordinates: unknown): RegionBounds | null {
	let box: RegionBounds | null = null;
	const visit = (node: unknown) => {
		if (!Array.isArray(node)) return;
		if (typeof node[0] === "number" && typeof node[1] === "number") {
			const [x, y] = node as number[];
			box = box
				? [
						Math.min(box[0], x),
						Math.min(box[1], y),
						Math.max(box[2], x),
						Math.max(box[3], y),
					]
				: [x, y, x, y];
			return;
		}
		for (const child of node) visit(child);
	};
	visit(coordinates);
	return box;
}

export function ensureWorldMap(): Promise<Map<string, string>> {
	if (names) return Promise.resolve(names);
	if (loading) return loading;

	loading = fetch("/geo/world-countries.json")
		.then((response) => {
			if (!response.ok) {
				throw new Error(`Boundaries returned ${response.status}`);
			}
			return response.json();
		})
		.then((geo: { features?: CountryFeature[] }) => {
			echarts.registerMap(worldMapName, geo as never);
			bounds = new Map();
			for (const feature of geo.features ?? []) {
				const name = feature.properties?.name;
				const box = extentOf(feature.geometry?.coordinates);
				if (typeof name === "string" && box) bounds.set(name, box);
			}
			names = knownCountries(
				(geo.features ?? [])
					.map((feature) => feature.properties?.name)
					.filter((name): name is string => typeof name === "string"),
			);
			return names;
		})
		.catch((error) => {
			// Cleared so a later map tries again rather than being stuck on a
			// failure that may have been one bad response.
			loading = null;
			throw error;
		});

	return loading;
}
