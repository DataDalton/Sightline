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
}

export function worldNames(): Map<string, string> | null {
	return names;
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
